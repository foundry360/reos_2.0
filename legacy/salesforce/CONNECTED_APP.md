# Connected App — Agent Service

Server-to-server OAuth so `apps/agent-service` can query and update Contacts in the REOS SF org.

Use **Client Credentials** for Vercel (no user in the loop). The refresh-token path is only for local debugging.

**Org:** [orgfarm-280f8f6fda](https://orgfarm-280f8f6fda-dev-ed.develop.lightning.force.com)  
**API instance URL:** `https://orgfarm-280f8f6fda-dev-ed.develop.my.salesforce.com`  
(Do not use the `lightning.force.com` host as `SF_INSTANCE_URL`.)

## 1. Create the Connected App

1. In the org, open **Setup**.
2. Quick Find → **App Manager** → **New Connected App**.
   - If the org offers **External Client App** instead, create one with the same OAuth settings below.
3. Fill in:
   - **Connected App Name:** `REOS Agent Service`
   - **API Name:** `REOS_Agent_Service`
   - **Contact Email:** your admin email
4. Enable **OAuth Settings**.
5. **Callback URL** (required by the form; unused for client credentials):

   ```text
   https://login.salesforce.com/services/oauth2/success
   ```

6. **Selected OAuth Scopes:**
   - Manage user data via APIs (`api`)
   - Perform requests at any time (`refresh_token`, `offline_access`)
7. Enable **Client Credentials Flow** (under OAuth / Flow Enablement).
8. Leave **Require Secret for Web Server Flow** checked.
9. Save, then **Continue**. Wait 2–10 minutes for the app to propagate.

## 2. Consumer Key and Secret

1. App Manager → **REOS Agent Service** → **View** (or **Manage Consumer Details**).
2. Verify your identity if prompted.
3. Copy:
   - **Consumer Key** → `SF_CLIENT_ID`
   - **Consumer Secret** → `SF_CLIENT_SECRET`

## 3. Run-as user (Client Credentials)

1. App Manager → **REOS Agent Service** → **Manage**.
2. **Edit Policies**.
3. **Client Credentials Flow** → **Run As:** choose a dedicated integration user (System Administrator is fine on this OrgFarm DE org).
4. Save.

Create a dedicated user later in a long-lived sandbox. Do **not** use a real agent’s login in production.

## 4. Assign the permission set

After `sf project deploy` of this repo:

1. Setup → **Permission Sets** → **REOS Agent Service**.
2. **Manage Assignments** → assign to the same user selected in **Run As**.

That set grants read/edit on Account + Contact and FLS on the Milestone 1 fields.

## 5. Wire `apps/agent-service`

In `apps/agent-service/.env.local` (and the Vercel project env):

```bash
SF_INSTANCE_URL=https://orgfarm-280f8f6fda-dev-ed.develop.my.salesforce.com
SF_CLIENT_ID=<consumer key>
SF_CLIENT_SECRET=<consumer secret>
# Leave empty when using client credentials
SF_REFRESH_TOKEN=
```

Restart `npm run dev`. `isSalesforceConfigured()` is true when instance URL + client id + secret are set.

### Confirm the token

```bash
curl -s -X POST "$SF_INSTANCE_URL/services/oauth2/token" \
  -d "grant_type=client_credentials" \
  -d "client_id=$SF_CLIENT_ID" \
  -d "client_secret=$SF_CLIENT_SECRET"
```

A JSON body with `access_token` means the Connected App is ready.

## 6. Optional: refresh-token flow (local only)

Only if you need to call the API as a specific interactive user:

1. On the Connected App, enable **Enable Authorization Code and Credentials Flow** (or Web Server Flow).
2. Add callback `http://localhost:1717/OauthRedirect` (Salesforce CLI default).
3. Authorize once:

   ```bash
   sf org login web --alias reos-dev \
     --client-id "$SF_CLIENT_ID" \
     --instance-url https://orgfarm-280f8f6fda-dev-ed.develop.my.salesforce.com
   ```

4. When prompted, enter the Consumer Secret. After login:

   ```bash
   sf org display --target-org reos-dev --verbose
   ```

5. Copy **Refresh Token** into `SF_REFRESH_TOKEN`. When that variable is set, agent-service uses `grant_type=refresh_token` instead of client credentials.

## 7. Milestone 1 smoke test (after env is set)

1. In Salesforce, create an **Account** (tenant) and a **Contact** with a real phone number.
2. Set **Lead Status** = Qualifying (default).
3. Point Twilio inbound SMS at `https://<vercel-or-ngrok>/api/webhooks/twilio`.
4. Text the Twilio number. Concierge should reply and may PATCH `AI_Summary__c` / score / temperature on that Contact.
