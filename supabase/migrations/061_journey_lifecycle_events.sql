-- Lifecycle journey events on journey_events (060): opportunity.stage_changed,
-- appointment.rescheduled, lead.assigned, lead.handoff_requested. Each is
-- recorded by a trigger in the same transaction as the row change, only when the
-- value actually changes, with a new occurrence id per transition (the same
-- opportunity, appointment, or contact can go through the same transition again).
--
-- Fires on:
--   opportunity.stage_changed  insert of an opportunity with a contact (from_stage null),
--                              or an update where old.stage is distinct from new.stage
--   appointment.rescheduled    update of an appointment/meeting where occurred_at changed
--   lead.assigned              update where assigned_agent_id changed to a non-null value
--   lead.handoff_requested     update where handoff became true
--
-- Origin follows lead_status_events (055): signed-in users are 'user' (or
-- 'import' when the request says so); the service role may send x-reos-origin;
-- anything else is 'system'. x-reos-origin-run-id is kept only with origin
-- 'journey' and only for the two lead events, the ones a journey step can cause
-- (Assign lead, Update lead). The app derives causation depth, origin journey,
-- and root run from that run at dispatch, as for lead.status_changed; requests
-- can't supply them.
--
-- appointment.rescheduled carries rescheduled_by instead of an origin, like
-- booked_by on appointment.booked: signed-in users are 'team'; the service role
-- may send x-reos-appointment-rescheduled-by: agent | team; anything else is 'system'.
--
-- Payloads hold the point-in-time from/to values. The CRM row may have moved on
-- by the time a journey runs.

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
    'opportunity.stage_changed', 'appointment.rescheduled', 'lead.assigned', 'lead.handoff_requested'
  ));

-- Null on 060 events and on appointment.rescheduled. No foreign key, as in 055.
alter table public.journey_events
  add column if not exists origin text
    check (origin is null or origin in ('user', 'ai_agent', 'system', 'journey', 'import', 'merge')),
  add column if not exists origin_run_id uuid;

create or replace function public.journey_event_origin(out p_origin text, out p_origin_run_id uuid)
language plpgsql
stable
set search_path = public
as $$
declare
  v_uuid_pattern constant text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  v_request record;
  v_requested text;
begin
  select * into v_request from public.journey_event_request();
  v_requested := lower(v_request.p_headers ->> 'x-reos-origin');
  p_origin := 'system';
  if v_request.p_role = 'authenticated' then
    p_origin := case when v_requested = 'import' then 'import' else 'user' end;
  elsif v_request.p_role = 'service_role' then
    if v_requested in ('user', 'ai_agent', 'system', 'journey', 'import', 'merge') then
      p_origin := v_requested;
    end if;
    if p_origin = 'journey' and (v_request.p_headers ->> 'x-reos-origin-run-id') ~ v_uuid_pattern then
      p_origin_run_id := (v_request.p_headers ->> 'x-reos-origin-run-id')::uuid;
    end if;
  end if;
end;
$$;

create or replace function public.record_journey_transition(
  p_tenant_id uuid,
  p_contact_id uuid,
  p_event_type text,
  p_entity_type text,
  p_entity_id uuid,
  p_payload jsonb,
  p_origin text,
  p_origin_run_id uuid
)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.journey_events (
    tenant_id, contact_id, event_type, source_id, entity_type, entity_id, payload, origin, origin_run_id
  ) values (
    p_tenant_id, p_contact_id, p_event_type, gen_random_uuid()::text, p_entity_type, p_entity_id,
    coalesce(p_payload, '{}'::jsonb), p_origin, p_origin_run_id
  );
$$;

-- The opportunity's contact must be in the opportunity's workspace.
create or replace function public.capture_opportunity_stage_changed()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_origin record;
begin
  if not exists (select 1 from public.contacts c where c.id = new.contact_id and c.tenant_id = new.tenant_id) then
    return null;
  end if;
  select * into v_origin from public.journey_event_origin();
  perform public.record_journey_transition(
    new.tenant_id, new.contact_id, 'opportunity.stage_changed', 'opportunity', new.id,
    jsonb_build_object(
      'opportunity_id', new.id,
      'contact_id', new.contact_id,
      'pipeline', new.pipeline,
      'from_stage', case when tg_op = 'UPDATE' then old.stage end,
      'to_stage', new.stage,
      'origin', v_origin.p_origin
    ),
    v_origin.p_origin, null
  );
  return null;
