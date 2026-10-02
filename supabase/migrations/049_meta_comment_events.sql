-- Facebook Page / Instagram post comments → contacts (+ conversation agent on questions).

-- Commenters get their own identity channels: the id Meta sends with a comment is not
-- guaranteed to match the Messenger PSID / Instagram IGSID used for DMs.
alter table public.contact_identities
  drop constraint if exists contact_identities_channel_check;

alter table public.contact_identities
  add constraint contact_identities_channel_check
  check (channel in ('sms', 'messenger', 'instagram', 'facebook_comment', 'instagram_comment'));

-- One row per received comment. Unique comment id makes webhook retries idempotent.
create table if not exists public.meta_comment_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  contact_id uuid references public.contacts (id) on delete set null,
  message_id uuid references public.messages (id) on delete set null,
  platform text not null check (platform in ('facebook', 'instagram')),
  account_id text not null,
  comment_id text not null,
  post_id text,
  parent_comment_id text,
  commenter_id text not null,
  commenter_name text,
  body text not null default '',
  is_question boolean not null default false,
  agent_status text not null default 'pending'
    check (agent_status in ('pending', 'skipped', 'replied', 'no_reply', 'failed')),
  agent_detail text,
  created_at timestamptz not null default now(),
  unique (platform, comment_id)
);

create index if not exists meta_comment_events_tenant_idx
  on public.meta_comment_events (tenant_id, created_at desc);

create index if not exists meta_comment_events_contact_idx
  on public.meta_comment_events (contact_id, created_at desc);

alter table public.meta_comment_events enable row level security;

drop policy if exists meta_comment_events_tenant_access on public.meta_comment_events;
create policy meta_comment_events_tenant_access on public.meta_comment_events
  for select using (
    public.is_platform_admin() or tenant_id in (select public.user_tenant_ids())
  );
