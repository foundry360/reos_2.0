-- Journey runtime: immutable version snapshots, runs, and per-step execution history.
--
-- journey_nodes / journey_connections stay the editable working copy. Every save
-- (and activation) freezes the graph into journey_versions; runs execute against
-- the snapshot for the version they started on, so later edits never change them.
-- Runs and steps are written by the server runtime (service role); members can read.

create table if not exists public.journey_versions (
  id uuid primary key default gen_random_uuid(),
  journey_id uuid not null references public.journeys (id) on delete cascade,
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  version integer not null,
  -- { nodes: [{ id, type, name, description, config }], connections: [{ id, sourceNodeId, targetNodeId, sourceHandle, targetHandle }] }
  graph jsonb not null check (jsonb_typeof(graph) = 'object'),
  -- Trigger events this version listens for; lets the dispatcher filter candidates in SQL.
  trigger_events text[] not null default '{}',
  created_at timestamptz not null default now(),
  unique (journey_id, version)
);

create index if not exists journey_versions_trigger_events_idx
  on public.journey_versions using gin (trigger_events);

alter table public.journey_versions enable row level security;

drop policy if exists journey_versions_tenant_read on public.journey_versions;
drop policy if exists journey_versions_tenant_insert on public.journey_versions;

create policy journey_versions_tenant_read on public.journey_versions
  for select using (
    public.is_platform_admin() or tenant_id in (select public.user_tenant_ids())
  );

-- Insert only (no update/delete policy): snapshots are immutable once written.
create policy journey_versions_tenant_insert on public.journey_versions
  for insert with check (
    public.is_platform_admin() or tenant_id in (select public.user_tenant_ids())
  );

-- Freeze the journey's current graph as its current version. Idempotent.
create or replace function public.snapshot_journey_version(p_journey_id uuid)
returns integer
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_tenant_id uuid;
  v_version integer;
begin
  -- Share lock blocks a concurrent save_journey_graph from changing the graph mid-snapshot.
  select tenant_id, version
    into v_tenant_id, v_version
    from public.journeys
   where id = p_journey_id
   for share;

  if v_tenant_id is null then
    raise exception 'journey_not_found' using errcode = 'P0002';
  end if;

  insert into public.journey_versions (journey_id, tenant_id, version, graph, trigger_events)
  select
    p_journey_id,
    v_tenant_id,
    v_version,
    jsonb_build_object(
      'nodes', coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'id', n.id,
            'type', n.type,
            'name', n.name,
            'description', coalesce(n.description, ''),
            'config', n.config
          ) order by n.created_at, n.id)
        from public.journey_nodes n
        where n.journey_id = p_journey_id
      ), '[]'::jsonb),
      'connections', coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'id', c.id,
            'sourceNodeId', c.source_node_id,
            'targetNodeId', c.target_node_id,
            'sourceHandle', c.source_handle,
            'targetHandle', c.target_handle
          ) order by c.created_at, c.id)
        from public.journey_connections c
        where c.journey_id = p_journey_id
      ), '[]'::jsonb)
    ),
    coalesce((
      select array_agg(distinct n.config ->> 'event')
      from public.journey_nodes n
      where n.journey_id = p_journey_id
        and n.type = 'trigger'
        and coalesce(n.config ->> 'event', '') <> ''
    ), '{}')
  on conflict (journey_id, version) do nothing;

  return v_version;
end;
$$;

grant execute on function public.snapshot_journey_version(uuid) to authenticated;

-- Same as 048, plus a snapshot of the version it just wrote.
create or replace function public.save_journey_graph(
  p_journey_id uuid,
  p_name text,
  p_description text,
  p_nodes jsonb,
  p_connections jsonb,
  p_expected_version integer default null,
  p_modified_by_id uuid default null
)
returns integer
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_tenant_id uuid;
  v_version integer;
