/**
 * Test-only environment for running the real Journey action executor
 * (live-actions.ts) under node --test. Importing this module, before any
 * production module that reads configuration or creates a client:
 *
 * 1. Overwrites every Supabase / provider setting with fake values, so
 *    getSupabaseAdmin() and the platform-secret env fallbacks point at the
 *    PGlite bridge and fake keys no matter what the shell exported.
 * 2. Replaces globalThis.fetch with a fail-closed router: the PGlite bridge,
 *    and recorded fakes for Telnyx, Resend, and Meta. Every other request is
 *    recorded as blocked and throws.
 * 3. Makes node:http, node:https, node:net, and node:tls refuse connections,
 *    so clients that bypass fetch (the OpenAI SDK uses node-fetch) can't reach
 *    the network either.
 * 4. Registers a resolver for the app's `@/` alias, extensionless relative
 *    imports, and `next/*` subpaths, scoped to files under src/.
 *
 * Not a *.test.ts file, so the test glob never runs it on its own.
 */

import { existsSync } from "node:fs";
import { createRequire, registerHooks, syncBuiltinESMExports } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { TestDb } from "./lead-status-test-db.ts";

export const TEST_SUPABASE_URL = "http://postgrest.test";
export const TEST_KEYS = {
  telnyx: "test-telnyx-key",
  resend: "test-resend-key",
  openai: "test-openai-key-never-used",
} as const;
export const TEST_FROM_EMAIL = "journeys@reos.test";

// ---------- 1. Environment ----------

const CONFIG_PREFIXES = [
  "NEXT_PUBLIC_SUPABASE",
  "SUPABASE",
  "TELNYX",
  "RESEND",
  "OPENAI",
  "META",
  "STRIPE",
  "PLATFORM_SECRETS",
  "GOOGLE",
  "JAAS",
  "JITSI",
  "GHL",
  "CRON",
  "MEETING",
];
for (const name of Object.keys(process.env)) {
  if (CONFIG_PREFIXES.some((prefix) => name.startsWith(prefix))) delete process.env[name];
}
Object.assign(process.env, {
  NEXT_PUBLIC_SUPABASE_URL: TEST_SUPABASE_URL,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon",
  // The bridge reads the role from the key.
  SUPABASE_SERVICE_ROLE_KEY: "service_role",
  TELNYX_API_KEY: TEST_KEYS.telnyx,
  RESEND_API_KEY: TEST_KEYS.resend,
  RESEND_FROM_EMAIL: TEST_FROM_EMAIL,
  RESEND_FROM_NAME: "REOS Test",
  OPENAI_API_KEY: TEST_KEYS.openai,
});

// ---------- 2. Network guard ----------

/** Every request the guard refused. Tests assert this stays empty. */
export const blockedRequests: string[] = [];

function block(description: string): never {
  blockedRequests.push(description);
  throw new Error(`Blocked network request in an integration test: ${description}`);
}

const require = createRequire(import.meta.url);
for (const [moduleName, functions] of [
  ["node:http", ["request", "get"]],
  ["node:https", ["request", "get"]],
  ["node:net", ["connect", "createConnection"]],
  ["node:tls", ["connect"]],
] as const) {
  const exports = require(moduleName) as Record<string, unknown>;
  for (const name of functions) {
    exports[name] = () => block(`${moduleName}.${name}`);
  }
}
syncBuiltinESMExports();

// ---------- 3. Provider fakes ----------

interface ScriptedResponse {
  status: number;
  body: unknown;
}

class FakeProvider<Call> {
  calls: Call[] = [];
  private queue: ScriptedResponse[] = [];

  /** The next request gets this response instead of the default success. */
  respondNext(status: number, body: unknown) {
    this.queue.push({ status, body });
  }

  reply(call: Call, success: (count: number) => unknown): Response {
    this.calls.push(call);
    const scripted = this.queue.shift();
    return jsonResponse(scripted?.status ?? 200, scripted ? scripted.body : success(this.calls.length));
  }

  reset() {
    this.calls = [];
    this.queue = [];
  }
}

export interface TelnyxCall {
  apiKey: string | null;
  from: string;
  to: string;
  text: string;
  body: Record<string, unknown>;
}

export interface ResendCall {
  apiKey: string | null;
  from: string;
  to: string[];
  replyTo: string;
  subject: string;
  html: string;
}

export interface MetaCall {
  accessToken: string | null;
  recipientId: string;
  text: string;
  messagingType: string | undefined;
}

export const providers = {
  telnyx: new FakeProvider<TelnyxCall>(),
  resend: new FakeProvider<ResendCall>(),
  meta: new FakeProvider<MetaCall>(),
  reset() {
    this.telnyx.reset();
    this.resend.reset();
    this.meta.reset();
  },
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function bearer(request: Request): string | null {
  return request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? null;
}

let bridge: TestDb["fetch"] | null = null;

/** Routes http://postgrest.test (REST and auth admin) to this database's bridge. */
export function attachTestDb(db: TestDb) {
  bridge = db.fetch;
}

globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  // Never record the query string: it can carry tokens.
  const description = `${request.method} ${url.origin}${url.pathname}`;

  if (url.origin === TEST_SUPABASE_URL) {
    if (!bridge) block(`${description} (no test database attached)`);
    return bridge(request);
  }

  if (url.origin === "https://api.telnyx.com" && url.pathname === "/v2/messages" && request.method === "POST") {
    const body = (await request.json()) as Record<string, unknown>;
    return providers.telnyx.reply(
      { apiKey: bearer(request), from: String(body.from), to: String(body.to), text: String(body.text), body },
      (count) => ({ data: { id: `telnyx-msg-${count}` } }),
    );
  }

  if (url.origin === "https://api.resend.com" && url.pathname === "/emails" && request.method === "POST") {
    const body = (await request.json()) as { from: string; to: string[]; reply_to: string; subject: string; html: string };
    return providers.resend.reply(
      { apiKey: bearer(request), from: body.from, to: body.to, replyTo: body.reply_to, subject: body.subject, html: body.html },
      (count) => ({ id: `resend-email-${count}` }),
    );
  }

  if (url.origin === "https://graph.facebook.com" && /^\/v\d+\.\d+\/me\/messages$/.test(url.pathname) && request.method === "POST") {
    const body = (await request.json()) as { recipient?: { id?: string }; message?: { text?: string }; messaging_type?: string };
    return providers.meta.reply(
      {
        accessToken: url.searchParams.get("access_token"),
        recipientId: String(body.recipient?.id),
        text: String(body.message?.text),
        messagingType: body.messaging_type,
      },
      (count) => ({ recipient_id: body.recipient?.id, message_id: `m_meta_${count}` }),
    );
  }

  return block(description);
};

