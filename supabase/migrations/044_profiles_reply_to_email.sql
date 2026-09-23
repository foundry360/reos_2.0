-- Optional per-user reply-to override for CRM outbound email.
-- Null / empty means use the user's login email.

alter table public.profiles
  add column if not exists reply_to_email text;
