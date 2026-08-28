-- Distinguish CRM leads vs contacts (same people table)

alter table public.contacts
  add column if not exists record_type text not null default 'lead';

alter table public.contacts
  drop constraint if exists contacts_record_type_check;

alter table public.contacts
  add constraint contacts_record_type_check
  check (record_type in ('lead', 'contact'));

create index if not exists contacts_tenant_record_type_idx
  on public.contacts (tenant_id, record_type);
