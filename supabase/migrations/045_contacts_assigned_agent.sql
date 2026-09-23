-- Assigned agent on leads/contacts (carried to opportunities on create).

alter table public.contacts
  add column if not exists assigned_agent_id uuid;

create index if not exists contacts_assigned_agent_idx
  on public.contacts (tenant_id, assigned_agent_id)
  where assigned_agent_id is not null;
