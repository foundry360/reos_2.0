-- Bounds lead_status_events delivery retries.
--
-- attempt_count now counts delivery attempts and is incremented when a row is
-- claimed, so a dispatcher that dies or times out before reporting a failure
-- still uses up an attempt (its claim expires and the next claim counts again).
-- A row is never claimed again once it has used p_max_attempts attempts. When
-- the last attempt reports a failure, failed_at is set and last_error is kept.
--
-- Retry delays are unchanged: 1, 2, 4, 8, 16, 32, then 60 minutes.
--
-- Requeue a permanently failed event (the event itself is unchanged):
--   update public.lead_status_events
--      set failed_at = null, attempt_count = 0, next_attempt_at = now(),
--          locked_until = null, claim_token = null
--    where id = '<event id>' and dispatched_at is null;

alter table public.lead_status_events
  add column if not exists failed_at timestamptz;

drop index if exists public.lead_status_events_pending_idx;
create index if not exists lead_status_events_pending_idx
  on public.lead_status_events (next_attempt_at, created_at)
  where dispatched_at is null and failed_at is null;

-- Signatures and return types change, so the 055 versions are replaced.
drop function if exists public.claim_lead_status_events(integer, integer, uuid, uuid);
drop function if exists public.fail_lead_status_event(uuid, uuid, text);

-- p_max_attempts defaults to the runtime's limit (MAX_LEAD_STATUS_EVENT_ATTEMPTS),
-- which the runtime always passes explicitly.
create or replace function public.claim_lead_status_events(
  p_limit integer default 25,
  p_lease_seconds integer default 120,
  p_tenant_id uuid default null,
  p_contact_id uuid default null,
  p_max_attempts integer default 10
)
returns setof public.lead_status_events
language sql
security definer
set search_path = public
as $$
  update public.lead_status_events e
     set locked_until = now() + make_interval(secs => greatest(p_lease_seconds, 1)),
         claim_token = gen_random_uuid(),
         attempt_count = e.attempt_count + 1
   where e.id in (
     select p.id
       from public.lead_status_events p
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

-- Records a failed attempt and releases the claim. attempt_count already
-- includes this attempt (counted at claim). Returns 'retry' (rescheduled with
-- backoff), 'failed' (last attempt: failed_at set, no further retry), or
-- 'stale' (the claim token no longer matches; nothing changed).
create or replace function public.fail_lead_status_event(
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
    update public.lead_status_events
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

revoke all on function public.claim_lead_status_events(integer, integer, uuid, uuid, integer) from public, anon, authenticated;
revoke all on function public.fail_lead_status_event(uuid, uuid, text, integer) from public, anon, authenticated;
grant execute on function public.claim_lead_status_events(integer, integer, uuid, uuid, integer) to service_role;
grant execute on function public.fail_lead_status_event(uuid, uuid, text, integer) to service_role;
