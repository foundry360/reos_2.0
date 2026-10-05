-- Lead status change outbox. A trigger on contacts records every actual
-- lead_status transition, whichever code path wrote it; the app dispatches the
-- rows to journeys as lead.status_changed with the row id as the event id.

create table if not exists public.lead_status_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  contact_id uuid not null references public.contacts (id) on delete cascade,
  from_status text,
  to_status text not null,
  -- Which kind of writer made the change; see capture_lead_status_event.
  origin text not null default 'system'
    check (origin in ('user', 'ai_agent', 'system', 'journey', 'import', 'merge')),
  -- No foreign keys: provenance must never make the contact update itself fail.
  actor_user_id uuid,
  -- journey_runs.id of the run that made a journey change; its journey isn't re-enrolled by the event.
  origin_run_id uuid,
  converted boolean not null default false,
  changed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  -- Outbox delivery state. Set once the event was handed to journey dispatch.
  dispatched_at timestamptz,
  attempt_count integer not null default 0,
  last_error text,
  next_attempt_at timestamptz not null default now(),
  -- Short claim so concurrent dispatchers don't deliver the same row at once.
  locked_until timestamptz,
  claim_token uuid
);

create index if not exists lead_status_events_pending_idx
  on public.lead_status_events (next_attempt_at, created_at)
  where dispatched_at is null;

create index if not exists lead_status_events_contact_idx
  on public.lead_status_events (tenant_id, contact_id, created_at desc);

create index if not exists lead_status_events_created_idx
  on public.lead_status_events (created_at);

alter table public.lead_status_events enable row level security;

drop policy if exists lead_status_events_tenant_read on public.lead_status_events;

-- Read only for members; rows are written by the trigger and the service role.
create policy lead_status_events_tenant_read on public.lead_status_events
  for select using (
    public.is_platform_admin() or tenant_id in (select public.user_tenant_ids())
  );

-- Origin comes from the PostgREST request of the transaction that changed the row:
--   * signed-in users (role authenticated): always 'user' (or 'import' when the
--     request says so), and the actor is the JWT subject, never a header.
--   * service role: x-reos-origin / x-reos-actor-user-id / x-reos-origin-run-id
--     headers, accepted only when they are an allowed origin or a well-formed UUID.
--   * anything else (SQL editor, pg_cron, migrations, missing headers): 'system'.
create or replace function public.capture_lead_status_event()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uuid_pattern constant text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  v_claims jsonb;
  v_headers jsonb;
  v_role text;
  v_requested text;
  v_origin text := 'system';
  v_actor uuid;
  v_run uuid;
begin
  -- Malformed request settings must never block the status write itself.
  begin
    v_claims := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
  exception when others then
    v_claims := null;
  end;
  begin
    v_headers := nullif(current_setting('request.headers', true), '')::jsonb;
  exception when others then
    v_headers := null;
  end;

  v_role := v_claims ->> 'role';
  v_requested := lower(v_headers ->> 'x-reos-origin');

  if v_role = 'authenticated' then
    v_origin := case when v_requested = 'import' then 'import' else 'user' end;
    if (v_claims ->> 'sub') ~ v_uuid_pattern then
      v_actor := (v_claims ->> 'sub')::uuid;
    end if;
  elsif v_role = 'service_role' then
    if v_requested in ('user', 'ai_agent', 'system', 'journey', 'import', 'merge') then
      v_origin := v_requested;
    end if;
    if (v_headers ->> 'x-reos-actor-user-id') ~ v_uuid_pattern then
      v_actor := (v_headers ->> 'x-reos-actor-user-id')::uuid;
    end if;
    if v_origin = 'journey' and (v_headers ->> 'x-reos-origin-run-id') ~ v_uuid_pattern then
      v_run := (v_headers ->> 'x-reos-origin-run-id')::uuid;
    end if;
  end if;

  insert into public.lead_status_events (
    tenant_id, contact_id, from_status, to_status, origin, actor_user_id, origin_run_id, converted, changed_at
  ) values (
    new.tenant_id, new.id, old.lead_status, new.lead_status, v_origin, v_actor, v_run,
    new.lead_status = 'Converted', now()
  );
  return null;
end;
$$;

revoke all on function public.capture_lead_status_event() from public, anon, authenticated;

drop trigger if exists contacts_lead_status_event on public.contacts;
create trigger contacts_lead_status_event
  after update of lead_status on public.contacts
  for each row
  when (old.lead_status is distinct from new.lead_status)
  execute function public.capture_lead_status_event();

-- Claims due, undelivered rows for one dispatcher. Rows another dispatcher is
-- holding are skipped; an expired claim (crashed dispatcher) is claimable again.
create or replace function public.claim_lead_status_events(
  p_limit integer default 25,
  p_lease_seconds integer default 120,
  p_tenant_id uuid default null,
  p_contact_id uuid default null
)
returns setof public.lead_status_events
language sql
security definer
set search_path = public
as $$
  update public.lead_status_events e
     set locked_until = now() + make_interval(secs => greatest(p_lease_seconds, 1)),
         claim_token = gen_random_uuid()
   where e.id in (
     select p.id
       from public.lead_status_events p
      where p.dispatched_at is null
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

-- Marks a claimed row delivered. Idempotent: a row that is already delivered stays as it is.
create or replace function public.complete_lead_status_event(
  p_id uuid,
  p_claim_token uuid
)
returns boolean
language sql
security definer
set search_path = public
as $$
  with done as (
    update public.lead_status_events
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

-- Records a failed delivery and releases the claim with backoff (1, 2, 4 ... minutes,
-- capped at an hour). The row stays pending, so it is retried later.
create or replace function public.fail_lead_status_event(
  p_id uuid,
  p_claim_token uuid,
  p_error text
)
returns boolean
language sql
security definer
set search_path = public
as $$
  with failed as (
    update public.lead_status_events
       set attempt_count = attempt_count + 1,
           last_error = left(coalesce(p_error, 'Unknown error.'), 1000),
           next_attempt_at = now() + least(
             make_interval(mins => power(2, least(attempt_count, 6))::integer),
             interval '1 hour'
           ),
           locked_until = null,
           claim_token = null
     where id = p_id
       and dispatched_at is null
       and claim_token = p_claim_token
    returning 1
  )
  select exists (select 1 from failed);
$$;

revoke all on function public.claim_lead_status_events(integer, integer, uuid, uuid) from public, anon, authenticated;
revoke all on function public.complete_lead_status_event(uuid, uuid) from public, anon, authenticated;
revoke all on function public.fail_lead_status_event(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.claim_lead_status_events(integer, integer, uuid, uuid) to service_role;
grant execute on function public.complete_lead_status_event(uuid, uuid) to service_role;
grant execute on function public.fail_lead_status_event(uuid, uuid, text) to service_role;
