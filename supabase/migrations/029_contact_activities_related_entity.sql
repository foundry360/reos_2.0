-- Link recent activities back to related CRM records

alter table public.contact_activities
  add column if not exists related_entity_type text
    check (
      related_entity_type is null
      or related_entity_type in ('contact', 'lead', 'opportunity', 'task')
    );

alter table public.contact_activities
  add column if not exists related_entity_id uuid;
