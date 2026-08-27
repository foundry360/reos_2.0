-- Optional phone number on user profiles (admin-managed on account detail)

alter table public.profiles
  add column if not exists phone text;

drop policy if exists profiles_platform_admin_update on public.profiles;

create policy profiles_platform_admin_update on public.profiles
  for update using (public.is_platform_admin());
