-- A contact has at most one active run of a journey. The runtime checks for an
-- active run before inserting one, but two events dispatched at the same moment
-- can both pass that check; this index makes the database reject the second
-- insert. Finished runs (completed, failed, cancelled) are not covered, so a
-- contact can go through a journey again once its previous run has ended.
-- The statuses must match the runtime's active set (hasActiveRun).

create unique index if not exists journey_runs_one_active_per_contact_idx
  on public.journey_runs (tenant_id, journey_id, contact_id)
  where contact_id is not null
    and status in ('running', 'waiting', 'paused');
