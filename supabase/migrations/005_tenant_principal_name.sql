alter table public.tenants
  add column if not exists principal_first_name text,
  add column if not exists principal_last_name text;
