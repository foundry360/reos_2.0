# REOS 2.0 — Setup

## 1. Supabase project

Project ref: **`dfdimmmturnaxkysozkz`**  
URL: `https://dfdimmmturnaxkysozkz.supabase.co`

1. **SQL Editor** → run [`supabase/migrations/001_initial_schema.sql`](../supabase/migrations/001_initial_schema.sql).
2. **Project Settings → API** — copy:
   - Project URL → `NEXT_PUBLIC_SUPABASE_URL`
   - `anon` key → `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - `service_role` key → `SUPABASE_SERVICE_ROLE_KEY` (server only, never expose to browser)

## 2. Agent service env

```bash
cd apps/agent-service
cp .env.example .env.local
```

Fill OpenAI, Twilio, and Supabase vars. Restart `npm run dev`.

## 3. Seed a test tenant (SQL)

After migration, in Supabase SQL Editor:

```sql
insert into tenants (name, slug, status)
values ('Demo Realty', 'demo-realty', 'active')
returning id;

-- use returned id:
insert into tenant_phone_numbers (tenant_id, phone_e164, is_primary)
values ('<tenant-uuid>', '+15551234567', true);

insert into tenant_agents (tenant_id) values ('<tenant-uuid>');
```

Point your Twilio number’s webhook at `POST /api/webhooks/twilio`. The `To` number must match `tenant_phone_numbers.phone_e164`.

## 4. Vercel

Same project as before; root directory **`apps/agent-service`**.

Add env vars from `.env.example`. Redeploy after Supabase is wired.

## 5. Local dev

```bash
cd apps/agent-service
npm install
npm run dev
```

- Health: http://localhost:3000/api/health
- Twilio webhook: POST http://localhost:3000/api/webhooks/twilio (use ngrok for real SMS)

Without Supabase configured, the webhook returns dev stubs (no CRM writes).

## 6. Auth + login

1. **Authentication → URL Configuration** — set:
   - **Site URL:** `https://getreos.app`
   - **Redirect URLs:**
     - `https://getreos.app/auth/callback`
     - `https://getreos.app/auth/confirm`
     - `https://getreos.app/auth/accept-invite`
     - `https://getreos.app/set-password`
     - `http://localhost:3000/auth/callback` (local dev)
     - `http://localhost:3000/**` (optional wildcard for local)
2. Run [`supabase/migrations/002_platform_admins_policy.sql`](../supabase/migrations/002_platform_admins_policy.sql) in SQL Editor.
3. **Authentication → Users** → create a user (email + password) for testing.
4. Optional platform admin:

   ```sql
   insert into platform_admins (user_id)
   values ('<auth-user-uuid>');
   ```

5. Visit `/login` — split-screen sign-in. Authenticated users land on `/`.

## 7. Profile avatars

Run [`supabase/migrations/003_profiles_avatars.sql`](../supabase/migrations/003_profiles_avatars.sql) in SQL Editor. This creates:

- `profiles` table (`display_name`, `avatar_url`)
- `avatars` storage bucket (public read, 5 MB max)
- Auto-profile row on new user signup

Upload: header avatar menu → **Change photo**. Stored at `avatars/{user_id}/avatar.{ext}`.

## 8. Account admin migrations (004–011)

If account detail pages error (e.g. missing `profiles.phone`, tenant contacts, audit fields), run the remaining migrations in **SQL Editor** in order:

| File | Adds |
|---|---|
| [`004_theme_and_admin_policies.sql`](../supabase/migrations/004_theme_and_admin_policies.sql) | Theme preference, platform admin policies |
| [`005_tenant_principal_name.sql`](../supabase/migrations/005_tenant_principal_name.sql) | Principal first/last name |
| [`006_tenant_billing_config.sql`](../supabase/migrations/006_tenant_billing_config.sql) | Billing config columns |
| [`007_tenant_highlights.sql`](../supabase/migrations/007_tenant_highlights.sql) | Account type, industry, owner |
| [`008_tenant_demographics.sql`](../supabase/migrations/008_tenant_demographics.sql) | Address fields |
| [`009_tenant_contacts.sql`](../supabase/migrations/009_tenant_contacts.sql) | Additional contacts table |
| [`010_tenant_audit.sql`](../supabase/migrations/010_tenant_audit.sql) | Created/modified by audit |
| [`011_profiles_phone.sql`](../supabase/migrations/011_profiles_phone.sql) | `profiles.phone` for tenant users |

**Users phone error** — run at minimum:

```sql
alter table public.profiles add column if not exists phone text;

drop policy if exists profiles_platform_admin_update on public.profiles;

create policy profiles_platform_admin_update on public.profiles
  for update using (public.is_platform_admin());
```

Or paste the full contents of [`011_profiles_phone.sql`](../supabase/migrations/011_profiles_phone.sql). Supabase reloads the API schema automatically after DDL.
