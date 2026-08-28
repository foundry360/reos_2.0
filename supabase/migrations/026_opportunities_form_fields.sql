-- Extra opportunity fields for create/edit forms

alter table public.opportunities
  add column if not exists opportunity_type text not null default 'Buyer';

alter table public.opportunities
  add column if not exists assigned_agent_id uuid;

alter table public.opportunities
  add column if not exists lead_source text;

alter table public.opportunities
  add column if not exists priority text;

alter table public.opportunities
  drop constraint if exists opportunities_opportunity_type_check;

alter table public.opportunities
  add constraint opportunities_opportunity_type_check
  check (
    opportunity_type in (
      'Buyer',
      'Seller',
      'Buyer_Seller',
      'Lease',
      'Investment',
      'Referral',
      'Other'
    )
  );

alter table public.opportunities
  drop constraint if exists opportunities_priority_check;

alter table public.opportunities
  add constraint opportunities_priority_check
  check (
    priority is null
    or priority in ('Low', 'Medium', 'High', 'Urgent')
  );

alter table public.opportunities
  drop constraint if exists opportunities_lead_source_check;

alter table public.opportunities
  add constraint opportunities_lead_source_check
  check (
    lead_source is null
    or lead_source in (
      'Website',
      'Referral',
      'Zillow',
      'Realtor_com',
      'Open_House',
      'Social',
      'Paid_Ads',
      'Walk_In',
      'Other'
    )
  );

create index if not exists opportunities_assigned_agent_idx
  on public.opportunities (tenant_id, assigned_agent_id)
  where assigned_agent_id is not null;
