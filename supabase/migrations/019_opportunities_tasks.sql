-- CRM opportunities and tasks for the tenant app

create table if not exists public.opportunities (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  contact_id uuid references public.contacts (id) on delete set null,
  name text not null,
  stage text not null default 'Qualification'
    check (stage in (
      'Qualification', 'Proposal', 'Negotiation', 'Closed_Won', 'Closed_Lost'
    )),
  amount_cents integer check (amount_cents is null or amount_cents >= 0),
  expected_close_date date,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists opportunities_tenant_idx
  on public.opportunities (tenant_id);

create index if not exists opportunities_contact_idx
  on public.opportunities (contact_id);

create index if not exists opportunities_stage_idx
  on public.opportunities (tenant_id, stage);

create table if not exists public.tasks (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  contact_id uuid references public.contacts (id) on delete set null,
  opportunity_id uuid references public.opportunities (id) on delete set null,
  title text not null,
  status text not null default 'open'
    check (status in ('open', 'done')),
  due_at timestamptz,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists tasks_tenant_idx
  on public.tasks (tenant_id);

create index if not exists tasks_contact_idx
  on public.tasks (contact_id);

create index if not exists tasks_status_idx
  on public.tasks (tenant_id, status);

create index if not exists tasks_due_idx
  on public.tasks (tenant_id, due_at);

create trigger opportunities_updated_at
  before update on public.opportunities
  for each row execute function public.set_updated_at();

create trigger tasks_updated_at
  before update on public.tasks
  for each row execute function public.set_updated_at();

alter table public.opportunities enable row level security;
alter table public.tasks enable row level security;

create policy opportunities_tenant_access on public.opportunities
  for all using (
    public.is_platform_admin() or tenant_id in (select public.user_tenant_ids())
  );

create policy tasks_tenant_access on public.tasks
  for all using (
    public.is_platform_admin() or tenant_id in (select public.user_tenant_ids())
  );
