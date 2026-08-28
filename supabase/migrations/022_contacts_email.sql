-- Add email to CRM contacts (leads)

alter table public.contacts
  add column if not exists email text;

create index if not exists contacts_tenant_email_idx
  on public.contacts (tenant_id, lower(email))
  where email is not null;
