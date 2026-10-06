-- Email delivery reconciliation and provider events (E.3c).
--
-- crm_emails.status stays the record of REOS handing an email to Resend
-- (pending / sent / failed / unknown). What happened after Resend took it is a
-- separate dimension, delivery_status, set only from signed Resend events (or
-- Resend's own record of the email) and ordered by event time.
--
-- Every outbound send is tagged reos_email_id = crm_emails.id, so a signed
-- event names the exact row even when REOS never recorded Resend's answer
-- (accepted but not saved, timeout, 5xx). An event proves Resend accepted that
-- email: pending, unknown or failed become sent. Nothing here ever resends.
--
-- email_provider_events is the audit trail and the idempotency guard: one row
-- per provider event id, holding only identifiers, type, times, the result and
-- a small detail. Payloads are never stored. Rows are purged after 90 days.
--
-- Additive and idempotent. Existing rows keep their status; pending and unknown
-- rows are scheduled for reconciliation.

alter table public.crm_emails
  add column if not exists delivery_status text,
  add column if not exists delivery_event_at timestamptz,
  add column if not exists reconcile_after timestamptz,
  add column if not exists reconcile_attempts integer not null default 0;

alter table public.crm_emails drop constraint if exists crm_emails_delivery_status_check;
alter table public.crm_emails
  add constraint crm_emails_delivery_status_check
  check (delivery_status is null
    or delivery_status in ('delivered', 'delayed', 'bounced', 'complained', 'failed', 'suppressed'));

comment on column public.crm_emails.delivery_status is
  'What happened after Resend accepted the email, from signed Resend events: delivered, delayed, bounced, complained, failed or suppressed. Independent of status.';
comment on column public.crm_emails.delivery_event_at is
  'Provider time of the event that set delivery_status; an older event never replaces a newer one. Null when it came from Resend''s record without an event time.';
comment on column public.crm_emails.reconcile_after is
  'When the reconciliation sweeper next checks a pending or unknown outbound email; null when it no longer does.';
comment on column public.crm_emails.reconcile_attempts is
  'Sweeper checks since the email last became pending or unknown.';

-- A row that becomes pending or unknown is due for its first check 15 minutes
-- later (far past the 20 second provider timeout, so never mid-send).
create or replace function public.crm_emails_schedule_reconcile()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.direction = 'outbound'
     and new.status in ('pending', 'unknown')
     and (tg_op = 'INSERT' or old.status is distinct from new.status) then
    new.reconcile_after := now() + interval '15 minutes';
    new.reconcile_attempts := 0;
  end if;
  return new;
end;
$$;

drop trigger if exists crm_emails_schedule_reconcile on public.crm_emails;
create trigger crm_emails_schedule_reconcile
  before insert or update of status on public.crm_emails
  for each row execute function public.crm_emails_schedule_reconcile();

update public.crm_emails
   set reconcile_after = now()
 where direction = 'outbound'
   and status in ('pending', 'unknown')
   and reconcile_after is null;

create index if not exists crm_emails_reconcile_due_idx
  on public.crm_emails (reconcile_after)
  where status in ('pending', 'unknown') and reconcile_after is not null;

create table if not exists public.email_provider_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider in ('resend')),
  provider_event_id text not null,
  provider_message_id text,
  event_type text not null,
  event_at timestamptz,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  result text check (result is null
    or result in ('applied', 'stale', 'ignored', 'unmatched', 'mismatch')),
  -- Resolved from the local email the event names, never from the payload.
  tenant_id uuid references public.tenants (id) on delete cascade,
  email_id uuid references public.crm_emails (id) on delete set null,
  detail jsonb not null default '{}'::jsonb,
  unique (provider, provider_event_id)
);

create index if not exists email_provider_events_email_idx
  on public.email_provider_events (email_id, received_at desc)
  where email_id is not null;

create index if not exists email_provider_events_received_idx
  on public.email_provider_events (received_at);

alter table public.email_provider_events enable row level security;

