alter table public.tenants
  add column if not exists account_type text default 'Tenant',
  add column if not exists website text,
  add column if not exists industry text,
  add column if not exists account_owner_id uuid references auth.users (id) on delete set null;

create index if not exists tenants_account_owner_idx on public.tenants (account_owner_id);
