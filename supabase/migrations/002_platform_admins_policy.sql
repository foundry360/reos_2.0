-- Allow authenticated users to check their own platform admin status
create policy platform_admins_self_select on public.platform_admins
  for select using (user_id = auth.uid());
