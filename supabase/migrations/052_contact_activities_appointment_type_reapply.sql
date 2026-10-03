-- 038 never took effect in production: AI-booked appointments were rejected by the
-- old activity_type check. Re-apply it.
alter table public.contact_activities
  drop constraint if exists contact_activities_activity_type_check;

alter table public.contact_activities
  add constraint contact_activities_activity_type_check
  check (
    activity_type in (
      'note',
      'call',
      'email',
      'meeting',
      'other',
      'opportunity',
      'contact',
      'appointment'
    )
  );
