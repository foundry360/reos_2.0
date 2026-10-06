/**
 * Test-only database for the lead status outbox: PGlite (real Postgres in
 * process) with a minimal stand-in for the Supabase schema, the real migrations
 * 055, 056, 057 and 063 applied on top, and a tiny PostgREST bridge so real supabase-js queries
 * (including their request headers and role) run against it the way PostgREST
 * runs them: one transaction per request, request.jwt.claims and request.headers
 * set locally, and the request's role switched in.
 *
 * Supports only what the tests use: GET, HEAD (exact count), POST (insert), PATCH, and DELETE
 * (with an exact count) with eq/neq/in/cs/is/not.is.null filters, order and limit, single-object responses,
 * RPC, and the auth admin "get user" endpoint backed by `authUsers`.
 */

import { readFileSync } from "node:fs";
import { PGlite, type Transaction } from "@electric-sql/pglite";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const MIGRATIONS = [
  new URL("../../../../../../supabase/migrations/055_lead_status_events.sql", import.meta.url),
  new URL("../../../../../../supabase/migrations/056_journey_runs_one_active_run.sql", import.meta.url),
  new URL("../../../../../../supabase/migrations/057_lead_status_events_max_attempts.sql", import.meta.url),
  new URL("../../../../../../supabase/migrations/063_journey_runs_appointment_scope.sql", import.meta.url),
];

const SUPABASE_STAND_IN = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant select, insert, update, delete on tables to authenticated, service_role;

create table public.tenants (id uuid primary key default gen_random_uuid());

create table public.contacts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  record_type text not null default 'lead' check (record_type in ('lead', 'contact')),
  lead_status text not null default 'New'
    check (lead_status in ('New', 'Working', 'Contacted', 'Qualified', 'Converted')),
  contact_type text,
  first_name text,
  last_name text,
  email text,
  intent text,
  ready_to_book boolean not null default false,
  appt_booked boolean not null default false
);

create table public.journey_runs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  journey_id uuid not null,
  trigger_event text not null default 'manual',
  trigger_payload jsonb not null default '{}'::jsonb,
  journey_version integer,
  contact_id uuid references public.contacts (id) on delete set null,
  status text not null default 'running'
    check (status in ('running', 'waiting', 'completed', 'failed', 'cancelled', 'paused')),
  idempotency_key text,
  -- Defaulted here only so tests can insert bare runs; required in production.
  entity_type text not null default 'contact',
  entity_id uuid,
  -- Same uniqueness as migration 054; nullable here so tests can insert bare origin runs.
  unique (tenant_id, idempotency_key)
);

create table public.test_memberships (user_id uuid not null, tenant_id uuid not null);
grant select on public.test_memberships to authenticated;

create function public.is_platform_admin() returns boolean language sql stable as $$ select false $$;
create function public.user_tenant_ids() returns setof uuid language sql stable as $$
  select tenant_id from public.test_memberships
   where user_id::text = nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
