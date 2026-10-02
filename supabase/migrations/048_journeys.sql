-- Journey Builder: tenant-owned journey definitions (graph of nodes + connections).
-- Definitions only; there is no execution runtime in this iteration.

create table if not exists public.journeys (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  name text not null check (char_length(btrim(name)) > 0),
  description text,
  status text not null default 'draft'
    check (status in ('draft', 'active', 'paused')),
  -- Incremented on every graph save; guards against concurrent overwrites and
  -- lets a future engine pin the definition version it evaluated.
  version integer not null default 1,
  activated_at timestamptz,
  created_by_id uuid references auth.users (id) on delete set null,
  last_modified_by_id uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists journeys_tenant_idx
  on public.journeys (tenant_id, updated_at desc);

create index if not exists journeys_status_idx
  on public.journeys (tenant_id, status);

create table if not exists public.journey_nodes (
  id uuid primary key,
  journey_id uuid not null references public.journeys (id) on delete cascade,
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  type text not null check (type in ('trigger', 'action', 'condition', 'ai')),
  name text not null default '',
  description text,
  position_x double precision not null default 0,
  position_y double precision not null default 0,
  -- Node-specific settings keyed by type; shape is owned by the app per node type.
  config jsonb not null default '{}'::jsonb check (jsonb_typeof(config) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (journey_id, id)
);

create index if not exists journey_nodes_journey_idx
  on public.journey_nodes (journey_id);

create table if not exists public.journey_connections (
  id uuid primary key,
  journey_id uuid not null references public.journeys (id) on delete cascade,
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  source_node_id uuid not null,
  target_node_id uuid not null,
  -- Named ports for future branching (e.g. condition "yes"/"no").
  source_handle text,
  target_handle text,
  config jsonb not null default '{}'::jsonb check (jsonb_typeof(config) = 'object'),
  created_at timestamptz not null default now(),
  check (source_node_id <> target_node_id),
  foreign key (journey_id, source_node_id)
    references public.journey_nodes (journey_id, id) on delete cascade,
  foreign key (journey_id, target_node_id)
    references public.journey_nodes (journey_id, id) on delete cascade
);

create unique index if not exists journey_connections_unique_link
  on public.journey_connections (
    journey_id, source_node_id, target_node_id,
    coalesce(source_handle, ''), coalesce(target_handle, '')
  );

create index if not exists journey_connections_journey_idx
  on public.journey_connections (journey_id);

drop trigger if exists journeys_updated_at on public.journeys;
create trigger journeys_updated_at
  before update on public.journeys
  for each row execute function public.set_updated_at();

drop trigger if exists journey_nodes_updated_at on public.journey_nodes;
create trigger journey_nodes_updated_at
  before update on public.journey_nodes
  for each row execute function public.set_updated_at();

alter table public.journeys enable row level security;
alter table public.journey_nodes enable row level security;
alter table public.journey_connections enable row level security;

drop policy if exists journeys_tenant_access on public.journeys;
drop policy if exists journey_nodes_tenant_access on public.journey_nodes;
drop policy if exists journey_connections_tenant_access on public.journey_connections;

create policy journeys_tenant_access on public.journeys
  for all using (
    public.is_platform_admin() or tenant_id in (select public.user_tenant_ids())
  );

create policy journey_nodes_tenant_access on public.journey_nodes
  for all using (
    public.is_platform_admin() or tenant_id in (select public.user_tenant_ids())
  );

create policy journey_connections_tenant_access on public.journey_connections
  for all using (
    public.is_platform_admin() or tenant_id in (select public.user_tenant_ids())
  );

-- Replace a journey's metadata and full graph in one transaction.
-- security invoker: RLS still decides which journeys the caller can touch.
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

  return v_version + 1;
end;
$$;

grant execute on function public.save_journey_graph(
  uuid, text, text, jsonb, jsonb, integer, uuid
) to authenticated;
