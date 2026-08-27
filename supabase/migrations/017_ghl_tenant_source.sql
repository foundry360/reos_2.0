-- Link tenants provisioned from GoHighLevel opportunities.

alter table public.tenants
  add column if not exists ghl_opportunity_id text,
  add column if not exists ghl_contact_id text,
  add column if not exists ghl_location_id text,
  add column if not exists source text not null default 'manual';

create unique index if not exists tenants_ghl_opportunity_id_idx
  on public.tenants (ghl_opportunity_id)
  where ghl_opportunity_id is not null;
