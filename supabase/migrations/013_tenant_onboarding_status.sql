-- Align tenant status values with onboarding chevron stages.

alter table public.tenants
  drop constraint if exists tenants_status_check;

update public.tenants
set status = 'company_info'
where status = 'pending';

alter table public.tenants
  alter column status set default 'company_info';

alter table public.tenants
  add constraint tenants_status_check
  check (
    status in (
      'company_info',
      'billing',
      'agents',
      'connected_accounts',
      'testing',
      'active',
      'paused'
    )
  );
