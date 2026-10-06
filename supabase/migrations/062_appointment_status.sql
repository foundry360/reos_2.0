-- Appointment state on the existing appointment/meeting rows of contact_activities:
-- scheduled | cancelled | completed | no_show. Cancelling sets the status instead
-- of deleting the row. Only a scheduled appointment changes status or time; the
-- other three are final.
--
-- Each move out of scheduled records a journey event (060) in the same
-- transaction, with a new occurrence id per transition:
--   appointment.cancelled | appointment.completed | appointment.no_show
-- Payload: appointment_id, contact_id, opportunity_id (when the row is linked to
-- one), from_status, to_status, start, end, changed_by. changed_by is 'team' for
-- signed-in users and 'system' for anything else; requests can't choose it.
--
-- Prerequisite: 060 and 061.

alter table public.contact_activities
  add column if not exists appointment_status text;

alter table public.contact_activities
  drop constraint if exists contact_activities_appointment_status_check;
alter table public.contact_activities
  add constraint contact_activities_appointment_status_check
  check (appointment_status is null or appointment_status in ('scheduled', 'cancelled', 'completed', 'no_show'));

-- Existing appointments and meetings carry no state today (production: no
-- status-like metadata), so they are scheduled.
update public.contact_activities
   set appointment_status = 'scheduled'
 where activity_type in ('appointment', 'meeting')
   and appointment_status is null;

alter table public.contact_activities
  drop constraint if exists contact_activities_appointment_has_status;
alter table public.contact_activities
  add constraint contact_activities_appointment_has_status
  check (activity_type not in ('appointment', 'meeting') or appointment_status is not null);

-- New appointments start scheduled; a cancelled, completed, or no-show
-- appointment can't change status or move to another time.
create or replace function public.contact_activities_appointment_state()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.activity_type in ('appointment', 'meeting') and new.appointment_status is null then
    new.appointment_status := 'scheduled';
  end if;
  if tg_op = 'UPDATE' and old.appointment_status is not null and old.appointment_status <> 'scheduled' then
    if new.appointment_status is distinct from old.appointment_status then
      raise exception 'This appointment is % and can''t change status.', old.appointment_status
        using errcode = '23514';
    end if;
    if new.occurred_at is distinct from old.occurred_at then
      raise exception 'This appointment is % and can''t be rescheduled.', old.appointment_status
        using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists contact_activities_appointment_state on public.contact_activities;
create trigger contact_activities_appointment_state
  before insert or update of appointment_status, activity_type, occurred_at on public.contact_activities
  for each row
  execute function public.contact_activities_appointment_state();

-- A cancelled concierge booking no longer holds its slot (060's index, now
-- without cancelled rows), so the same contact can book that time again.
drop index if exists public.contact_activities_concierge_slot_key;
create unique index contact_activities_concierge_slot_key
  on public.contact_activities (tenant_id, contact_id, occurred_at)
  where activity_type = 'appointment' and source = 'concierge' and appointment_status <> 'cancelled';

do $$
declare
  v_name text;
begin
  for v_name in
    select conname from pg_constraint
     where conrelid = 'public.journey_events'::regclass
       and contype = 'c'
       and pg_get_constraintdef(oid) like '%event_type%'
  loop
    execute format('alter table public.journey_events drop constraint %I', v_name);
  end loop;
end;
$$;

alter table public.journey_events
  add constraint journey_events_event_type_check check (event_type in (
    'lead.created', 'message.received', 'appointment.booked', 'task.completed',
    'opportunity.stage_changed', 'appointment.rescheduled', 'lead.assigned', 'lead.handoff_requested',
    'appointment.cancelled', 'appointment.completed', 'appointment.no_show'
  ));

-- The appointment's contact must be in the appointment's workspace.
create or replace function public.capture_appointment_status_changed()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_request record;
begin
  if not exists (select 1 from public.contacts c where c.id = new.contact_id and c.tenant_id = new.tenant_id) then
    return null;
  end if;
  select * into v_request from public.journey_event_request();
  perform public.record_journey_transition(
    new.tenant_id, new.contact_id, 'appointment.' || new.appointment_status, 'appointment', new.id,
    jsonb_build_object(
      'appointment_id', new.id,
      'contact_id', new.contact_id,
      'opportunity_id', case when new.related_entity_type = 'opportunity' then new.related_entity_id end,
      'from_status', old.appointment_status,
      'to_status', new.appointment_status,
      'start', public.journey_event_iso(new.occurred_at),
      'end', public.journey_event_iso(new.ends_at),
      'changed_by', case when v_request.p_role = 'authenticated' then 'team' else 'system' end
    ),
    null, null
  );
  return null;
end;
$$;

revoke all on function public.capture_appointment_status_changed() from public, anon, authenticated;

drop trigger if exists contact_activities_appointment_status_event on public.contact_activities;
create trigger contact_activities_appointment_status_event
  after update of appointment_status on public.contact_activities
  for each row
  when (
    new.activity_type in ('appointment', 'meeting')
    and old.appointment_status is distinct from new.appointment_status
    and new.appointment_status in ('cancelled', 'completed', 'no_show')
  )
  execute function public.capture_appointment_status_changed();
