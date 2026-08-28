-- Opportunities pipelines: start with Intake

alter table public.opportunities
  add column if not exists pipeline text not null default 'Intake';

-- Drop old stage check before remapping values
alter table public.opportunities
  drop constraint if exists opportunities_stage_check;

-- Remap legacy sales stages → Intake
update public.opportunities
set
  pipeline = 'Intake',
  stage = case stage
    when 'Qualification' then 'New'
    when 'Proposal' then 'AI_Qualifying'
    when 'Negotiation' then 'Qualified'
    when 'Closed_Won' then 'Closed_Won'
    when 'Closed_Lost' then 'Nurture'
    when 'New' then 'New'
    when 'AI_Qualifying' then 'AI_Qualifying'
    when 'Qualified' then 'Qualified'
    when 'Appointment_Set' then 'Appointment_Set'
    when 'Nurture' then 'Nurture'
    else 'New'
  end;

alter table public.opportunities
  alter column stage set default 'New';

alter table public.opportunities
  drop constraint if exists opportunities_pipeline_check;

alter table public.opportunities
  add constraint opportunities_pipeline_check
  check (pipeline in ('Intake'));

alter table public.opportunities
  add constraint opportunities_stage_check
  check (
    stage in (
      'New',
      'AI_Qualifying',
      'Qualified',
      'Appointment_Set',
      'Nurture',
      'Closed_Won'
    )
  );

create index if not exists opportunities_pipeline_stage_idx
  on public.opportunities (tenant_id, pipeline, stage);
