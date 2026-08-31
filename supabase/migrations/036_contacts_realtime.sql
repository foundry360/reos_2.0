-- Live CRM field updates for Additional Info / Score cards while agents write.

do $$
begin
  alter publication supabase_realtime add table public.contacts;
exception
  when duplicate_object then null;
end $$;

alter table public.contacts replica identity full;
