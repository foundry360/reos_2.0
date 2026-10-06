-- Email sent activity consistency (E.3d).
--
-- Invariant: every outbound email that reaches 'sent' and should carry an
-- "Email sent" activity (it has a contact and its purpose is marketing, as
-- Journey email is, or conversational, as CRM compose is) eventually has
-- exactly one. Appointment email (transactional / operational) never does.
--
-- - crm_emails.sent_activity_owed is set by a trigger in the same statement
--   that moves an email to 'sent', whichever path does it (send, webhook,
--   reconciliation), so an owed activity is always durably recorded.
-- - contact_activities.source_email_id names the email an activity is for;
--   a unique index makes a second activity for the same email impossible.
-- - ensure_email_sent_activity writes the owed activity under the email's row
--   lock and clears the flag. Repeating it changes nothing.
-- - repair_email_sent_activities writes owed activities in bounded batches.
--
-- No backfill: only emails recorded by the outbound ledger carry a purpose,
-- and those paths ship with this migration, so no earlier email is owed.

alter table public.crm_emails
  add column if not exists sent_activity_owed boolean not null default false;

comment on column public.crm_emails.sent_activity_owed is
  'True from the moment an email that should carry an "Email sent" activity becomes sent until that activity exists.';

create index if not exists crm_emails_sent_activity_owed_idx
  on public.crm_emails (id)
  where sent_activity_owed;

alter table public.contact_activities
  add column if not exists source_email_id uuid references public.crm_emails (id) on delete set null;

comment on column public.contact_activities.source_email_id is
  'The crm_emails row an "Email sent" activity records; at most one activity per email.';

create unique index if not exists contact_activities_source_email_key
  on public.contact_activities (source_email_id)
  where source_email_id is not null;

create or replace function public.crm_emails_owe_sent_activity()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.status = 'sent'
     and old.status is distinct from 'sent'
     and new.direction = 'outbound'
     and new.contact_id is not null
     and coalesce(new.metadata ->> 'purpose', '') in ('marketing', 'conversational') then
    new.sent_activity_owed := true;
  end if;
  return new;
end;
$$;

drop trigger if exists crm_emails_owe_sent_activity on public.crm_emails;
create trigger crm_emails_owe_sent_activity
  before update of status on public.crm_emails
  for each row execute function public.crm_emails_owe_sent_activity();

-- 'created' | 'exists' (an activity for this email was already there) |
-- 'not_owed' | 'missing'. Safe to call any number of times, concurrently.
create or replace function public.ensure_email_sent_activity(
  p_email_id uuid,
  p_tenant_id uuid
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email public.crm_emails%rowtype;
  v_activity uuid;
begin
  select * into v_email
    from public.crm_emails
   where id = p_email_id
     and tenant_id = p_tenant_id
   for update;
  if not found then
    return 'missing';
  end if;
  if not v_email.sent_activity_owed then
    return 'not_owed';
  end if;
  -- The contact was deleted after the email was sent: nothing to attach it to.
  if v_email.status <> 'sent' or v_email.contact_id is null then
    update public.crm_emails set sent_activity_owed = false where id = v_email.id;
    return 'not_owed';
  end if;

  insert into public.contact_activities (
    tenant_id, contact_id, activity_type, title, body, occurred_at,
    related_entity_type, related_entity_id, source_email_id)
  values (
    v_email.tenant_id, v_email.contact_id, 'email', 'Email sent: ' || coalesce(v_email.subject, ''),
    nullif(btrim(coalesce(v_email.snippet, '')), ''), now(),
    case when v_email.opportunity_id is not null then 'opportunity' end, v_email.opportunity_id, v_email.id)
  on conflict (source_email_id) where source_email_id is not null do nothing
  returning id into v_activity;

  update public.crm_emails set sent_activity_owed = false where id = v_email.id;
  return case when v_activity is null then 'exists' else 'created' end;
end;
$$;

-- Writes up to p_limit owed activities. Rows another repair holds are skipped;
-- one row's failure (rolled back to its savepoint) never stops the others and
-- leaves that row owed for the next run.
create or replace function public.repair_email_sent_activities(
  p_limit integer default 50
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row record;
  v_outcome text;
  v_checked integer := 0;
  v_created integer := 0;
  v_existing integer := 0;
  v_not_owed integer := 0;
  v_failed integer := 0;
begin
  for v_row in
    select e.id, e.tenant_id
      from public.crm_emails e
     where e.sent_activity_owed
     order by e.id
     limit greatest(least(p_limit, 500), 1)
     for update skip locked
  loop
    v_checked := v_checked + 1;
    begin
      v_outcome := public.ensure_email_sent_activity(v_row.id, v_row.tenant_id);
      if v_outcome = 'created' then
        v_created := v_created + 1;
      elsif v_outcome = 'exists' then
        v_existing := v_existing + 1;
      else
        v_not_owed := v_not_owed + 1;
      end if;
    exception when others then
      v_failed := v_failed + 1;
    end;
  end loop;
  return jsonb_build_object(
    'checked', v_checked, 'created', v_created, 'existing', v_existing,
    'notOwed', v_not_owed, 'failed', v_failed);
end;
$$;

-- Migration 066's function, with its activity insert replaced by
-- ensure_email_sent_activity in a savepoint: an activity that can't be written
-- no longer undoes the settlement; the email stays owed for repair.
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

  -- The email is sent now; write its activity if one is still owed.
  begin
    perform public.ensure_email_sent_activity(v_email.id, v_email.tenant_id);
  exception when others then
    raise warning 'Email sent activity left owed for repair (%)', sqlstate;
  end;

  v_result := case when v_transitioned or v_delivery_set then 'applied' else 'stale' end;
  update public.email_provider_events
     set result = v_result, processed_at = now(), tenant_id = v_email.tenant_id, email_id = v_email.id
   where id = v_event_id;
  return v_result;
end;
$$;

revoke all on function public.ensure_email_sent_activity(uuid, uuid) from public, anon, authenticated;
revoke all on function public.repair_email_sent_activities(integer) from public, anon, authenticated;
grant execute on function public.ensure_email_sent_activity(uuid, uuid) to service_role;
grant execute on function public.repair_email_sent_activities(integer) to service_role;
