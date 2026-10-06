-- Durable journey events: lead.created, message.received, appointment.booked,
-- task.completed. Each is recorded by a trigger in the same transaction as the
-- CRM write that is the fact (contact identity / contact, inbound message,
-- appointment activity, task status), so the event exists if and only if the
-- write committed. The app dispatches pending rows to journeys with the same
-- claim / complete / fail contract as lead_status_events (055, 057).
--
-- Producers opt in per write with request headers (service role unless noted):
--   x-reos-lead-source: message | comment | manual   (authenticated: always manual)
--   x-reos-lead-channel: sms | messenger | instagram (optional; service role only)
--   x-reos-message-received: 1                       (inbound messages only)
--   x-reos-appointment-booked-by: agent | team       (authenticated: always team)
-- task.completed needs no header: every open -> done transition with a contact.
--
-- Event identity (unique per tenant and event type):
--   lead.created        contact id
--   message.received    <channel>:<provider message id>, else the message row id
--   appointment.booked  contact_activities id
--   task.completed      a new id per transition
--
-- Inbound provider identity: messages.provider_message_id, unique per tenant and
-- channel. Inserting the inbound row is the webhook's claim; a redelivery hits
-- the unique index and stops before any AI turn or reply.
--
-- Requeue a permanently failed event (the event itself is unchanged):
--   update public.journey_events
--      set failed_at = null, attempt_count = 0, next_attempt_at = now(),
--          locked_until = null, claim_token = null
--    where id = '<event id>' and dispatched_at is null;

alter table public.messages
  add column if not exists provider_message_id text;

create unique index if not exists messages_provider_message_id_key
  on public.messages (tenant_id, channel, provider_message_id)
  where provider_message_id is not null;

-- One REOS Concierge booking per contact and start time: a repeated or concurrent
-- booking request for the same slot can't create a second appointment.
create unique index if not exists contact_activities_concierge_slot_key
  on public.contact_activities (tenant_id, contact_id, occurred_at)
  where activity_type = 'appointment' and source = 'concierge';

create table if not exists public.journey_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  contact_id uuid not null references public.contacts (id) on delete cascade,
  event_type text not null
    check (event_type in ('lead.created', 'message.received', 'appointment.booked', 'task.completed')),
  source_id text not null,
  entity_type text not null,
  entity_id uuid,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  -- Outbox delivery state, as in lead_status_events.
  dispatched_at timestamptz,
  attempt_count integer not null default 0,
  last_error text,
  next_attempt_at timestamptz not null default now(),
  locked_until timestamptz,
  claim_token uuid,
  failed_at timestamptz,
  unique (tenant_id, event_type, source_id)
);

create index if not exists journey_events_pending_idx
  on public.journey_events (next_attempt_at, created_at)
  where dispatched_at is null and failed_at is null;

create index if not exists journey_events_contact_idx
  on public.journey_events (tenant_id, contact_id, created_at desc);

alter table public.journey_events enable row level security;

drop policy if exists journey_events_tenant_read on public.journey_events;

-- Read only for members; rows are written by the triggers and the service role.
create policy journey_events_tenant_read on public.journey_events
  for select using (
    public.is_platform_admin() or tenant_id in (select public.user_tenant_ids())
  );

-- The PostgREST request role and headers of the current transaction. Malformed
-- settings read as empty so they never block the CRM write itself.
create or replace function public.journey_event_request(out p_role text, out p_headers jsonb)
language plpgsql
stable
set search_path = public
as $$
declare
  v_claims jsonb;
begin
  begin
    v_claims := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
  exception when others then
    v_claims := null;
  end;
  begin
    p_headers := nullif(current_setting('request.headers', true), '')::jsonb;
  exception when others then
    p_headers := null;
  end;
  p_role := coalesce(v_claims ->> 'role', '');
  p_headers := coalesce(p_headers, '{}'::jsonb);
end;
$$;

