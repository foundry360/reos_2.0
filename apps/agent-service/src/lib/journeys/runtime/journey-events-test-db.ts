/**
 * Test-only database for durable journey events: the lead status test database
 * (PGlite + PostgREST bridge) plus the CRM tables the migration 060 and 061
 * triggers sit on, then the real migrations 060 and 061.
 */

import { readFileSync } from "node:fs";
import { createTestDb, type TestDb } from "./lead-status-test-db.ts";

const MIGRATION_060 = new URL("../../../../../../supabase/migrations/060_journey_events.sql", import.meta.url);
const MIGRATION_061 = new URL("../../../../../../supabase/migrations/061_journey_lifecycle_events.sql", import.meta.url);

/** Production shapes of the columns the triggers and producers use. */
export const JOURNEY_EVENTS_STAND_IN = `
create table public.contact_identities (
  id uuid primary key default gen_random_uuid(),
  contact_id uuid not null references public.contacts (id) on delete cascade,
  channel text not null
    check (channel in ('sms', 'messenger', 'instagram', 'facebook_comment', 'instagram_comment')),
  external_id text not null,
  unique (channel, external_id)
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

create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  contact_id uuid references public.contacts (id) on delete cascade,
  title text not null,
  status text not null default 'open' check (status in ('open', 'done')),
  created_at timestamptz not null default now()
);

create table public.contact_activities (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  contact_id uuid not null references public.contacts (id) on delete cascade,
  activity_type text not null,
  title text not null,
  body text,
  occurred_at timestamptz not null default now(),
  ends_at timestamptz,
  source text,
  related_entity_type text,
  related_entity_id uuid
);
`;

/**
 * The columns the 061 triggers read, added after a test's own schema (which may
 * already define some of them): contacts.assigned_agent_id / handoff (045, 033),
 * opportunities with pipeline and stage (019, 025), contact_activities.metadata (046).
 */
export const LIFECYCLE_EVENTS_STAND_IN = `
alter table public.contacts
  add column if not exists assigned_agent_id uuid,
  add column if not exists handoff boolean not null default false;

create table if not exists public.opportunities (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  contact_id uuid references public.contacts (id) on delete set null
);

alter table public.opportunities
  add column if not exists name text not null default 'Consult',
  add column if not exists pipeline text not null default 'Intake',
  add column if not exists stage text not null default 'New',
  add column if not exists assigned_agent_id uuid,
  add column if not exists created_at timestamptz not null default now();

alter table public.contact_activities
  add column if not exists metadata jsonb;
`;

/** `extraSchema`: more stand-in columns or tables a test's code path needs, applied before migrations 060 and 061. */
export async function createJourneyEventsTestDb(extraSchema = ""): Promise<TestDb> {
  return createTestDb({
    schema: [
      JOURNEY_EVENTS_STAND_IN,
      extraSchema,
      LIFECYCLE_EVENTS_STAND_IN,
      readFileSync(MIGRATION_060, "utf8"),
      readFileSync(MIGRATION_061, "utf8"),
    ].join("\n"),
  });
}
