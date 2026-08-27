# REOS 2.0 — Admin portal

Platform console for Foundry ops. Analogous to GHL **agency**; tenant app is the **location/subaccount**.

**Admin owns onboarding and account setup.** Tenant users log into the app and work — they do not configure integrations, invite team members, or complete OAuth flows.

## Routes

| Path | Purpose |
|---|---|
| `/admin` | Account list, status, search |
| `/admin/accounts/new` | Create tenant + invite owner |
| `/admin/accounts/[id]` | Configure tenant, setup checklist, connections, activate |

## Create account workflow

1. GHL setup payment received (manual or Stripe webhook notify).
2. Admin → **New account**: name, slug, timezone, owner email.
3. Complete the **Account setup** checklist on the account detail page:
   - Assign Twilio number (Highlights)
   - Invite owner (Users)
   - Configure agents (Connections)
   - Link Stripe customer ID (Billing)
   - Connect social channels if needed (Connections — Meta OAuth from admin)
   - **Activate account**
4. Owner signs in at app → inbox/pipeline ready to use (no setup wizard).

## Per-account configuration

All provisioning happens in admin:

- Profile: name, timezone, status (pending / active / paused)
- Phone numbers: E.164 pool assignment (Highlights)
- Users: invite, roles (owner / agent / viewer)
- Agents: enable/disable Concierge, Scheduler, Follow-Up, Intake, Researcher, Scout (Connections)
- Compliance: strict mode, quiet hours
- Channels: Twilio status, Meta connect/disconnect (Messenger, Instagram) — **admin completes OAuth**
- Billing: GHL/Stripe customer id, internal contractor notes

## Impersonation

Platform admin opens tenant with audit log (`impersonated_by`). Banner in app: “Viewing {tenant name}” + Exit.

## Roles

| Role | Scope |
|---|---|
| `platform_admin` | All tenants, admin routes, full setup |
| `owner` | Tenant app — inbox, pipeline, contacts (no setup) |
| `agent` | Inbox, pipeline, contacts |
| `viewer` | Read-only |

`platform_admins` table + Supabase Auth. Tenant users via `memberships` + RLS.

## Meta OAuth (admin)

Social channels connect from the account **Connections** card. Requires:

- `META_APP_ID`
- `META_APP_SECRET`

OAuth routes: `/api/oauth/meta/start` → Facebook → `/api/oauth/meta/callback`. Tokens stored in `channel_accounts.metadata` (service role).