end;
$$;

create or replace function public.capture_appointment_rescheduled()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_request record;
  v_by text;
begin
  if not exists (select 1 from public.contacts c where c.id = new.contact_id and c.tenant_id = new.tenant_id) then
    return null;
  end if;
  select * into v_request from public.journey_event_request();
  v_by := lower(v_request.p_headers ->> 'x-reos-appointment-rescheduled-by');
  if v_request.p_role = 'authenticated' then
    v_by := 'team';
  elsif v_request.p_role <> 'service_role' or v_by is null or v_by not in ('agent', 'team') then
    v_by := 'system';
  end if;
  perform public.record_journey_transition(
    new.tenant_id, new.contact_id, 'appointment.rescheduled', 'appointment', new.id,
    jsonb_build_object(
      'appointment_id', new.id,
      'contact_id', new.contact_id,
      'from_start', public.journey_event_iso(old.occurred_at),
      'to_start', public.journey_event_iso(new.occurred_at),
      'to_end', public.journey_event_iso(new.ends_at),
      'rescheduled_by', v_by
    ),
    null, null
  );
  return null;
end;
$$;

create or replace function public.capture_lead_assigned()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_origin record;
begin
  select * into v_origin from public.journey_event_origin();
  perform public.record_journey_transition(
    new.tenant_id, new.id, 'lead.assigned', 'contact', new.id,
    jsonb_build_object(
      'contact_id', new.id,
      'from_agent_id', old.assigned_agent_id,
      'to_agent_id', new.assigned_agent_id,
      'origin', v_origin.p_origin
    ),
    v_origin.p_origin, v_origin.p_origin_run_id
  );
  return null;
end;
$$;

create or replace function public.capture_lead_handoff_requested()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_origin record;
begin
  select * into v_origin from public.journey_event_origin();
  perform public.record_journey_transition(
    new.tenant_id, new.id, 'lead.handoff_requested', 'contact', new.id,
    jsonb_build_object('contact_id', new.id, 'origin', v_origin.p_origin),
    v_origin.p_origin, v_origin.p_origin_run_id
  );
  return null;
end;
$$;

revoke all on function public.journey_event_origin() from public, anon, authenticated;
revoke all on function public.record_journey_transition(uuid, uuid, text, text, uuid, jsonb, text, uuid) from public, anon, authenticated;
revoke all on function public.capture_opportunity_stage_changed() from public, anon, authenticated;
revoke all on function public.capture_appointment_rescheduled() from public, anon, authenticated;
revoke all on function public.capture_lead_assigned() from public, anon, authenticated;
revoke all on function public.capture_lead_handoff_requested() from public, anon, authenticated;

drop trigger if exists opportunities_stage_set_event on public.opportunities;
create trigger opportunities_stage_set_event
  after insert on public.opportunities
  for each row
  when (new.contact_id is not null)
  execute function public.capture_opportunity_stage_changed();

drop trigger if exists opportunities_stage_changed_event on public.opportunities;
create trigger opportunities_stage_changed_event
  after update of stage on public.opportunities
  for each row
  when (old.stage is distinct from new.stage and new.contact_id is not null)
  execute function public.capture_opportunity_stage_changed();

drop trigger if exists contact_activities_appointment_rescheduled_event on public.contact_activities;
create trigger contact_activities_appointment_rescheduled_event
  after update of occurred_at on public.contact_activities
  for each row
  when (new.activity_type in ('appointment', 'meeting') and old.occurred_at is distinct from new.occurred_at)
  execute function public.capture_appointment_rescheduled();

drop trigger if exists contacts_lead_assigned_event on public.contacts;
create trigger contacts_lead_assigned_event
  after update of assigned_agent_id on public.contacts
  for each row
  when (new.assigned_agent_id is not null and old.assigned_agent_id is distinct from new.assigned_agent_id)
  execute function public.capture_lead_assigned();

drop trigger if exists contacts_lead_handoff_requested_event on public.contacts;
create trigger contacts_lead_handoff_requested_event
  after update of handoff on public.contacts
  for each row
  when (new.handoff is true and old.handoff is not true)
  execute function public.capture_lead_handoff_requested();
