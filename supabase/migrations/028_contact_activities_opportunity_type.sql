-- System-logged contact + opportunity events on contact activities

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
      'contact'
    )
  );
