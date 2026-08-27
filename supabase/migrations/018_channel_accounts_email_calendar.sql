-- Allow email and calendar as connectable channel types

alter table public.channel_accounts
  drop constraint if exists channel_accounts_channel_check;

alter table public.channel_accounts
  add constraint channel_accounts_channel_check
  check (channel in ('messenger', 'instagram', 'email', 'calendar'));
