-- Enable live message inserts for the CRM messaging UI (Supabase Realtime).

do $$
begin
  alter publication supabase_realtime add table public.messages;
exception
  when duplicate_object then null;
end $$;

-- Helpful for UPDATE/DELETE payloads later; INSERT works either way.
alter table public.messages replica identity full;
