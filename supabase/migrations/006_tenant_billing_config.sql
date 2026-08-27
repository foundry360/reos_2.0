alter table public.tenants
  add column if not exists stripe_customer_id text,
  add column if not exists internal_notes text;
