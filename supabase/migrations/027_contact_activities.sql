-- Logged CRM activities on contacts/leads (notes, calls, emails, meetings)

create table if not exists public.contact_activities (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  contact_id uuid not null references public.contacts (id) on delete cascade,
  activity_type text not null default 'note'
    check (activity_type in ('note', 'call', 'email', 'meeting', 'other', 'opportunity', 'contact')),
  title text not null,
  body text,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists contact_activities_contact_idx
  on public.contact_activities (contact_id, occurred_at desc);

create index if not exists contact_activities_tenant_idx
  on public.contact_activities (tenant_id, occurred_at desc);

create trigger contact_activities_updated_at
  before update on public.contact_activities
  for each row execute function public.set_updated_at();

alter table public.contact_activities enable row level security;

create policy contact_activities_tenant_access on public.contact_activities
  for all using (
    public.is_platform_admin() or tenant_id in (select public.user_tenant_ids())
  );
