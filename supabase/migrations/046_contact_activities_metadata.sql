-- Optional JSON metadata for contact activities (e.g. calendar invite status).

alter table public.contact_activities
  add column if not exists metadata jsonb not null default '{}'::jsonb;