create or replace function public.journey_event_iso(p_at timestamptz)
returns text
language sql
immutable
as $$
  select to_char(p_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
$$;

create or replace function public.record_journey_event(
  p_tenant_id uuid,
  p_contact_id uuid,
  p_event_type text,
  p_source_id text,
  p_entity_type text,
  p_entity_id uuid,
  p_payload jsonb
)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.journey_events (tenant_id, contact_id, event_type, source_id, entity_type, entity_id, payload)
  values (p_tenant_id, p_contact_id, p_event_type, p_source_id, p_entity_type, p_entity_id, coalesce(p_payload, '{}'::jsonb))
  on conflict (tenant_id, event_type, source_id) do nothing;
$$;

-- lead.created: a new lead row (manual create) or a new lead's first identity
-- (inbound intake, so a contact whose identity insert lost a race never emits).
create or replace function public.capture_lead_created()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_request record;
  v_source text;
  v_channel text;
  v_contact_id uuid;
  v_tenant_id uuid;
  v_record_type text;
begin
  select * into v_request from public.journey_event_request();
  v_source := lower(v_request.p_headers ->> 'x-reos-lead-source');
  if v_source is null then
    return null;
  end if;

  if v_request.p_role = 'authenticated' then
    v_source := 'manual';
  elsif v_request.p_role <> 'service_role' or v_source not in ('message', 'comment', 'manual') then
    return null;
  end if;

  -- The intake channel is service-origin metadata, like the source.
  v_channel := case when v_request.p_role = 'service_role'
    then lower(v_request.p_headers ->> 'x-reos-lead-channel')
  end;
  if v_channel is not null and v_channel not in ('sms', 'messenger', 'instagram') then
    v_channel := null;
  end if;

  if tg_table_name = 'contacts' then
    v_contact_id := new.id;
    v_tenant_id := new.tenant_id;
    v_record_type := new.record_type;
  else
    v_contact_id := new.contact_id;
    select c.tenant_id, c.record_type into v_tenant_id, v_record_type
      from public.contacts c where c.id = new.contact_id;
  end if;

  if v_tenant_id is null or v_record_type is distinct from 'lead' then
    return null;
  end if;

  perform public.record_journey_event(
    v_tenant_id, v_contact_id, 'lead.created', v_contact_id::text, 'contact', v_contact_id,
    case when v_channel is null
      then jsonb_build_object('source', v_source)
      else jsonb_build_object('channel', v_channel, 'source', v_source)
    end
  );
  return null;
end;
$$;

create or replace function public.capture_message_received()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_request record;
begin
  select * into v_request from public.journey_event_request();
  if v_request.p_role <> 'service_role' or (v_request.p_headers ->> 'x-reos-message-received') is distinct from '1' then
    return null;
  end if;

  perform public.record_journey_event(
    new.tenant_id, new.contact_id, 'message.received',
    case when new.provider_message_id is not null
      then new.channel || ':' || new.provider_message_id
      else new.id::text
    end,
    'message', new.id,
    jsonb_build_object('channel', new.channel, 'body', left(new.body, 1000))
  );
  return null;
end;
$$;

create or replace function public.capture_appointment_booked()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_request record;
  v_booked_by text;
begin
  select * into v_request from public.journey_event_request();
  v_booked_by := lower(v_request.p_headers ->> 'x-reos-appointment-booked-by');
  if v_booked_by is null then
    return null;
  end if;

  if v_request.p_role = 'authenticated' then
    v_booked_by := 'team';
  elsif v_request.p_role <> 'service_role' or v_booked_by not in ('agent', 'team') then
    return null;
  end if;

  perform public.record_journey_event(
    new.tenant_id, new.contact_id, 'appointment.booked', new.id::text, 'appointment', new.id,
    jsonb_build_object(
      'start', public.journey_event_iso(new.occurred_at),
      'end', public.journey_event_iso(new.ends_at),
      'booked_by', v_booked_by
    )
  );
  return null;
end;
$$;

create or replace function public.capture_task_completed()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.record_journey_event(
    new.tenant_id, new.contact_id, 'task.completed', gen_random_uuid()::text, 'task', new.id,
    jsonb_build_object('task_id', new.id, 'title', new.title)
  );
  return null;
end;
$$;

revoke all on function public.journey_event_request() from public, anon, authenticated;
revoke all on function public.record_journey_event(uuid, uuid, text, text, text, uuid, jsonb) from public, anon, authenticated;
revoke all on function public.capture_lead_created() from public, anon, authenticated;
revoke all on function public.capture_message_received() from public, anon, authenticated;
revoke all on function public.capture_appointment_booked() from public, anon, authenticated;
revoke all on function public.capture_task_completed() from public, anon, authenticated;

drop trigger if exists contacts_lead_created_event on public.contacts;
create trigger contacts_lead_created_event
  after insert on public.contacts
  for each row
  execute function public.capture_lead_created();

drop trigger if exists contact_identities_lead_created_event on public.contact_identities;
create trigger contact_identities_lead_created_event
  after insert on public.contact_identities
  for each row
  execute function public.capture_lead_created();

drop trigger if exists messages_received_event on public.messages;
create trigger messages_received_event
  after insert on public.messages
  for each row
  when (new.direction = 'inbound')
  execute function public.capture_message_received();

drop trigger if exists contact_activities_appointment_booked_event on public.contact_activities;
create trigger contact_activities_appointment_booked_event
  after insert on public.contact_activities
  for each row
  when (new.activity_type in ('appointment', 'meeting'))
  execute function public.capture_appointment_booked();

drop trigger if exists tasks_completed_event on public.tasks;
create trigger tasks_completed_event
  after update of status on public.tasks
  for each row
  when (old.status is distinct from new.status and new.status = 'done' and new.contact_id is not null)
  execute function public.capture_task_completed();

-- Same delivery contract as claim/complete/fail_lead_status_event(s) (057).
create or replace function public.claim_journey_events(
  p_limit integer default 25,
  p_lease_seconds integer default 120,
  p_tenant_id uuid default null,
  p_contact_id uuid default null,
  p_max_attempts integer default 10
)
returns setof public.journey_events
language sql
security definer
set search_path = public
as $$
  update public.journey_events e
     set locked_until = now() + make_interval(secs => greatest(p_lease_seconds, 1)),
         claim_token = gen_random_uuid(),
         attempt_count = e.attempt_count + 1
   where e.id in (
     select p.id
       from public.journey_events p
      where p.dispatched_at is null
        and p.failed_at is null
        and p.attempt_count < greatest(p_max_attempts, 1)
        and p.next_attempt_at <= now()
        and (p.locked_until is null or p.locked_until <= now())
        and (p_tenant_id is null or p.tenant_id = p_tenant_id)
        and (p_contact_id is null or p.contact_id = p_contact_id)
      order by p.created_at, p.id
      limit greatest(least(p_limit, 200), 1)
      for update skip locked
   )
  returning e.*;
$$;

create or replace function public.complete_journey_event(
  p_id uuid,
  p_claim_token uuid
)
returns boolean
language sql
security definer
set search_path = public
as $$
  with done as (
    update public.journey_events
       set dispatched_at = now(),
           last_error = null,
           locked_until = null,
           claim_token = null
     where id = p_id
       and dispatched_at is null
       and claim_token = p_claim_token
    returning 1
  )
  select exists (select 1 from done);
$$;

create or replace function public.fail_journey_event(
  p_id uuid,
  p_claim_token uuid,
  p_error text,
  p_max_attempts integer default 10
)
returns text
language sql
security definer
set search_path = public
as $$
  with failed as (
    update public.journey_events
       set last_error = left(coalesce(p_error, 'Unknown error.'), 1000),
           failed_at = case when attempt_count >= greatest(p_max_attempts, 1) then now() end,
           next_attempt_at = case
             when attempt_count >= greatest(p_max_attempts, 1) then next_attempt_at
             else now() + least(
               make_interval(mins => power(2, least(greatest(attempt_count - 1, 0), 6))::integer),
               interval '1 hour'
             )
           end,
           locked_until = null,
           claim_token = null
     where id = p_id
       and dispatched_at is null
       and claim_token = p_claim_token
    returning failed_at
  )
  select case
    when not exists (select 1 from failed) then 'stale'
    when (select failed_at from failed) is not null then 'failed'
    else 'retry'
  end;
$$;

revoke all on function public.claim_journey_events(integer, integer, uuid, uuid, integer) from public, anon, authenticated;
revoke all on function public.complete_journey_event(uuid, uuid) from public, anon, authenticated;
revoke all on function public.fail_journey_event(uuid, uuid, text, integer) from public, anon, authenticated;
grant execute on function public.claim_journey_events(integer, integer, uuid, uuid, integer) to service_role;
grant execute on function public.complete_journey_event(uuid, uuid) to service_role;
grant execute on function public.fail_journey_event(uuid, uuid, text, integer) to service_role;