$$;
`;

export type RequestRole = "service_role" | "authenticated" | "anon";

export interface TestDb {
  pg: PGlite;
  /** Clears every row between tests. */
  reset(): Promise<void>;
  /** A supabase-js client whose requests run against PGlite as `role` (and `userId` for authenticated). */
  client(role: RequestRole, userId?: string): SupabaseClient;
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  /** The bridge itself, for clients that use the global fetch (route http://postgrest.test requests here). */
  fetch: typeof fetch;
  /** Users the auth admin "get user" endpoint returns, by id. Cleared by reset(). */
  authUsers: Map<string, { email: string }>;
}

export interface TestDbOptions {
  /** Extra test-only schema, applied after the stand-in and migrations. */
  schema?: string;
  /**
   * Serve gt/gte/lt/lte filters. Off by default: some suites rely on range
   * lookups failing (to reach code behind an availability check).
   */
  rangeFilters?: boolean;
}

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

function identifier(value: string): string {
  if (!IDENTIFIER.test(value)) throw new Error(`Unsupported identifier: ${value}`);
  return value;
}

const JSON_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A column, or a PostgREST JSON path on one (col->key->>key). Keys are validated, never interpolated raw. */
function columnExpr(value: string): string {
  const parts = value.split(/(->>|->)/);
  let sql = identifier(parts[0]);
  for (let i = 1; i < parts.length; i += 2) {
    const key = parts[i + 1] ?? "";
    if (!JSON_KEY.test(key)) throw new Error(`Unsupported JSON key: ${key}`);
    sql += `${parts[i]}'${key}'`;
  }
  return sql;
}

const RANGE_OPERATORS: Record<string, string> = { gt: ">", gte: ">=", lt: "<", lte: "<=" };

function parseFilter(column: string, raw: string, params: unknown[], rangeFilters = false): string {
  const col = columnExpr(column);
  const dot = raw.indexOf(".");
  const operator = raw.slice(0, dot);
  const value = raw.slice(dot + 1);
  if (operator === "eq" || operator === "neq") {
    params.push(value);
    return `${col} ${operator === "eq" ? "=" : "<>"} $${params.length}`;
  }
  if (operator === "ilike") {
    params.push(value);
    return `${col} ilike $${params.length}`;
  }
  if (operator === "cs") {
    // Array contains; the value is a Postgres array literal such as {manual}.
    params.push(value);
    return `${col} @> $${params.length}`;
  }
  const comparison = rangeFilters ? RANGE_OPERATORS[operator] : undefined;
  if (comparison) {
    params.push(value);
    return `${col} ${comparison} $${params.length}`;
  }
  if (operator === "is" && value === "null") return `${col} is null`;
  if (operator === "not" && value === "is.null") return `${col} is not null`;
  if (operator === "in") {
    const items = value.replace(/^\(|\)$/g, "").split(",").map((item) => item.replace(/^"|"$/g, ""));
    const placeholders = items.map((item) => {
      params.push(item);
      return `$${params.length}`;
    });
    return `${col} in (${placeholders.join(", ")})`;
  }
  throw new Error(`Unsupported filter: ${column}=${raw}`);
}

/** or=(col.op.value,col.op.value): one level, no nested groups, no commas inside values. */
function parseOrFilter(raw: string, params: unknown[]): string {
  if (!raw.startsWith("(") || !raw.endsWith(")")) throw new Error(`Unsupported or filter: ${raw}`);
  const terms = raw.slice(1, -1).split(",").map((term) => {
    const dot = term.indexOf(".");
    if (dot <= 0) throw new Error(`Unsupported or filter: ${raw}`);
    return parseFilter(term.slice(0, dot), term.slice(dot + 1), params);
  });
  return `(${terms.join(" or ")})`;
}

function selectList(select: string | null): string {
  if (!select || select === "*") return "*";
  return select
    .split(",")
    .map((entry) => {
      const [alias, column] = entry.includes(":") ? entry.trim().split(":") : [null, entry.trim()];
      return alias ? `${columnExpr(column)} as ${identifier(alias)}` : identifier(column);
    })
    .join(", ");
}

/** order=col.asc|desc[.nullsfirst|.nullslast], comma-separated. */
function orderBy(raw: string | null): string {
  if (!raw) return "";
  const terms = raw.split(",").map((term) => {
    const [column, direction, nulls] = term.split(".");
    const dir = direction === "desc" ? " desc" : " asc";
    const nullsSql = nulls === "nullsfirst" ? " nulls first" : nulls === "nullslast" ? " nulls last" : "";
    return `${identifier(column)}${dir}${nullsSql}`;
  });
  return ` order by ${terms.join(", ")}`;
}

function limitSql(raw: string | null): string {
  if (raw === null) return "";
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < 0) throw new Error(`Unsupported limit: ${raw}`);
  return ` limit ${limit}`;
}

/** jsonb columns take objects and arrays as JSON text. */
function insertValue(value: unknown): unknown {
  return value !== null && typeof value === "object" ? JSON.stringify(value) : value;
}

const NOT_FILTERS = new Set(["select", "columns", "order", "limit"]);

function authFromKey(key: string): { role: RequestRole; sub?: string } {
  const [role, sub] = key.split(":");
  if (role !== "service_role" && role !== "authenticated" && role !== "anon") throw new Error("Unknown test key");
  return { role, sub };
}

async function inRequest<T>(
  pg: PGlite,
  auth: { role: RequestRole; sub?: string },
  headers: Record<string, string>,
  work: (tx: Transaction) => Promise<T>,
): Promise<T> {
  return pg.transaction(async (tx) => {
    await tx.query("select set_config('request.jwt.claims', $1, true), set_config('request.headers', $2, true)", [
      JSON.stringify({ role: auth.role, ...(auth.sub ? { sub: auth.sub } : {}) }),
      JSON.stringify(headers),
    ]);
    await tx.exec(`set local role ${identifier(auth.role)}`);
    return work(tx);
  });
}

function json(status: number, body: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Rows as PostgREST returns them: an array, or one object when the client asked for one. */
function rowsResponse(request: Request, rows: unknown[], status = 200): Response {
  if (!(request.headers.get("accept") ?? "").startsWith("application/vnd.pgrst.object+json")) return json(status, rows);
  if (rows.length === 1) return json(status, rows[0]);
  return json(406, {
    code: "PGRST116",
    details: `The result contains ${rows.length} rows`,
    hint: null,
    message: "JSON object requested, multiple (or no) rows returned",
  });
}

function postgrestFetch(pg: PGlite, authUsers: Map<string, { email: string }>, rangeFilters: boolean): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);

    const authUser = /^\/auth\/v1\/admin\/users\/([^/]+)$/.exec(url.pathname);
    if (authUser && request.method === "GET") {
      const user = authUsers.get(decodeURIComponent(authUser[1]));
      return user
        ? json(200, { id: authUser[1], aud: "authenticated", role: "authenticated", email: user.email })
        : json(404, { code: 404, error_code: "user_not_found", msg: "User not found" });
    }
    if (!url.pathname.startsWith("/rest/v1/")) return json(404, { message: `Unsupported path ${url.pathname}` });

    const auth = authFromKey(request.headers.get("apikey") ?? "");
    const headers: Record<string, string> = {};
    request.headers.forEach((value, name) => {
      if (name !== "apikey" && name !== "authorization") headers[name] = value;
    });
    const path = url.pathname.replace(/^\/rest\/v1\//, "");
    const bodyText = request.method === "GET" ? "" : await request.text();
    const body = bodyText ? JSON.parse(bodyText) : {};
    const wantsRows = (request.headers.get("prefer") ?? "").includes("return=representation");

    try {
      if (path.startsWith("rpc/")) {
        const fn = identifier(path.slice(4));
        const keys = Object.keys(body).map(identifier);
        const params = keys.map((key) => body[key]);
        const args = keys.map((key, index) => `${key} => $${index + 1}`).join(", ");
        const result = await inRequest(pg, auth, headers, (tx) => tx.query(`select * from public.${fn}(${args})`, params));
        const scalar = result.fields.length === 1 && result.fields[0].name === fn;
        return json(200, scalar ? (result.rows[0] as Record<string, unknown>)[fn] : result.rows);
      }

      const table = identifier(path);
      const params: unknown[] = [];
      const whereSql = () => {
        const where: string[] = [];
        url.searchParams.forEach((value, name) => {
          if (name === "or") where.push(parseOrFilter(value, params));
          else if (!NOT_FILTERS.has(name)) where.push(parseFilter(name, value, params, rangeFilters));
        });
        return where.length ? ` where ${where.join(" and ")}` : "";
      };

      if (request.method === "GET") {
        const sql =
          `select ${selectList(url.searchParams.get("select"))} from public.${table}${whereSql()}` +
          `${orderBy(url.searchParams.get("order"))}${limitSql(url.searchParams.get("limit"))}`;
        const result = await inRequest(pg, auth, headers, (tx) => tx.query(sql, params));
        return rowsResponse(request, result.rows);
      }

      // select(..., { count: "exact", head: true }): only the count, in content-range.
      if (request.method === "HEAD") {
        const sql = `select count(*)::int as count from public.${table}${whereSql()}`;
        const result = await inRequest(pg, auth, headers, (tx) => tx.query<{ count: number }>(sql, params));
        return new Response(null, { status: 200, headers: { "content-range": `*/${result.rows[0].count}` } });
      }

      if (request.method === "POST") {
        const rows = (Array.isArray(body) ? body : [body]) as Array<Record<string, unknown>>;
        const returning = wantsRows ? ` returning ${selectList(url.searchParams.get("select"))}` : "";
        const inserted = await inRequest(pg, auth, headers, async (tx) => {
          const out: unknown[] = [];
          for (const row of rows) {
            const columns = Object.keys(row).map(identifier);
            const values = columns.map((column) => insertValue(row[column]));
            const sql = columns.length
              ? `insert into public.${table} (${columns.join(", ")}) values (${columns.map((_, index) => `$${index + 1}`).join(", ")})${returning}`
              : `insert into public.${table} default values${returning}`;
            out.push(...(await tx.query(sql, values)).rows);
          }
          return out;
        });
        return wantsRows ? rowsResponse(request, inserted, 201) : json(201, undefined);
      }

      if (request.method === "PATCH") {
        const sets = Object.keys(body).map((column) => {
          params.push(body[column]);
          return `${identifier(column)} = $${params.length}`;
        });
        const returning = wantsRows ? ` returning ${selectList(url.searchParams.get("select"))}` : "";
        const sql = `update public.${table} set ${sets.join(", ")}${whereSql()}${returning}`;
        const result = await inRequest(pg, auth, headers, (tx) => tx.query(sql, params));
        return wantsRows ? rowsResponse(request, result.rows) : json(204, undefined);
      }

      if (request.method === "DELETE") {
        const returning = wantsRows ? ` returning ${selectList(url.searchParams.get("select"))}` : "";
        const sql = `delete from public.${table}${whereSql()}${returning}`;
        const result = await inRequest(pg, auth, headers, (tx) => tx.query(sql, params));
        if (wantsRows) return rowsResponse(request, result.rows);
        const counted = (request.headers.get("prefer") ?? "").includes("count=exact");
        return new Response(null, {
          status: 204,
          headers: counted ? { "content-range": `*/${result.affectedRows ?? 0}` } : {},
        });
      }

      return json(405, { message: `Unsupported method ${request.method}` });
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : undefined;
      return json(400, { message: error instanceof Error ? error.message : String(error), ...(code ? { code } : {}) });
    }
  };
}

export async function createTestDb(options: TestDbOptions = {}): Promise<TestDb> {
  const pg = new PGlite();
  await pg.exec(SUPABASE_STAND_IN);
  for (const migration of MIGRATIONS) await pg.exec(readFileSync(migration, "utf8"));
  if (options.schema) await pg.exec(options.schema);
  const authUsers = new Map<string, { email: string }>();
  const fetchImpl = postgrestFetch(pg, authUsers, options.rangeFilters ?? false);
  const tables = (
    await pg.query<{ name: string }>("select format('public.%I', tablename) as name from pg_tables where schemaname = 'public'")
  ).rows.map((row) => row.name);

  return {
    pg,
    fetch: fetchImpl,
    authUsers,
    async reset() {
      authUsers.clear();
      await pg.exec(`truncate ${tables.join(", ")} cascade`);
    },
    client(role, userId) {
      const key = userId ? `${role}:${userId}` : role;
      return createClient("http://postgrest.test", key, {
        auth: { persistSession: false, autoRefreshToken: false },
        global: { fetch: fetchImpl },
      });
    },
    async query<T>(sql: string, params: unknown[] = []) {
      return (await pg.query(sql, params)).rows as T[];
    },
  };
}
