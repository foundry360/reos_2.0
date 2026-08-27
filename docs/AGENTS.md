# REOS 2.0 — Agent layer

Seven agent roles. Only three talk to leads on SMS/IG. Coordinator is deterministic code, not an LLM.

## Roles

| Agent | Runtime | Talks to lead? | Trigger |
|---|---|---|---|
| **Coordinator** | TypeScript router | No | Every inbound message |
| **Concierge** | OpenAI | Yes | `lead_status` = Qualifying (default) |
| **Scheduler** | OpenAI | Yes | Ready_to_Book |
| **Follow-Up** | OpenAI | Yes | Nurture, Booked |
| **Intake** | Webhook / job | No | New unknown sender |
| **Researcher** | Job (later) | No | After intake or Concierge signal |
| **Compliance** | Inline + job | Rarely | Every inbound; opt-out keywords |
| **Scout** | Cron (later) | No | Stale leads, re-engage rules |

## Coordinator rules (first match wins)

1. `opted_out` or Compliance → stop
2. Handoff → stop (human queue)
3. Ready_to_Book → Scheduler
4. Booked → Follow-Up
5. Nurture → Follow-Up
6. Default → Concierge

Implementation: `apps/agent-service/src/lib/coordinator.ts`

## Conversational agents

Each agent = one system prompt file under `src/agents/` + shared `update_contact` tool.

| File | Sets via tool |
|---|---|
| `concierge.ts` | ai_summary, score, temperature; may set Ready_to_Book, Handoff, Compliance |
| `scheduler.ts` | Booked, Handoff |
| `follow-up.ts` | Ready_to_Book, Compliance |

Prompt source (reference): GHL REOS `docs/prompts/` in [foundry360/REOS](https://github.com/foundry360/REOS).

## Automation agents (Milestone 2+)

**Intake** — On first SMS to a tenant number: create `contacts` row + `contact_identities` (channel=sms). Runs inline in the Twilio webhook today.

**Compliance** — Inline: STOP/HELP → `opted_out`, block Coordinator. Batch: quiet hours, audit log (later).

**Researcher** — Enrichment job; writes to `ai_summary` or `research` JSON. Off by default per tenant (`tenant_agents.researcher_enabled`).

**Scout** — Cron finds stale Nurture contacts; may queue outbound or flag inbox. Off by default until cron is wired.

## Per-tenant config

Table `tenant_agents` — toggles and quiet hours. Edited in admin portal, not tenant Settings.

## Memory model

- **Short-term:** `messages` table (thread for OpenAI context window)
- **Long-term:** `contacts.ai_summary` + CRM fields (survives thread trim)
