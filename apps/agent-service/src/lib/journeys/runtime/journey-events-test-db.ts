/**
 * Test-only database for durable journey events: the lead status test database
 * (PGlite + PostgREST bridge) plus the CRM tables the migration 060 and 061
 * triggers sit on, then the real migrations 060 and 061.
 */

import { readFileSync } from "node:fs";
import { createTestDb, type TestDb } from "./lead-status-test-db.ts";

const MIGRATION_060 = new URL("../../../../../../supabase/migrations/060_journey_events.sql", import.meta.url);
const MIGRATION_061 = new URL("../../../../../../supabase/migrations/061_journey_lifecycle_events.sql", import.meta.url);
const MIGRATION_062 = new URL("../../../../../../supabase/migrations/062_appointment_status.sql", import.meta.url);
const MIGRATION_064 = new URL("../../../../../../supabase/migrations/064_outbound_message_truth.sql", import.meta.url);
const MIGRATION_065 = new URL("../../../../../../supabase/migrations/065_appointment_email_truth.sql", import.meta.url);
const MIGRATION_066 = new URL("../../../../../../supabase/migrations/066_email_delivery_reconciliation.sql", import.meta.url);
const MIGRATION_067 = new URL("../../../../../../supabase/migrations/067_email_sent_activity.sql", import.meta.url);

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

-- Migration 039's shape (status check included) that migration 065 changes.
create table public.crm_emails (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  user_id uuid,
  contact_id uuid references public.contacts (id) on delete set null,
  opportunity_id uuid,
  provider text not null,
  provider_message_id text,
  thread_id text,
  direction text not null check (direction in ('outbound', 'inbound')),
  from_email text not null,
  from_name text,
  to_recipients jsonb not null default '[]'::jsonb,
  cc_recipients jsonb not null default '[]'::jsonb,
  subject text not null,
  body_html text,
  body_text text,
  snippet text,
  status text not null default 'sent'
    check (status in ('draft', 'queued', 'sent', 'failed', 'received')),
  sent_at timestamptz,
  received_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (tenant_id, provider, provider_message_id)
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

/** `extraSchema`: more stand-in columns or tables a test's code path needs, applied before migrations 060–067. */
export async function createJourneyEventsTestDb(extraSchema = ""): Promise<TestDb> {
  return createTestDb({
    schema: [
      JOURNEY_EVENTS_STAND_IN,
      extraSchema,
      LIFECYCLE_EVENTS_STAND_IN,
      readFileSync(MIGRATION_060, "utf8"),
      readFileSync(MIGRATION_061, "utf8"),
      readFileSync(MIGRATION_062, "utf8"),
      readFileSync(MIGRATION_064, "utf8"),
      readFileSync(MIGRATION_065, "utf8"),
      readFileSync(MIGRATION_066, "utf8"),
      readFileSync(MIGRATION_067, "utf8"),
    ].join("\n"),
  });
}
