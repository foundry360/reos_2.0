# Salesforce project

Metadata and deployment for the REOS SF org.

## Connect CLI

```bash
sf org login web --alias reos-dev \
  --instance-url https://orgfarm-280f8f6fda-dev-ed.develop.lightning.force.com
```

OrgFarm dev orgs expire — use a long-lived sandbox for ongoing work.

## Planned data model (Milestone 1)

### Account = tenant

Create manually when onboarding a client (after GHL setup payment).

### Contact fields (custom — deploy when ready)

| API name | Type | Purpose |
|---|---|---|
| `Lead_Status__c` | Picklist | Agent routing (Qualifying, Ready_to_Book, Nurture, Booked, Handoff) |
| `AI_Summary__c` | Long Text | Concierge / agent summary |
| `Qualification_Score__c` | Number | 0–100 |
| `Lead_Temperature__c` | Picklist | Hot, Warm, Cold |
| `Opted_Out__c` | Checkbox | Compliance kill-switch |

### Connected App (for Agent Service)

1. Setup → App Manager → New Connected App
2. OAuth scopes: `api`, `refresh_token`
3. Use **Client Credentials** or **JWT Bearer** for server-to-server from Vercel
4. Copy credentials to `apps/agent-service/.env.local`

## Deploy

```bash
cd salesforce
sf project deploy start --target-org reos-dev
```

Custom objects and fields will be added under `force-app/main/default/` as the model is finalized.
