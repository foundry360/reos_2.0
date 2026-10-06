-- Appointment email outbound truth (E.2).
--
-- crm_emails becomes the durable record of appointment invite, reschedule and
-- cancellation email: the row is written as 'pending' before the provider call,
-- then settles to 'sent' (with the provider id), 'failed' (the provider
-- rejected it; safe to retry) or 'unknown' (the provider may have sent it;
-- never resent automatically). idempotency_key is the stable identity of one
-- appointment email, e.g. appointment:<id>:invite:0:lead.
--
-- Additive and idempotent. Existing rows keep their status; nothing is backfilled.
-- Preflight: the status check is the one migration 039 created inline, which
-- Postgres names crm_emails_status_check.

alter table public.crm_emails
  add column if not exists send_error text,
  add column if not exists idempotency_key text;

alter table public.crm_emails drop constraint if exists crm_emails_status_check;
alter table public.crm_emails
  add constraint crm_emails_status_check
  check (status in ('draft', 'queued', 'pending', 'sent', 'failed', 'unknown', 'received'));

create unique index if not exists crm_emails_tenant_idempotency_key
  on public.crm_emails (tenant_id, idempotency_key)
  where idempotency_key is not null;

comment on column public.crm_emails.idempotency_key is
  'Stable identity of one outbound email operation (appointment:<id>:<invite|reschedule|cancellation>:<sequence>:<lead|agent>). Unique per tenant.';
comment on column public.crm_emails.send_error is
  'Why an outbound email is failed or unknown, or why a sent email has no provider id.';
