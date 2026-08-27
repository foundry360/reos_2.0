-- Additional contacts for tenant accounts (primary contact remains on tenants)

create table public.tenant_contacts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  first_name text not null,
  last_name text not null,
  email text,
  phone_e164 text,
  website text,
  title text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index tenant_contacts_tenant_idx on public.tenant_contacts (tenant_id);

create trigger tenant_contacts_updated_at
  before update on public.tenant_contacts
  for each row execute function public.set_updated_at();

alter table public.tenant_contacts enable row level security;

create policy tenant_contacts_platform_admin on public.tenant_contacts
  for all using (public.is_platform_admin());
