-- An AI step starts at most one journey per run, whichever journey the model picks.
--
-- A child's run key is journey.started:<parent run id>:<node id>:<target journey id>
-- (unique per tenant, migration 054), so the database already prevents two
-- children of one step for the same target. An AI step may pick any journey
-- from its list, so two overlapping passes of the same step (a stalled pass
-- whose lease expired, and the pass that took over) could each pick a
-- different one and both insert. This index makes the second insert fail: an
-- AI-requested child's run key without its last segment (the target) is the
-- AI step's identity, journey.started:<parent run id>:<node id>, and only one
-- run per tenant may have it. The engine then finds the existing child by
-- its run key and reports it as the step's child.
--
-- Only runs the engine started for an AI step (trigger_payload.requested_by =
-- 'ai_step', written by the engine, never by a request) are covered. Start
-- journey and Start journeys children keep one child per target, so a fan-out
-- step still starts several. Every status counts: a finished child still
-- belongs to its step, so a retry never starts another.

create unique index if not exists journey_runs_one_child_per_ai_step_idx
  on public.journey_runs (tenant_id, (regexp_replace(idempotency_key, ':[^:]*$', '')))
  where trigger_event = 'journey.started'
    and trigger_payload ->> 'requested_by' = 'ai_step';
