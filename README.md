# REOS 2.0

Real Estate Operating System — conversational AI agents + simple CRM on **Vercel** and **Supabase**.

Payments stay in **GHL + Stripe Connect** (separate; tenants created manually in admin after setup fee).

## Architecture

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

```text
Lead (SMS) → Vercel webhooks → OpenAI agents → Supabase
Broker UI  → React app (tenant) + Admin portal (platform)
GHL payments → Stripe (no integration with this repo)
```

## Repo layout

| Path | Purpose |
|---|---|
| [`apps/agent-service/`](apps/agent-service/) | Next.js on Vercel — webhooks, agents, UI (growing) |
| [`supabase/migrations/`](supabase/migrations/) | Postgres schema |
| [`docs/`](docs/) | Architecture, agents, setup, admin |
| [`legacy/salesforce/`](legacy/salesforce/) | Deprecated SF scaffold (pre–2.0 pivot) |

## Quick start

1. **Create Supabase project** and run [`supabase/migrations/001_initial_schema.sql`](supabase/migrations/001_initial_schema.sql).
2. **Configure env:**

```bash
cd apps/agent-service
cp .env.example .env.local
# Fill OPENAI_API_KEY, Twilio, Supabase keys — see docs/SETUP.md
npm install
npm run dev
```

3. **Seed a tenant** (SQL in [`docs/SETUP.md`](docs/SETUP.md)) and point Twilio at `POST /api/webhooks/twilio`.

Health: `http://localhost:3000/api/health`

## Vercel deploy

Same Vercel project as before — root directory **`apps/agent-service`**.

Add environment variables from `.env.example`. Redeploy after Supabase is wired.

## Milestone 1 — Hello tenant

- [x] Supabase schema (tenants, contacts, messages, agent config)
- [x] Supabase project wired (`dfdimmmturnaxkysozkz`)
- [x] Twilio webhook → Coordinator → Concierge → Supabase writes
- [x] Inline Compliance (STOP keywords)
- [x] Demo tenant seeded (`demo-realty`)
- [ ] Assign real Twilio number to tenant (deferred)
- [ ] End-to-end live SMS test (after number)

## Milestone 2 — Portals

- [x] Supabase Auth + split-screen login (`/login`)
- [x] Admin shell: sidebar, header, logo, avatar menu
- [x] Admin: account list, new account + owner invite, account detail
- [x] Impersonate tenant from admin (`Open account`)
- [ ] Run migration `002_platform_admins_policy.sql` if not done
- [ ] Add your user to `platform_admins`
- [ ] App: inbox, pipeline, contact detail

## Rename repo

GitHub: Settings → rename to `reos-2` or `REOS-2.0` (your choice). Local:

```bash
git remote set-url origin git@github.com:foundry360/<new-name>.git
```

## Related

- Agent layer: [`docs/AGENTS.md`](docs/AGENTS.md)
- Admin model: [`docs/ADMIN.md`](docs/ADMIN.md)
- Legacy GHL product: [foundry360/REOS](https://github.com/foundry360/REOS)
