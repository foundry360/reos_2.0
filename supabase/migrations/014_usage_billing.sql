-- Usage ledger and billing cycles for tenant usage wallet + Stripe collection

create table if not exists public.usage_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  category text not null check (
    category in ('twilio_sms', 'twilio_number', 'ai_tokens', 'other')
  ),
  quantity numeric not null default 1,
  unit text not null,
  billable_amount_cents integer not null check (billable_amount_cents >= 0),
  currency text not null default 'usd',
  reference_id text,
  metadata jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create unique index if not exists usage_events_reference_unique
  on public.usage_events (category, reference_id)
  where reference_id is not null;

create index if not exists usage_events_tenant_occurred_idx
  on public.usage_events (tenant_id, occurred_at desc);

create index if not exists usage_events_occurred_idx
  on public.usage_events (occurred_at desc);

create table if not exists public.billing_cycles (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  period_start date not null,
  period_end date not null,
  status text not null default 'open'
    check (status in ('open', 'closing', 'invoiced', 'paid', 'failed')),
  subtotal_cents integer not null default 0 check (subtotal_cents >= 0),
  stripe_invoice_id text,
  stripe_payment_intent_id text,
  closed_at timestamptz,
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  unique (tenant_id, period_start)
);

create index if not exists billing_cycles_tenant_status_idx
  on public.billing_cycles (tenant_id, status);

alter table public.usage_events enable row level security;
alter table public.billing_cycles enable row level security;

create policy usage_events_admin_all on public.usage_events
  for all using (public.is_platform_admin());

create policy billing_cycles_admin_all on public.billing_cycles
  for all using (public.is_platform_admin());
