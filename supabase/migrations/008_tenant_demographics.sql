alter table public.tenants
  add column if not exists email text,
  add column if not exists street text,
  add column if not exists city text,
  add column if not exists state text,
  add column if not exists postal_code text,
  add column if not exists country text default 'United States';
