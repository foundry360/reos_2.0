# REOS 2.0 — Architecture

Real Estate Operating System: conversational AI + simple CRM on **Vercel** and **Supabase**. Payments stay in **GHL + Stripe Connect** (separate, no sync).

Legacy Salesforce scaffold lives in [`legacy/salesforce/`](../legacy/salesforce/) — not used in 2.0.

## Overview

| Layer | Platform | Role |
|---|---|---|
| **CRM + UI** | Next.js on Vercel | Tenant inbox, pipeline, admin portal |
| **Auth + data** | Supabase | Postgres, Auth, RLS, Storage |
| **Conversational AI** | Agent service (same Vercel app) | Concierge, Scheduler, Follow-Up |
| **Automation agents** | Vercel Cron / job queue (later) | Intake, Researcher, Compliance, Scout |
| **Channels** | Twilio (+ Meta later) | SMS inbound/outbound |
| **Payments** | GHL + Stripe Connect | Setup fee; manual tenant creation in admin |

Tenants are **brokerage accounts** in Supabase, created manually in the admin portal after payment.

## Two portals

| Portal | Users | Purpose |
|---|---|---|
| **Admin** (`/admin`) | Platform ops | Onboarding, account setup, connections, maintenance |
| **App** (`/`) | Brokerage team | Inbox, pipeline, contacts — work only, no setup |

See [`docs/ADMIN.md`](ADMIN.md) for the GHL subaccount model.

## Request flow — inbound SMS

```text
POST /api/webhooks/twilio
  → resolve tenant (To number → tenant_phone_numbers)
  → resolve or create contact (Intake: phone → contact_identities)
  → runInboundAgent (compliance → coordinator → OpenAI → CRM tools)
  → Supabase (contacts + messages)
  → TwiML SMS reply
```

## Request flow — inbound Messenger / Instagram

```text
POST /api/webhooks/meta
  → verify signature
  → resolve tenant (page / IG account → channel_accounts)
  → resolve or create contact (PSID → contact_identities)
  → outbound echo: store only (dedupe agent/UI sends)
  → inbound: runInboundAgent (same playbooks as SMS)
  → Graph API send reply
```

## Agent layer

Seven roles — see [`docs/AGENTS.md`](AGENTS.md).

- **Coordinator** (code): routes by `opted_out` / `handoff` / `ready_to_book` / `appt_booked` / temperature (see [`docs/AGENTS.md`](AGENTS.md))
- **Concierge / Scheduler / Follow-Up** (LLM): chat only
- **Intake / Researcher / Compliance / Scout** (jobs): no chat (Compliance may send one-shot legal replies)

## Data model (Supabase)

Core tables: `tenants`, `memberships`, `platform_admins`, `contacts`, `contact_identities`, `messages`, `tenant_phone_numbers`, `tenant_agents`, `channel_accounts`.

Migration: [`supabase/migrations/001_initial_schema.sql`](../supabase/migrations/001_initial_schema.sql)

## Deployment

| Service | Host |
|---|---|
| Web + agents + webhooks | Vercel — root `apps/agent-service` |
| Database + auth | Supabase project (you create) |
| Conversation state | `messages` table (+ optional Redis later) |

## Related

- Agent roles: [`docs/AGENTS.md`](AGENTS.md)
- Supabase setup: [`docs/SETUP.md`](SETUP.md)
- Legacy GHL product: [foundry360/REOS](https://github.com/foundry360/REOS)
