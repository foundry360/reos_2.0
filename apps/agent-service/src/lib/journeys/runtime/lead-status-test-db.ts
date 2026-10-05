/**
 * Test-only database for the lead status outbox: PGlite (real Postgres in
 * process) with a minimal stand-in for the Supabase schema, the real migrations
 * 055 and 056 applied on top, and a tiny PostgREST bridge so real supabase-js queries
 * (including their request headers and role) run against it the way PostgREST
 * runs them: one transaction per request, request.jwt.claims and request.headers
 * set locally, and the request's role switched in.
 *
 * Supports only what the tests use: PATCH with eq/neq/in/is filters, GET, and RPC.
 */

import { readFileSync } from "node:fs";
import { PGlite, type Transaction } from "@electric-sql/pglite";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const MIGRATIONS = [
  new URL("../../../../../../supabase/migrations/055_lead_status_events.sql", import.meta.url),
  new URL("../../../../../../supabase/migrations/056_journey_runs_one_active_run.sql", import.meta.url),
  new URL("../../../../../../supabase/migrations/057_lead_status_events_max_attempts.sql", import.meta.url),
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
}

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

function identifier(value: string): string {
  if (!IDENTIFIER.test(value)) throw new Error(`Unsupported identifier: ${value}`);
  return value;
}

function parseFilter(column: string, raw: string, params: unknown[]): string {
  const col = identifier(column);
  const dot = raw.indexOf(".");
  const operator = raw.slice(0, dot);
  const value = raw.slice(dot + 1);
  if (operator === "eq" || operator === "neq") {
    params.push(value);
    return `${col} ${operator === "eq" ? "=" : "<>"} $${params.length}`;
  }
  if (operator === "is" && value === "null") return `${col} is null`;
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

function selectList(select: string | null): string {
  if (!select || select === "*") return "*";
  return select.split(",").map((column) => identifier(column.trim())).join(", ");
}

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

function postgrestFetch(pg: PGlite): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
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
          if (name !== "select" && name !== "columns") where.push(parseFilter(name, value, params));
        });
        return where.length ? ` where ${where.join(" and ")}` : "";
      };

      if (request.method === "GET") {
        const sql = `select ${selectList(url.searchParams.get("select"))} from public.${table}${whereSql()}`;
        const result = await inRequest(pg, auth, headers, (tx) => tx.query(sql, params));
        return json(200, result.rows);
      }

      if (request.method === "PATCH") {
        const sets = Object.keys(body).map((column) => {
          params.push(body[column]);
          return `${identifier(column)} = $${params.length}`;
        });
        const returning = wantsRows ? ` returning ${selectList(url.searchParams.get("select"))}` : "";
        const sql = `update public.${table} set ${sets.join(", ")}${whereSql()}${returning}`;
        const result = await inRequest(pg, auth, headers, (tx) => tx.query(sql, params));
        return wantsRows ? json(200, result.rows) : json(204, undefined);
      }

      return json(405, { message: `Unsupported method ${request.method}` });
    } catch (error) {
      return json(400, { message: error instanceof Error ? error.message : String(error) });
    }
  };
}

export async function createTestDb(): Promise<TestDb> {
  const pg = new PGlite();
  await pg.exec(SUPABASE_STAND_IN);
  for (const migration of MIGRATIONS) await pg.exec(readFileSync(migration, "utf8"));
  const fetchImpl = postgrestFetch(pg);

  return {
    pg,
    async reset() {
      await pg.exec("truncate public.lead_status_events, public.journey_runs, public.contacts, public.tenants, public.test_memberships cascade");
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
