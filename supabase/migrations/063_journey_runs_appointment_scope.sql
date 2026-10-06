-- Appointment-triggered runs are scoped to their appointment, not the contact.
--
-- Migration 056 allowed one active run per (tenant, journey, contact). A
-- journey triggered by appointment events therefore dropped the second
-- appointment's run while the first appointment's run was still waiting.
--
-- The scope of a run is decided by the event that created it:
--   appointment-scoped: entity_type = 'appointment' (entity_id is the
--     appointment). One active run per (tenant, journey, appointment).
--   contact-scoped: every other run (contact, message, task, opportunity,
--     manual, journey.started). One active run per (tenant, journey, contact),
--     exactly as in 056.
-- An appointment run and a contact run of the same journey and contact are
-- different scopes and can both be active.
--
-- The statuses must match the runtime's active set (hasActiveRun).
--
-- Production preflight (read-only; both must return no rows):
--   select tenant_id, journey_id, entity_id, count(*) from public.journey_runs
--    where entity_type = 'appointment' and status in ('running', 'waiting', 'paused')
--    group by 1, 2, 3 having count(*) > 1;
--   select id from public.journey_runs where entity_type = 'appointment' and entity_id is null;
-- The block below runs the same checks and stops the migration before any change.

do $$
begin
  if exists (select 1 from public.journey_runs where entity_type = 'appointment' and entity_id is null) then
    raise exception 'journey_runs has appointment runs without entity_id; resolve them before applying 063';
  end if;
  if exists (
    select 1 from public.journey_runs
     where entity_type = 'appointment' and status in ('running', 'waiting', 'paused')
     group by tenant_id, journey_id, entity_id
    having count(*) > 1
  ) then
    raise exception 'journey_runs has more than one active run for an appointment; resolve them before applying 063';
  end if;
end $$;

-- An appointment run always names its appointment, so it is always covered by
-- the appointment index below.
alter table public.journey_runs
  drop constraint if exists journey_runs_appointment_entity_id_check;
alter table public.journey_runs
  add constraint journey_runs_appointment_entity_id_check
  check (entity_type <> 'appointment' or entity_id is not null);

create unique index if not exists journey_runs_one_active_per_contact_scope_idx
  on public.journey_runs (tenant_id, journey_id, contact_id)
  where contact_id is not null
    and entity_type <> 'appointment'
    and status in ('running', 'waiting', 'paused');

create unique index if not exists journey_runs_one_active_per_appointment_idx
  on public.journey_runs (tenant_id, journey_id, entity_id)
  where entity_type = 'appointment'
    and status in ('running', 'waiting', 'paused');

-- Created after the two indexes above so the table is never unguarded.
drop index if exists public.journey_runs_one_active_per_contact_idx;
