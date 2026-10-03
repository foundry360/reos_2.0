-- Lead agent v2: remember what the agent did each turn (tool calls + results) so the
-- next turn knows which times it offered, what it booked, and what failed.
create table if not exists public.agent_turns (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  contact_id uuid references public.contacts (id) on delete cascade,
  model text,
  reply text,
  tool_events jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists agent_turns_contact_idx on public.agent_turns (contact_id, created_at desc);

alter table public.agent_turns enable row level security;

drop policy if exists agent_turns_tenant_access on public.agent_turns;
create policy agent_turns_tenant_access on public.agent_turns
  for select using (
    public.is_platform_admin() or tenant_id in (select public.user_tenant_ids())
  );

-- 1 = routed concierge/scheduler/follow-up playbooks, 2 = single lead agent.
alter table public.tenants
  add column if not exists agent_version smallint not null default 1;
