-- Agent routing flags + brief fields (GHL tag/stage port)
-- Keep lead_status as the CRM pipeline; these drive Coordinator playbooks.

alter table public.contacts
  add column if not exists ready_to_book boolean not null default false,
  add column if not exists appt_booked boolean not null default false,
  add column if not exists handoff boolean not null default false,
  add column if not exists agent_brief text,
  add column if not exists recommended_next_action text,
  add column if not exists intent text
    check (intent is null or intent in ('Buyer', 'Seller', 'Investor', 'Referral'));

create index if not exists contacts_ready_to_book_idx
  on public.contacts (tenant_id)
  where ready_to_book = true;

create index if not exists contacts_handoff_idx
  on public.contacts (tenant_id)
  where handoff = true;
