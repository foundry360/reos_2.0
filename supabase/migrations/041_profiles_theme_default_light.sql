-- Default new profiles to light theme (users can switch in Settings).
alter table public.profiles
  alter column theme_preference set default 'light';
