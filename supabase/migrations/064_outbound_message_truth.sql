-- Outbound message truth and automated email unsubscribe.
--
-- messages.send_status records what the provider said about an outbound message:
--   pending  the row was written before the provider call; no outcome recorded yet
--            (a crash or a lost update leaves it here; it was never confirmed sent)
--   sent     the provider accepted it (accepted, not delivered)
--   failed   the provider rejected it; it was not sent
--   unknown  the provider call failed in a way that leaves open whether it was sent
--            (timeout, network error, 5xx); never retried automatically
-- null is every inbound row and every outbound row written before this migration.
--
-- messages.idempotency_key makes a logical send (a journey step) one row per
-- tenant: a retry finds the earlier attempt instead of sending again.
--
-- contacts.email_unsubscribed_at is set by the unsubscribe link in automated
-- (journey) email; automated email is not sent while it is set.

alter table public.messages
  add column if not exists send_status text,
  add column if not exists send_error text,
  add column if not exists idempotency_key text;

alter table public.messages
  drop constraint if exists messages_send_status_check;
alter table public.messages
  add constraint messages_send_status_check
  check (
    send_status is null
    or (direction = 'outbound' and send_status in ('pending', 'sent', 'failed', 'unknown'))
  ) not valid;
alter table public.messages validate constraint messages_send_status_check;

create unique index if not exists messages_idempotency_key_key
  on public.messages (tenant_id, idempotency_key)
  where idempotency_key is not null;

alter table public.contacts
  add column if not exists email_unsubscribed_at timestamptz;
