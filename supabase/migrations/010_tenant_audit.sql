-- Track who created and last modified each tenant account

alter table public.tenants
  add column if not exists created_by_id uuid references auth.users (id) on delete set null,
  add column if not exists last_modified_by_id uuid references auth.users (id) on delete set null;

update public.tenants
set created_by_id = account_owner_id
where created_by_id is null
  and account_owner_id is not null;
