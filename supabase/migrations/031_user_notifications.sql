-- In-app notifications + per-user preferences

create table if not exists public.notification_preferences (
  user_id uuid primary key references auth.users (id) on delete cascade,
  tasks_in_app boolean not null default true,
  leads_in_app boolean not null default true,
  opportunities_in_app boolean not null default true,
  messages_in_app boolean not null default true,
  system_in_app boolean not null default true,
  updated_at timestamptz not null default now()
);

create table if not exists public.user_notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  tenant_id uuid references public.tenants (id) on delete cascade,
  category text not null
    check (category in ('tasks', 'leads', 'opportunities', 'messages', 'system')),
  title text not null,
  body text,
  href text,
  read_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists user_notifications_user_created_idx
  on public.user_notifications (user_id, created_at desc);

create index if not exists user_notifications_user_unread_idx
  on public.user_notifications (user_id)
  where read_at is null;

drop trigger if exists notification_preferences_set_updated_at on public.notification_preferences;
create trigger notification_preferences_set_updated_at
  before update on public.notification_preferences
  for each row execute function public.set_updated_at();

alter table public.notification_preferences enable row level security;
alter table public.user_notifications enable row level security;

create policy notification_preferences_own on public.notification_preferences
  for all using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy user_notifications_select_own on public.user_notifications
  for select using (user_id = auth.uid());

create policy user_notifications_update_own on public.user_notifications
  for update using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy user_notifications_delete_own on public.user_notifications
  for delete using (user_id = auth.uid());

-- Inserts typically come from service role / trusted server; allow own insert for future client flows.
create policy user_notifications_insert_own on public.user_notifications
  for insert with check (user_id = auth.uid());