drop policy if exists email_provider_events_tenant_read on public.email_provider_events;
create policy email_provider_events_tenant_read on public.email_provider_events
  for select using (
    public.is_platform_admin() or (tenant_id is not null and tenant_id in (select public.user_tenant_ids()))
  );

revoke insert, update, delete on public.email_provider_events from anon, authenticated;

comment on table public.email_provider_events is
  'Audit trail and idempotency guard for Resend events: identifiers, type, times and result only. Written by apply_email_provider_event; purged after 90 days.';

-- Applies one provider event in one transaction: records it (a repeat of the
-- event id changes nothing), finds the email it names (the reos_email_id tag,
-- else the only email with that provider id), takes the tenant from that email,
-- moves pending/unknown/failed to sent, orders delivery_status by event time,
-- and writes the "Email sent" activity only when this event made the email sent.
-- p_event_at null (Resend's record, not an event) never replaces a delivery status.
create or replace function public.apply_email_provider_event(
  p_provider text,
  p_provider_event_id text,
  p_event_type text,
  p_provider_message_id text,
  p_reos_email_id text,
  p_event_at timestamptz,
  p_detail jsonb default '{}'::jsonb
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event_id uuid;
  v_ids uuid[];
  v_email public.crm_emails%rowtype;
  v_delivery text;
  v_accepts boolean;
  v_transitioned boolean := false;
  v_delivery_set boolean := false;
  v_result text;
  v_count integer;
begin
  insert into public.email_provider_events (provider, provider_event_id, provider_message_id, event_type, event_at, detail)
  values (p_provider, p_provider_event_id, nullif(p_provider_message_id, ''), p_event_type, p_event_at, coalesce(p_detail, '{}'::jsonb))
  on conflict (provider, provider_event_id) do nothing
  returning id into v_event_id;
  if v_event_id is null then
    return 'duplicate';
  end if;

  if p_reos_email_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    select array_agg(e.id) into v_ids
      from public.crm_emails e
     where e.id = p_reos_email_id::uuid
       and e.provider = p_provider
       and e.direction = 'outbound';
  elsif nullif(p_provider_message_id, '') is not null then
    select array_agg(m.id) into v_ids
      from (select e.id
              from public.crm_emails e
             where e.provider = p_provider
               and e.provider_message_id = p_provider_message_id
               and e.direction = 'outbound'
             limit 2) m;
  end if;

  if coalesce(cardinality(v_ids), 0) <> 1 then
    update public.email_provider_events
       set result = 'unmatched', processed_at = now()
     where id = v_event_id;
    return 'unmatched';
  end if;

  select * into v_email from public.crm_emails where id = v_ids[1] for update;
  if not found then
    update public.email_provider_events
       set result = 'unmatched', processed_at = now()
     where id = v_event_id;
    return 'unmatched';
  end if;

  -- The event's provider id must be this email's, and must not be another email's.
  if nullif(p_provider_message_id, '') is not null and (
       (v_email.provider_message_id is not null and v_email.provider_message_id <> p_provider_message_id)
       or exists (
         select 1 from public.crm_emails o
          where o.tenant_id = v_email.tenant_id
            and o.provider = p_provider
            and o.provider_message_id = p_provider_message_id
            and o.id <> v_email.id)) then
    update public.email_provider_events
       set result = 'mismatch', processed_at = now(), tenant_id = v_email.tenant_id, email_id = v_email.id
     where id = v_event_id;
    return 'mismatch';
  end if;

  v_accepts := p_event_type in (
    'email.sent', 'email.delivered', 'email.delivery_delayed', 'email.bounced',
    'email.complained', 'email.failed', 'email.suppressed');
  v_delivery := case p_event_type
    when 'email.delivered' then 'delivered'
    when 'email.delivery_delayed' then 'delayed'
    when 'email.bounced' then 'bounced'
    when 'email.complained' then 'complained'
    when 'email.failed' then 'failed'
    when 'email.suppressed' then 'suppressed'
    else null
  end;

  if not v_accepts then
    update public.email_provider_events
       set result = 'ignored', processed_at = now(), tenant_id = v_email.tenant_id, email_id = v_email.id
     where id = v_event_id;
    return 'ignored';
  end if;

  update public.crm_emails
     set status = 'sent',
         provider_message_id = coalesce(provider_message_id, nullif(p_provider_message_id, '')),
         sent_at = coalesce(sent_at, p_event_at, now()),
         send_error = null,
         reconcile_after = null
   where id = v_email.id
     and status in ('pending', 'unknown', 'failed');
  get diagnostics v_count = row_count;
  v_transitioned := v_count > 0;

  if v_delivery is not null then
    update public.crm_emails
       set delivery_status = v_delivery,
           delivery_event_at = p_event_at
     where id = v_email.id
       and (delivery_status is null
            or (p_event_at is not null and (delivery_event_at is null or p_event_at > delivery_event_at)))
       and not (v_delivery = 'delayed'
                and coalesce(delivery_status, '') in ('delivered', 'bounced', 'complained', 'failed', 'suppressed'));
    get diagnostics v_count = row_count;
    v_delivery_set := v_count > 0;
  end if;

  if v_transitioned
     and v_email.contact_id is not null
     and coalesce(v_email.metadata ->> 'purpose', '') in ('marketing', 'conversational') then
    insert into public.contact_activities (
      tenant_id, contact_id, activity_type, title, body, occurred_at, related_entity_type, related_entity_id)
    values (
      v_email.tenant_id, v_email.contact_id, 'email', 'Email sent: ' || coalesce(v_email.subject, ''),
      nullif(btrim(coalesce(v_email.snippet, '')), ''), now(),
      case when v_email.opportunity_id is not null then 'opportunity' end, v_email.opportunity_id);
  end if;

  v_result := case when v_transitioned or v_delivery_set then 'applied' else 'stale' end;
  update public.email_provider_events
     set result = v_result, processed_at = now(), tenant_id = v_email.tenant_id, email_id = v_email.id
   where id = v_event_id;
  return v_result;
end;
$$;

-- Leases up to p_limit due pending/unknown outbound Resend emails to one
-- sweeper: reconcile_after moves past the lease, so a concurrent sweeper skips
-- them (and the row locks) and a crashed sweeper's rows come back later.
create or replace function public.claim_email_reconciliation(
  p_limit integer default 25,
  p_lease_seconds integer default 300
)
returns table (
  id uuid,
  tenant_id uuid,
  status text,
  provider_message_id text,
  reconcile_attempts integer,
  created_at timestamptz
)
language sql
security definer
set search_path = public
as $$
  update public.crm_emails e
     set reconcile_after = now() + make_interval(secs => greatest(p_lease_seconds, 1)),
         reconcile_attempts = e.reconcile_attempts + 1
   where e.id in (
     select c.id
       from public.crm_emails c
      where c.status in ('pending', 'unknown')
        and c.direction = 'outbound'
        and c.provider = 'resend'
        and c.reconcile_after is not null
        and c.reconcile_after <= now()
      order by c.reconcile_after, c.id
      limit greatest(least(p_limit, 200), 1)
      for update skip locked
   )
  returning e.id, e.tenant_id, e.status, e.provider_message_id, e.reconcile_attempts, e.created_at;
$$;

create or replace function public.purge_email_provider_events(
  p_older_than_days integer default 90,
  p_limit integer default 500
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  delete from public.email_provider_events
   where id in (
     select id from public.email_provider_events
      where received_at < now() - make_interval(days => greatest(p_older_than_days, 1))
      order by received_at
      limit greatest(least(p_limit, 5000), 1)
   );
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.apply_email_provider_event(text, text, text, text, text, timestamptz, jsonb) from public, anon, authenticated;
revoke all on function public.claim_email_reconciliation(integer, integer) from public, anon, authenticated;
revoke all on function public.purge_email_provider_events(integer, integer) from public, anon, authenticated;
grant execute on function public.apply_email_provider_event(text, text, text, text, text, timestamptz, jsonb) to service_role;
grant execute on function public.claim_email_reconciliation(integer, integer) to service_role;
grant execute on function public.purge_email_provider_events(integer, integer) to service_role;
