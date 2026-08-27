-- Platform-level integration secrets (admin portal only; not per-tenant)

create table if not exists public.platform_secrets (
  key text primary key check (
    key in (
      'openai_api_key',
      'twilio_account_sid',
      'twilio_auth_token'
    )
  ),
  ciphertext text not null,
  iv text not null,
  auth_tag text not null,
  hint text,
  updated_at timestamptz not null default now(),
  updated_by_id uuid references auth.users (id) on delete set null
);

alter table public.platform_secrets enable row level security;

create policy platform_secrets_admin_all on public.platform_secrets
  for all using (public.is_platform_admin());
