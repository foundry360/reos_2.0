-- Contact type for CRM contact records (not leads)

alter table public.contacts
  add column if not exists contact_type text;

alter table public.contacts
  drop constraint if exists contacts_contact_type_check;

alter table public.contacts
  add constraint contacts_contact_type_check
  check (
    contact_type is null
    or contact_type in (
      'Prospect',
      'Customer',
      'Inactive Customer',
      'Partner',
      'Vendor'
    )
  );

-- Converted contacts default to Prospect when type is missing
update public.contacts
set contact_type = 'Prospect'
where record_type = 'contact'
  and contact_type is null;

create index if not exists contacts_tenant_contact_type_idx
  on public.contacts (tenant_id, contact_type)
  where contact_type is not null;
