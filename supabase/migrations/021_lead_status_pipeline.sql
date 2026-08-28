-- Lead status pipeline: New → Working → Contacted → Qualified → Converted

alter table public.contacts
  drop constraint if exists contacts_lead_status_check;

update public.contacts
set opted_out = true
where lead_status = 'Compliance'
  and opted_out = false;

update public.contacts
set lead_status = case lead_status
  when 'Qualifying' then 'New'
  when 'Ready_to_Book' then 'Working'
  when 'Nurture' then 'Contacted'
  when 'Booked' then 'Qualified'
  when 'Handoff' then 'Working'
  when 'Compliance' then 'New'
  else lead_status
end
where lead_status in (
  'Qualifying',
  'Ready_to_Book',
  'Nurture',
  'Booked',
  'Handoff',
  'Compliance'
);

alter table public.contacts
  alter column lead_status set default 'New';

alter table public.contacts
  add constraint contacts_lead_status_check
  check (
    lead_status in (
      'New',
      'Working',
      'Contacted',
      'Qualified',
      'Converted'
    )
  );
