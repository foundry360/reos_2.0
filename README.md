# REOS SF

Real Estate Operating System on **Salesforce** with an external **Agent Service** for conversational AI (Concierge, Scheduler, Follow-Up).

This repo is **greenfield** — not tied to the GHL-based [REOS](https://github.com/foundry360/REOS) product. Payments stay in GHL + Stripe Connect (separate, manual tenant setup in Salesforce).

## Architecture

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

```text
Lead (SMS) → Agent Service (Vercel) → OpenAI + Salesforce API
Agents work in Salesforce (React UIBundle + Flows)
GHL payments → Stripe (no integration with this repo)
```

## Repo layout

| Path | Purpose |
|---|---|
| [`apps/agent-service/`](apps/agent-service/) | Next.js on Vercel — Twilio webhooks, LLM, SF writes |
| [`salesforce/`](salesforce/) | Salesforce CLI metadata (objects, Flows, React bundle later) |
| [`docs/`](docs/) | Architecture and setup |

## Quick start — Agent Service

```bash
cd apps/agent-service
cp .env.example .env.local
# Fill OPENAI_API_KEY, Twilio, Salesforce Connected App credentials
npm install
npm run dev
```

Health: `http://localhost:3000/api/health`  
Twilio webhook (dev): `POST /api/webhooks/twilio`

## Salesforce org

Dev org: `orgfarm-280f8f6fda-dev-ed.develop.lightning.force.com`

```bash
cd salesforce
sf org login web --alias reos-dev \
  --instance-url https://orgfarm-280f8f6fda-dev-ed.develop.lightning.force.com
```

See [`salesforce/README.md`](salesforce/README.md) for data model and deploy steps.

## Deploy Agent Service to Vercel

1. Import this repo in Vercel; set root directory to `apps/agent-service`
2. Add environment variables from `apps/agent-service/.env.example`
3. Point Twilio inbound SMS webhook to `https://<your-app>/api/webhooks/twilio`

## Milestone 1 — Hello tenant

- [ ] Account (tenant) + Contact in Salesforce sandbox
- [ ] Twilio number → webhook → Concierge reply
- [ ] Contact field updated from agent tool call
