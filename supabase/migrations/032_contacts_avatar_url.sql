-- Profile photo URL for Messenger / Instagram contacts

alter table public.contacts
  add column if not exists avatar_url text;
