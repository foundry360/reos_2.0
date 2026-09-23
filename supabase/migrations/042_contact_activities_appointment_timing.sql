-- Timed REOS appointments on contact_activities (Concierge / calendar SoR).
-- occurred_at = start; ends_at = end. source distinguishes concierge vs manual/system.

alter table public.contact_activities
  add column if not exists ends_at timestamptz;

alter table public.contact_activities
  add column if not exists source text;

comment on column public.contact_activities.ends_at is
  'Appointment/meeting end time. Null for untimed CRM log rows.';

comment on column public.contact_activities.source is
  'Origin of the activity, e.g. concierge, manual, system.';

create index if not exists contact_activities_tenant_time_idx
  on public.contact_activities (tenant_id, occurred_at)
  where activity_type in ('appointment', 'meeting');
