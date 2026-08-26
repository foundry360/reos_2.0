# REOS SF — Architecture

## Overview

| Layer | Platform | Role |
|---|---|---|
| **CRM + UI** | Salesforce (single multi-tenant org) | Contacts, opps, React app, Flows |
| **Conversational AI** | Agent Service (Vercel) | Concierge, Scheduler, Follow-Up via OpenAI |
| **Channels** | Twilio (+ Meta later) | SMS inbound/outbound |
| **Payments** | GHL + Stripe Connect | Separate; no sync to Salesforce |

Tenants are **Account** records, created **manually** after payment in GHL.

## Components

### Salesforce

- **Account** = tenant (client)
- **Contact** / **Opportunity** = lead pipeline
- **Lead_Status__c** (planned) = routing: Qualifying, Ready_to_Book, Nurture, Booked, Handoff
- **Flows** = Intake, Researcher logic, Compliance, Scout, email drips (no chat)
- **React UIBundle** (planned) = agent dashboard via App Launcher / Experience Cloud

### Agent Service (`apps/agent-service`)

```text
POST /api/webhooks/twilio
  → resolve tenant + contact (phone → SF lookup)
  → Coordinator picks playbook from Lead_Status__c
  → OpenAI (system prompt + tools)
  → update Salesforce
  → TwiML SMS reply
```

**Coordinator** (code, port of GHL routing rules):

1. Compliance / opt-out → stop
2. Handoff → human
3. Ready_to_Book → Scheduler
4. Booked (no reschedule) → Follow-Up
5. Warm/Cold / Nurture → Follow-Up
6. Default → Concierge

### Payments (out of scope for this repo)

- GHL Payment button → Stripe platform account
- Webhook splits to 4 Connect contractors + house (optional route in agent-service)
- Ops manually creates Salesforce Account when setup fee is received

## Deployment

| Service | Host |
|---|---|
| Agent Service | Vercel (`apps/agent-service`) |
| Salesforce metadata | `sf project deploy` from `salesforce/` |
| Conversation state | Upstash Redis or SF (production); in-memory stub for dev |

## Related

- Legacy GHL product: [foundry360/REOS](https://github.com/foundry360/REOS)
- Prompt source (reference): Concierge / Scheduler / Follow-Up behavior in that repo’s `docs/prompts/`