begin
  select tenant_id, version
    into v_tenant_id, v_version
    from public.journeys
   where id = p_journey_id
   for update;

  if v_tenant_id is null then
    raise exception 'journey_not_found' using errcode = 'P0002';
  end if;

  if p_expected_version is not null and p_expected_version <> v_version then
    raise exception 'journey_version_conflict' using errcode = 'P0001';
  end if;

  update public.journeys
     set name = btrim(p_name),
         description = nullif(btrim(coalesce(p_description, '')), ''),
         version = v_version + 1,
         last_modified_by_id = coalesce(p_modified_by_id, last_modified_by_id)
   where id = p_journey_id;

  delete from public.journey_connections where journey_id = p_journey_id;

  delete from public.journey_nodes
   where journey_id = p_journey_id
     and id not in (
       select (node ->> 'id')::uuid from jsonb_array_elements(coalesce(p_nodes, '[]'::jsonb)) node
     );

  insert into public.journey_nodes (
    id, journey_id, tenant_id, type, name, description, position_x, position_y, config
  )
  select
    (node ->> 'id')::uuid,
    p_journey_id,
    v_tenant_id,
    node ->> 'type',
    coalesce(node ->> 'name', ''),
    nullif(node ->> 'description', ''),
    coalesce((node ->> 'position_x')::double precision, 0),
    coalesce((node ->> 'position_y')::double precision, 0),
    coalesce(node -> 'config', '{}'::jsonb)
  from jsonb_array_elements(coalesce(p_nodes, '[]'::jsonb)) node
  on conflict (id) do update
    set type = excluded.type,
        name = excluded.name,
        description = excluded.description,
        position_x = excluded.position_x,
        position_y = excluded.position_y,
        config = excluded.config
    where public.journey_nodes.journey_id = excluded.journey_id;

  insert into public.journey_connections (
    id, journey_id, tenant_id, source_node_id, target_node_id,
    source_handle, target_handle, config
  )
  select
    (conn ->> 'id')::uuid,
    p_journey_id,
    v_tenant_id,
    (conn ->> 'source_node_id')::uuid,
    (conn ->> 'target_node_id')::uuid,
    nullif(conn ->> 'source_handle', ''),
    nullif(conn ->> 'target_handle', ''),
    coalesce(conn -> 'config', '{}'::jsonb)
  from jsonb_array_elements(coalesce(p_connections, '[]'::jsonb)) conn;

  perform public.snapshot_journey_version(p_journey_id);

  return v_version + 1;
end;
$$;

grant execute on function public.save_journey_graph(
  uuid, text, text, jsonb, jsonb, integer, uuid
) to authenticated;

-- Existing journeys get a snapshot of their current version.
select public.snapshot_journey_version(id) from public.journeys;

create table if not exists public.journey_runs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  journey_id uuid not null references public.journeys (id) on delete cascade,
  journey_version integer not null,
  -- The lead/contact the run is about. Nullable so non-contact entities can run later.
  contact_id uuid references public.contacts (id) on delete set null,
  -- The record that triggered the run (contact, message, appointment, task).
  entity_type text not null,
  entity_id uuid,
  status text not null default 'running'
    check (status in ('running', 'waiting', 'completed', 'failed', 'cancelled', 'paused')),
  current_node_id uuid,
  trigger_event text not null,
  trigger_payload jsonb not null default '{}'::jsonb check (jsonb_typeof(trigger_payload) = 'object'),
  -- One run per (event occurrence, journey, version); a redelivered event hits this and is skipped.
  idempotency_key text not null,
  -- Step outputs and runtime bookkeeping (waiting step, retry attempts).
  context jsonb not null default '{}'::jsonb check (jsonb_typeof(context) = 'object'),
  error text,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  paused_at timestamptz,
  -- When the worker should pick the run up (wait finished, retry due, or abandoned inline run).
  resume_at timestamptz,
  -- Short lease so two workers never execute the same run at once.
  locked_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, idempotency_key),
  foreign key (journey_id, journey_version)
    references public.journey_versions (journey_id, version) on delete cascade
);

create index if not exists journey_runs_journey_idx
  on public.journey_runs (tenant_id, journey_id, created_at desc);

create index if not exists journey_runs_contact_idx
  on public.journey_runs (contact_id);

create index if not exists journey_runs_due_idx
  on public.journey_runs (resume_at)
  where status in ('running', 'waiting');

drop trigger if exists journey_runs_updated_at on public.journey_runs;
create trigger journey_runs_updated_at
  before update on public.journey_runs
  for each row execute function public.set_updated_at();

create table if not exists public.journey_run_steps (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  run_id uuid not null references public.journey_runs (id) on delete cascade,
  node_id uuid not null,
  node_type text not null,
  node_name text not null default '',
  status text not null default 'pending'
    check (status in ('pending', 'running', 'completed', 'failed', 'skipped')),
  input jsonb not null default '{}'::jsonb,
  output jsonb not null default '{}'::jsonb,
  error text,
  -- 'transient' (retried) or 'config' (not retried).
  error_kind text check (error_kind in ('transient', 'config')),
  attempt_count integer not null default 1,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists journey_run_steps_run_idx
  on public.journey_run_steps (run_id, created_at);

alter table public.journey_runs enable row level security;
alter table public.journey_run_steps enable row level security;

drop policy if exists journey_runs_tenant_read on public.journey_runs;
drop policy if exists journey_run_steps_tenant_read on public.journey_run_steps;

create policy journey_runs_tenant_read on public.journey_runs
  for select using (
    public.is_platform_admin() or tenant_id in (select public.user_tenant_ids())
  );

create policy journey_run_steps_tenant_read on public.journey_run_steps
  for select using (
    public.is_platform_admin() or tenant_id in (select public.user_tenant_ids())
  );
