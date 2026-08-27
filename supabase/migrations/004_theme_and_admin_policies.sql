-- Theme preference on profiles + platform admin management policies

alter table public.profiles
  add column if not exists theme_preference text not null default 'system'
    check (theme_preference in ('light', 'dark', 'system'));

-- Platform admins can list all admins (for user management UI)
create policy platform_admins_admin_select on public.platform_admins
  for select using (public.is_platform_admin());

-- Platform admins can grant admin access to others
create policy platform_admins_admin_insert on public.platform_admins
  for insert with check (public.is_platform_admin());
