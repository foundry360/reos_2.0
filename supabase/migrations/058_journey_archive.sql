-- Journey archive and safe deletion.
--
-- 1. Journeys can be archived: they never run again but keep their canvas,
--    versions, runs, and step history. Restore returns them to draft.
-- 2. Deleting a journey no longer erases its run history. Runs referenced the
--    journey (and their pinned version) with ON DELETE CASCADE, so deleting a
--    journey silently deleted every run and step. Both references become
--    NO ACTION: a journey (or a version) with any run can't be deleted.
--    NO ACTION, not RESTRICT, because it is checked at the end of the statement:
--    deleting a tenant still works, since that one statement also cascades the
--    tenant's runs (journey_runs.tenant_id ON DELETE CASCADE).
--
-- Unchanged: journey_versions -> journeys (CASCADE, so a never-run journey
-- deletes with its snapshots), journey_run_steps -> journey_runs (CASCADE),
-- RLS policies, and indexes.
--
-- The constraint names are Postgres's defaults for the definitions in
-- migrations 048 and 054. They are dropped without IF EXISTS on purpose: if a
-- name doesn't match, the migration fails instead of leaving the cascade.
-- Each drop and re-add is one ALTER TABLE statement, so it is atomic.

alter table public.journeys
  drop constraint journeys_status_check,
  add constraint journeys_status_check
    check (status in ('draft', 'active', 'paused', 'archived'));

alter table public.journey_runs
  drop constraint journey_runs_journey_id_fkey,
  add constraint journey_runs_journey_id_fkey
    foreign key (journey_id) references public.journeys (id) on delete no action;

alter table public.journey_runs
  drop constraint journey_runs_journey_id_journey_version_fkey,
  add constraint journey_runs_journey_id_journey_version_fkey
    foreign key (journey_id, journey_version)
    references public.journey_versions (journey_id, version) on delete no action;
