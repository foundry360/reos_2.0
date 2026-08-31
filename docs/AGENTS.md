# REOS 2.0 — Agent layer

Seven agent roles. Only three talk to leads on SMS/IG/Messenger. Coordinator is deterministic code, not an LLM.

**Source of truth for prompts + routing contracts:** [`docs/ghl-agent-reference.md`](ghl-agent-reference.md)

## Roles

| Agent | Runtime | Talks to lead? | Trigger |
|---|---|---|---|
| **Coordinator** | TypeScript router | No | Every inbound message |
| **Concierge** | OpenAI | Yes | Default qualify path |
| **Scheduler** | OpenAI | Yes | `ready_to_book` |
| **Follow-Up** | OpenAI | Yes | Warm/Cold nurture or `appt_booked` |
| **Intake** | Webhook / job | No | New unknown sender |
| **Researcher** | Job (later) | No | After intake or Concierge signal |
| **Compliance** | Inline + job | Rarely | Every inbound; opt-out keywords |
| **Scout** | Cron (later) | No | Stale leads, re-engage rules |

## Coordinator rules (first match wins)

1. `opted_out` → stop
2. `handoff` → stop (human queue)
3. `ready_to_book` → Scheduler (wins even if `appt_booked` — reschedule)
4. `appt_booked` (and not ready_to_book) → Follow-Up
5. `lead_temperature` Warm/Cold → Follow-Up
6. `lead_status` Converted without `appt_booked` → stop
7. Default → Concierge

Implementation: `apps/agent-service/src/lib/coordinator.ts`

CRM pipeline statuses stay: `New | Working | Contacted | Qualified | Converted`.  
Routing flags (migration `033`): `ready_to_book`, `appt_booked`, `handoff`, plus `agent_brief`, `recommended_next_action`, `intent`.

## Conversational agents

Each agent = one system prompt file under `src/agents/` + shared `update_contact` tool.

| File | Sets via tool |
|---|---|
| `concierge.ts` | ai_summary, agent_brief, score, temperature, intent, ready_to_book, handoff |
| `scheduler.ts` | email, appt_booked, clear ready_to_book, handoff (calendar slots deferred) |
| `follow-up.ts` | ai_summary, temperature, ready_to_book, handoff |

## Automation agents (Milestone 2+)

**Intake** — On first SMS/Meta message to a tenant: create `contacts` row + `contact_identities`. Runs inline in webhooks today.

**Channel adapters** — SMS (`handle-inbound.ts`) and Meta (`handle-inbound-meta.ts`) both call `runInboundAgent` (`src/lib/run-inbound-agent.ts`). Same Concierge / Scheduler / Follow-Up playbooks. Tenant toggles on `tenant_agents` disable a playbook when off.

**Compliance** — Inline: STOP/HELP-style keywords → `opted_out`, clear `ready_to_book`, block Coordinator. Batch: quiet hours, audit log (later).

**Researcher** — Enrichment job; writes to `ai_summary` or `research` JSON. Off by default per tenant (`tenant_agents.researcher_enabled`).

**Scout** — Cron finds stale nurture contacts; may queue outbound or flag inbox. Off by default until cron is wired.

## Per-tenant config

Table `tenant_agents` — toggles and quiet hours. Edited in admin portal, not tenant Settings.

## Memory model

- **Short-term:** `messages` table (thread for OpenAI context window)
- **Long-term:** `contacts.ai_summary` + `agent_brief` + CRM fields (survives thread trim)
