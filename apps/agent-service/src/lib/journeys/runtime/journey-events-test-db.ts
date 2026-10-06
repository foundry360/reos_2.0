/**
 * Test-only database for durable journey events: the lead status test database
 * (PGlite + PostgREST bridge) plus the CRM tables the migration 060 triggers
 * sit on, then the real migration 060.
 */

import { readFileSync } from "node:fs";
import { createTestDb, type TestDb } from "./lead-status-test-db.ts";

const MIGRATION_060 = new URL("../../../../../../supabase/migrations/060_journey_events.sql", import.meta.url);

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

/** `extraSchema`: more stand-in columns or tables a test's code path needs, applied before migration 060. */
export async function createJourneyEventsTestDb(extraSchema = ""): Promise<TestDb> {
  return createTestDb({ schema: `${JOURNEY_EVENTS_STAND_IN}\n${extraSchema}\n${readFileSync(MIGRATION_060, "utf8")}` });
}