// ---------- 4. Module resolution ----------

const SRC_DIR = fileURLToPath(new URL("../../../", import.meta.url));
const HAS_EXTENSION = /\.[cm]?[jt]sx?$/;

function resolveSourceFile(base: string): string | null {
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`]) {
    if (HAS_EXTENSION.test(candidate) && existsSync(candidate)) return candidate;
  }
  return null;
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    const parent = context.parentURL?.startsWith("file:") ? fileURLToPath(context.parentURL) : null;
    if (!parent?.startsWith(SRC_DIR)) return nextResolve(specifier, context);

    if (/^next\/[a-z-]+$/.test(specifier)) return nextResolve(`${specifier}.js`, context);

    let base: string | null = null;
    if (specifier.startsWith("@/")) base = SRC_DIR + specifier.slice(2);
    else if ((specifier.startsWith("./") || specifier.startsWith("../")) && !HAS_EXTENSION.test(specifier)) {
      base = fileURLToPath(new URL(specifier, context.parentURL));
    }
    const file = base ? resolveSourceFile(base) : null;
    return nextResolve(file ? pathToFileURL(file).href : specifier, context);
  },
});

// ---------- Test schema ----------

/**
 * The tables and columns the real action executors read and write, beyond the
 * lead-status stand-in. Shapes follow the production columns those code paths use.
 */
export const LIVE_ACTIONS_SCHEMA = `
alter table public.contacts
  add column opted_out boolean not null default false,
  add column assigned_agent_id uuid;

create table public.contact_identities (
  id uuid primary key default gen_random_uuid(),
  contact_id uuid not null references public.contacts (id) on delete cascade,
  channel text not null
    check (channel in ('sms', 'messenger', 'instagram', 'facebook_comment', 'instagram_comment')),
  external_id text not null,
  unique (channel, external_id)
);

create table public.tenant_phone_numbers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  phone_e164 text not null,
  is_primary boolean not null default false
);

create table public.channel_accounts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  channel text not null check (channel in ('messenger', 'instagram')),
  external_page_id text,
  external_account_id text,
  status text not null default 'disconnected' check (status in ('disconnected', 'connected', 'error')),
  metadata jsonb not null default '{}'::jsonb,
  unique (tenant_id, channel)
);

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  contact_id uuid not null references public.contacts (id) on delete cascade,
  channel text not null default 'sms',
  direction text not null check (direction in ('inbound', 'outbound')),
  body text not null,
  playbook text,
  context_label text,
  created_at timestamptz not null default now()
);

create table public.platform_secrets (
  key text primary key,
  ciphertext text not null,
  iv text not null,
  auth_tag text not null,
  hint text,
  updated_at timestamptz not null default now()
);

create table public.opportunities (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  contact_id uuid references public.contacts (id) on delete cascade,
  assigned_agent_id uuid,
  created_at timestamptz not null default now()
);

create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  contact_id uuid references public.contacts (id) on delete cascade,
  opportunity_id uuid references public.opportunities (id) on delete set null,
  title text not null,
  notes text,
  status text not null default 'open',
  due_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.memberships (
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  user_id uuid not null,
  role text not null default 'member',
  created_at timestamptz not null default now(),
  primary key (tenant_id, user_id)
);

create table public.contact_activities (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  contact_id uuid not null references public.contacts (id) on delete cascade,
  activity_type text not null,
  title text not null,
  body text,
  occurred_at timestamptz not null default now(),
  related_entity_type text,
  related_entity_id uuid
);

create table public.profiles (
  id uuid primary key,
  display_name text,
  reply_to_email text
);

create table public.crm_emails (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  user_id uuid,
  contact_id uuid references public.contacts (id) on delete set null,
  opportunity_id uuid references public.opportunities (id) on delete set null,
  provider text not null,
  provider_message_id text,
  thread_id text,
  direction text not null,
  from_email text,
  from_name text,
  to_recipients jsonb not null default '[]'::jsonb,
  cc_recipients jsonb not null default '[]'::jsonb,
  subject text,
  body_html text,
  body_text text,
  snippet text,
  status text,
  sent_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  unique (tenant_id, provider, provider_message_id)
);

create table public.user_notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  category text not null,
  title text not null,
  body text,
  href text,
  created_at timestamptz not null default now()
);

create table public.notification_preferences (
  user_id uuid primary key,
  tasks_in_app boolean not null default true,
  leads_in_app boolean not null default true,
  opportunities_in_app boolean not null default true,
  messages_in_app boolean not null default true,
  system_in_app boolean not null default true
);
`;
