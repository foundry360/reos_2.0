-- REOS 2.0 initial schema
-- Run in Supabase SQL Editor or via supabase db push

-- Extensions
create extension if not exists "pgcrypto";

-- Tenants (brokerages)
create table public.tenants (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  timezone text not null default 'America/New_York',
  status text not null default 'pending'
    check (status in ('pending', 'active', 'paused')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Platform admins (Foundry ops)
create table public.platform_admins (
  user_id uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

-- Tenant membership
create table public.memberships (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null check (role in ('owner', 'agent', 'viewer')),
  created_at timestamptz not null default now(),
  unique (tenant_id, user_id)
);

-- Twilio numbers assigned per tenant
create table public.tenant_phone_numbers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  phone_e164 text not null unique,
  label text,
  is_primary boolean not null default true,
  created_at timestamptz not null default now()
);

create index tenant_phone_numbers_tenant_idx on public.tenant_phone_numbers (tenant_id);

-- Per-tenant agent configuration
create table public.tenant_agents (
  tenant_id uuid primary key references public.tenants (id) on delete cascade,
  concierge_enabled boolean not null default true,
  scheduler_enabled boolean not null default true,
  follow_up_enabled boolean not null default true,
  intake_enabled boolean not null default true,
  researcher_enabled boolean not null default false,
  scout_enabled boolean not null default false,
  compliance_strict boolean not null default true,
  quiet_hours_start time,
  quiet_hours_end time,
  prompt_overrides jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- CRM contacts
create table public.contacts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  first_name text,
  last_name text,
  lead_status text not null default 'Qualifying'
    check (lead_status in (
      'Qualifying', 'Ready_to_Book', 'Nurture', 'Booked', 'Handoff', 'Compliance'
    )),
  ai_summary text,
  qualification_score smallint check (qualification_score >= 0 and qualification_score <= 100),
  lead_temperature text check (lead_temperature in ('Hot', 'Warm', 'Cold')),
  opted_out boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index contacts_tenant_idx on public.contacts (tenant_id);
create index contacts_lead_status_idx on public.contacts (tenant_id, lead_status);

-- Channel identities (phone, IG PSID, etc.)
create table public.contact_identities (
  id uuid primary key default gen_random_uuid(),
  contact_id uuid not null references public.contacts (id) on delete cascade,
  channel text not null check (channel in ('sms', 'messenger', 'instagram')),
  external_id text not null,
  created_at timestamptz not null default now(),
  unique (channel, external_id)
);

create index contact_identities_contact_idx on public.contact_identities (contact_id);

-- Message history (agent threads + inbox UI)
create table public.messages (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  contact_id uuid not null references public.contacts (id) on delete cascade,
  channel text not null default 'sms',
  direction text not null check (direction in ('inbound', 'outbound')),
  body text not null,
  playbook text,
  created_at timestamptz not null default now()
);

create index messages_contact_idx on public.messages (contact_id, created_at desc);

-- Meta / channel connections (future)
create table public.channel_accounts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  channel text not null check (channel in ('messenger', 'instagram')),
  external_page_id text,
  external_account_id text,
  status text not null default 'disconnected'
    check (status in ('disconnected', 'connected', 'error')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, channel)
);

-- updated_at trigger
create or replace function public.set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger tenants_updated_at
  before update on public.tenants
  for each row execute function public.set_updated_at();

create trigger contacts_updated_at
  before update on public.contacts
  for each row execute function public.set_updated_at();

-- Auto-create tenant_agents on new tenant
create or replace function public.create_tenant_agents()
returns trigger as $$
begin
  insert into public.tenant_agents (tenant_id) values (new.id);
  return new;
end;
$$ language plpgsql;

create trigger tenants_create_agents
  after insert on public.tenants
  for each row execute function public.create_tenant_agents();

-- RLS
alter table public.tenants enable row level security;
alter table public.memberships enable row level security;
alter table public.platform_admins enable row level security;
alter table public.contacts enable row level security;
alter table public.contact_identities enable row level security;
alter table public.messages enable row level security;
alter table public.tenant_phone_numbers enable row level security;
alter table public.tenant_agents enable row level security;
alter table public.channel_accounts enable row level security;

-- Platform admin helper
create or replace function public.is_platform_admin()
returns boolean as $$
  select exists (
    select 1 from public.platform_admins where user_id = auth.uid()
  );
$$ language sql stable security definer;

-- Tenant member helper
create or replace function public.user_tenant_ids()
returns setof uuid as $$
  select tenant_id from public.memberships where user_id = auth.uid();
$$ language sql stable security definer;

-- Tenants: members read own; platform admins read all
create policy tenants_member_select on public.tenants
  for select using (
    public.is_platform_admin() or id in (select public.user_tenant_ids())
  );

create policy tenants_admin_all on public.tenants
  for all using (public.is_platform_admin());

-- Memberships
create policy memberships_member_select on public.memberships
  for select using (
    public.is_platform_admin() or user_id = auth.uid()
      or tenant_id in (select public.user_tenant_ids())
  );

create policy memberships_admin_all on public.memberships
  for all using (public.is_platform_admin());

-- Contacts
create policy contacts_tenant_access on public.contacts
  for all using (
    public.is_platform_admin() or tenant_id in (select public.user_tenant_ids())
  );

-- Contact identities (via contact tenant)
create policy contact_identities_tenant_access on public.contact_identities
  for all using (
    public.is_platform_admin()
    or contact_id in (
      select c.id from public.contacts c
      where c.tenant_id in (select public.user_tenant_ids())
    )
  );

-- Messages
create policy messages_tenant_access on public.messages
  for all using (
    public.is_platform_admin() or tenant_id in (select public.user_tenant_ids())
  );

-- Tenant phone numbers
create policy tenant_phone_numbers_access on public.tenant_phone_numbers
  for select using (
    public.is_platform_admin() or tenant_id in (select public.user_tenant_ids())
  );

create policy tenant_phone_numbers_admin on public.tenant_phone_numbers
  for all using (public.is_platform_admin());

-- Tenant agents
create policy tenant_agents_access on public.tenant_agents
  for select using (
    public.is_platform_admin() or tenant_id in (select public.user_tenant_ids())
  );

create policy tenant_agents_admin on public.tenant_agents
  for all using (public.is_platform_admin());

-- Channel accounts
create policy channel_accounts_access on public.channel_accounts
  for all using (
    public.is_platform_admin() or tenant_id in (select public.user_tenant_ids())
  );

-- Service role bypasses RLS (webhooks use service role key)
