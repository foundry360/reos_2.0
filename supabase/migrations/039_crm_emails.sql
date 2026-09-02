-- CRM email records (provider-independent; inbound sync ready)
-- Email Intelligence: requires_response column + metadata.intelligence JSON
-- (intent, sentiment, urgency, suggested_response, detected_task, etc.)

create table if not exists public.crm_emails (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  user_id uuid references auth.users (id) on delete set null,
  contact_id uuid references public.contacts (id) on delete set null,
  opportunity_id uuid references public.opportunities (id) on delete set null,
  provider text not null check (provider in ('gmail', 'outlook')),
  provider_message_id text,
  thread_id text,
  direction text not null check (direction in ('outbound', 'inbound')),
  from_email text not null,
  from_name text,
  to_recipients jsonb not null default '[]'::jsonb,
  cc_recipients jsonb not null default '[]'::jsonb,
  bcc_recipients jsonb not null default '[]'::jsonb,
  subject text not null,
  body_html text,
  body_text text,
  snippet text,
  status text not null default 'sent'
    check (status in ('draft', 'queued', 'sent', 'failed', 'received')),
  sent_at timestamptz,
  received_at timestamptz,
  has_attachments boolean not null default false,
  requires_response boolean,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists crm_emails_contact_idx
  on public.crm_emails (contact_id, sent_at desc nulls last, created_at desc);

create index if not exists crm_emails_tenant_idx
  on public.crm_emails (tenant_id, created_at desc);

create index if not exists crm_emails_thread_idx
  on public.crm_emails (tenant_id, thread_id)
  where thread_id is not null;

create trigger crm_emails_updated_at
  before update on public.crm_emails
  for each row execute function public.set_updated_at();

alter table public.crm_emails enable row level security;

create policy crm_emails_tenant_access on public.crm_emails
  for all using (
    public.is_platform_admin() or tenant_id in (select public.user_tenant_ids())
  );

alter table public.profiles
  add column if not exists email_signature text;
