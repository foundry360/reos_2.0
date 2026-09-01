-- Ensure one channel sender cannot attach to two contacts.
-- Initial schema already has unique (channel, external_id); this is idempotent for older envs.
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'contact_identities_channel_external_id_key'
      and conrelid = 'public.contact_identities'::regclass
  ) and not exists (
    select 1
    from pg_indexes
    where schemaname = 'public'
      and tablename = 'contact_identities'
      and indexdef ilike '%unique%(%channel%, %external_id%)'
  ) then
    alter table public.contact_identities
      add constraint contact_identities_channel_external_id_key
      unique (channel, external_id);
  end if;
exception
  when duplicate_object then null;
  when unique_violation then null;
end $$;
