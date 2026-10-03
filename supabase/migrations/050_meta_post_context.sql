-- Property context for Facebook / Instagram post comments.

-- One row per post we have looked up; popular listings get many comments, so the
-- caption fetch + property extraction runs once per post.
create table if not exists public.meta_posts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  platform text not null check (platform in ('facebook', 'instagram')),
  post_id text not null,
  caption text,
  permalink text,
  is_listing boolean not null default false,
  property jsonb,
  property_summary text,
  fetched_at timestamptz not null default now(),
  unique (platform, post_id)
);

create index if not exists meta_posts_tenant_idx on public.meta_posts (tenant_id, fetched_at desc);

alter table public.meta_posts enable row level security;

drop policy if exists meta_posts_tenant_access on public.meta_posts;
create policy meta_posts_tenant_access on public.meta_posts
  for select using (
    public.is_platform_admin() or tenant_id in (select public.user_tenant_ids())
  );

alter table public.meta_comment_events
  add column if not exists property_summary text;

-- Short label shown above a message in the thread (e.g. which property a comment was on).
alter table public.messages
  add column if not exists context_label text;
