# Journeys — production scheduler (Supabase pg_cron → pg_net → Vercel)

Runbook for invoking the Journey worker every minute from Supabase.

**Nothing here is applied automatically.** No migration, deploy, or application code in this repo enables the extensions, creates the Vault secrets, or schedules the job. Every Supabase step below is done by hand, in the order given.

## 1. Architecture

```text
Supabase pg_cron  ('reos-journey-worker', every minute)
  └─ pg_net  net.http_post  (URL + secret read from Supabase Vault at run time)
       └─ Vercel  POST https://www.getreos.app/api/cron/journeys   (x-cron-secret header)
            └─ Journey worker: lists due runs, claims each one, executes it, returns a summary
```

| Piece | Provides |
|---|---|
| `pg_cron` extension | The `cron` schema: `cron.schedule()`, `cron.job`, `cron.job_run_details` |
| `pg_net` extension | The `net` schema: `net.http_post()`, `net._http_response` |
| Supabase Vault | `vault.decrypted_secrets`, which holds the worker URL and `CRON_SECRET` |

- The worker is the only Journey execution path for waits, retries, and abandoned inline runs. The scheduler just calls it.
- Overlapping calls are safe. Each run is executed only by the caller that wins its database claim/lease.
- A pass stops starting new runs after about 50 seconds and returns immediately when nothing is due.
- The request body is ignored. GET and POST behave the same. No Vercel-specific headers are needed.
- During migration, the existing daily Vercel cron (`/api/cron/journeys`, `0 13 * * *` in `apps/agent-service/vercel.json`) stays as a fallback. The billing cron (`/api/cron/close-billing-cycles`) is unrelated and stays permanently.

## 2. Environment variable

| Where | Name | Value |
|---|---|---|
| Vercel → Project → Settings → Environment Variables → **Production** | `CRON_SECRET` | A long random string, e.g. the output of `openssl rand -hex 32` |
| Supabase Vault | `reos_journey_cron_secret` | **The exact same value** |

The worker accepts the secret as `x-cron-secret: <secret>` or `Authorization: Bearer <secret>`.

- If `CRON_SECRET` is unset, the worker returns 501.
- A missing or wrong secret returns 401 before any database client is created.
- Never commit the value, paste it into tickets, or put it in `.env.example`.

## 3. Setup order

Do these strictly in order. **Don't run `cron.schedule()` until steps A–D have passed.**

1. **A.** Enable `pg_cron` and `pg_net` (section 4).
2. **B.** Run the preflight checks and confirm both the `cron` and `net` schemas exist (section 5).
3. **C.** Create the two Vault secrets and confirm they exist (section 6).
4. **D.** Check for an existing `reos-journey-worker` job (section 7).
5. **E.** Create the job (section 8).
6. **F.** Verify the job and its HTTP results (section 9).

## 4. Enable extensions (A)

Production needs **both** extensions. Don't assume either is already enabled.

- **`pg_cron`** creates the `cron` schema. Without it, `cron.schedule()` fails with `schema "cron" does not exist`.
- **`pg_net`** creates the `net` schema. Without it, the job fails on every run with `schema "net" does not exist`.

In the Supabase Dashboard, go to **Database → Extensions** and enable `pg_cron` and `pg_net`. The exact menu location may move between Supabase dashboard versions; search for the extension by name if needed. The required extensions are always `pg_cron` and `pg_net`.

SQL Editor equivalent (run manually, against production only):

```sql
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;
```

`pg_net` creates its functions in the `net` schema whichever schema the extension is registered in.

## 5. Supabase preflight (B)

Run both queries before going further.

Extensions installed:

```sql
select
  extname,
  extversion
from pg_extension
where extname in ('pg_cron', 'pg_net')
order by extname;
```

Expected rows: `pg_cron`, `pg_net`.

Schemas present:

```sql
select
  schema_name
from information_schema.schemata
where schema_name in ('cron', 'net')
order by schema_name;
```

Expected rows: `cron`, `net`.

- **If `cron` is missing:** stop. Enable `pg_cron` in Supabase before running `cron.schedule()`.
- **If `net` is missing:** stop. Enable `pg_net` before running the scheduler creation SQL.

The REOS application can't and doesn't enable these extensions. They must be enabled in Supabase.

## 6. Vault secrets (C)

| Name | Value | Sensitive |
|---|---|---|
| `reos_journey_cron_url` | `https://www.getreos.app` (production base URL, no trailing slash, no path) | No |
| `reos_journey_cron_secret` | `<same value as Vercel Production CRON_SECRET>` | **Yes** |

Use the host that serves the app directly (`www.getreos.app`, the Site URL in [SETUP.md](SETUP.md)). Don't use a host that redirects: pg_net doesn't follow redirects, so the POST would never reach the worker.

**Recommended:** create both secrets in the Supabase Vault UI (Dashboard → **Integrations → Vault → Add new secret**; the location may vary) so the real secret never lands in SQL Editor history.

SQL equivalent, only if the UI isn't available. Replace the placeholder in the editor only, never in a file, and don't save the snippet:

```sql
select vault.create_secret('https://www.getreos.app', 'reos_journey_cron_url', 'REOS production base URL for the Journey worker');
select vault.create_secret('<PASTE CRON_SECRET HERE>', 'reos_journey_cron_secret', 'Same value as Vercel Production CRON_SECRET');
```

Confirm both exist, without decrypting anything (expect two rows):

```sql
select name, description, created_at, updated_at
from vault.secrets
where name in ('reos_journey_cron_url', 'reos_journey_cron_secret');
```

Never select `decrypted_secret` (or `secret`) when checking or troubleshooting, and never paste its output anywhere.

Rotating the secret: update Vercel `CRON_SECRET` and redeploy, then update the Vault secret (UI, or `vault.update_secret` with the secret's `id` from `vault.secrets`). Expect 401s in `net._http_response` between the two updates. The daily Vercel cron is unaffected because Vercel reads the new env value.

## 7. Check for an existing job (D)

```sql
select
  jobid,
  jobname,
  schedule,
  active
from cron.job
where jobname = 'reos-journey-worker';
```

- **No rows:** go on to section 8.
- **A row already exists:** don't run `cron.schedule()` again. Inspect the existing job (schedule, `active`, and its `command` in `cron.job`) and its history (section 9) instead. If it must be replaced, `cron.unschedule('reos-journey-worker')` it first, then create it once. There must only ever be one `reos-journey-worker`.

## 8. Create the job (E)

Run only after sections 5–7 have passed:

```sql
select cron.schedule(
  'reos-journey-worker',
  '* * * * *',
  $$
    select net.http_post(
      url := (
        select decrypted_secret
        from vault.decrypted_secrets
        where name = 'reos_journey_cron_url'
      ) || '/api/cron/journeys',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-cron-secret', (
          select decrypted_secret
          from vault.decrypted_secrets
          where name = 'reos_journey_cron_secret'
        )
      ),
      body := jsonb_build_object(
        'source', 'supabase-cron',
        'scheduled_at', now()
      ),
      timeout_milliseconds := 60000
    ) as request_id;
  $$
);
```

Notes:

- **No secrets in the job definition.** The job stores only Vault lookups (`cron.job.command`), not the URL or secret. Vault is read each minute, so rotating a Vault value needs no job change.
- **The 60-second timeout is intentional.** The worker has a roughly 50-second execution budget plus the duration of the last run. Don't reduce it to 10 seconds: a shorter timeout makes pg_net report `timed_out` for passes that actually succeeded.
- **What the request carries.** The body is non-sensitive scheduler metadata and the worker ignores it. The only credential is the `x-cron-secret` header; no service-role key or database credential is sent.

## 9. Verify (F)

**Job exists.** Expect exactly one row with `jobname = reos-journey-worker`, `schedule = * * * * *`, and `active = true`:

```sql
select
  jobid,
  jobname,
  schedule,
  active
from cron.job
where jobname = 'reos-journey-worker';
```

**pg_cron is firing.** `succeeded` here only means `net.http_post` queued the request. It does **not** prove Vercel returned HTTP 200.

```sql
select jobid, runid, status, return_message, start_time, end_time
from cron.job_run_details
where jobid = (select jobid from cron.job where jobname = 'reos-journey-worker')
order by start_time desc
limit 20;
```

**Vercel is responding.** This is the real health check:

```sql
select
  id,
  status_code,
  timed_out,
  error_msg,
  left(content, 300) as body,
  created
from net._http_response
order by created desc
limit 20;
```

A healthy worker shows `status_code = 200` and `timed_out = false`. pg_net keeps responses for about 6 hours. The response body holds only counts (found, claimed, skipped, failed, etc.), never secrets or lead data.

## 10. Production migration procedure

1. **Set the secret in Vercel.** Configure `CRON_SECRET` in Vercel → Production.
2. **Deploy.** Deploy the application normally.
3. **Check the endpoint by hand.** This runs one real worker pass; that's expected and safe. Read the secret without echoing it:

   ```bash
   read -rs CRON_SECRET && export CRON_SECRET
   curl -sS -H "x-cron-secret: $CRON_SECRET" https://www.getreos.app/api/cron/journeys
   curl -sS -o /dev/null -w "%{http_code}\n" https://www.getreos.app/api/cron/journeys   # expect 401
   unset CRON_SECRET
   ```

   With the secret you should get a 200 with `{"ok":true,"found":…,"claimed":…,…}`.
4. **Enable `pg_cron` and `pg_net`** (section 4).
5. **Run the preflight checks** (section 5). Stop if `cron` or `net` is missing.
6. **Create the Vault secrets** (section 6).
7. **Check that no `reos-journey-worker` exists** (section 7).
8. **Create the job** (section 8).
9. **Let it run.** Wait 3–5 minutes, then verify `cron.job` and `cron.job_run_details`, and confirm `net._http_response` shows `200` with no timeouts (section 9).
10. **Test a short wait.** Activate a test journey: `Trigger → Wait 2 minutes → Action`, using a test lead and a harmless action such as a task or team notification. Trigger it, then confirm the run resumes about 2 minutes later, not at the next 13:00 UTC daily cron:

    ```sql
    select id, status, resume_at, completed_at, updated_at
    from journey_runs
    where journey_id = '<test-journey-id>'
    order by created_at desc
    limit 5;

    select node_name, status, error_kind, attempt_count, started_at, completed_at
    from journey_run_steps
    where run_id = '<run-id>'
    order by created_at;
    ```

    Expect `waiting` with `resume_at ≈ trigger time + 2 min`, then `completed` within about a minute of `resume_at`.
11. **Test a retry.** Use a test journey whose step fails with `error_kind = 'transient'`. The engine retries transient failures after about 1 minute, then about 5 minutes, and fails the run after 3 attempts. With the queries above, confirm that `resume_at` advances and `attempt_count` increases on that schedule, not at the daily cron.
12. **Check lease behavior.** While the per-minute job and the daily Vercel cron both exist, confirm each step in `journey_run_steps` runs once per attempt (no duplicate actions) and no run stays `running` with an expired `locked_until`.

### Don't remove the Vercel Journey cron until

1. Supabase pg_cron is firing (`cron.job_run_details`).
2. pg_net is successfully reaching Vercel (`net._http_response` has rows, no `error_msg`).
3. Vercel returns HTTP 200.
4. A Journey wait resumes at minute-level timing.
5. A retryable Journey failure retries correctly.
6. Journey lease behavior stays correct under the new scheduler.

Only then remove the `/api/cron/journeys` entry from `apps/agent-service/vercel.json`, in a separate change. Leave `/api/cron/close-billing-cycles` untouched.

## 11. Rollback

Rollback only touches the scheduler; the application and the Vercel cron stay as they are.

1. Pause or remove the Supabase job:

   ```sql
   -- pause (keeps the definition)
   select cron.alter_job(
     job_id := (select jobid from cron.job where jobname = 'reos-journey-worker'),
     active := false
   );

   -- or remove entirely
   select cron.unschedule('reos-journey-worker');
   ```

2. Leave the Vercel Journey cron in place. Runs keep resuming daily.
3. Investigate the Supabase, pg_net, and Vault configuration (section 12).
4. Re-enable the job (`active := true`) or re-create it only after an authenticated manual call (step 3 of section 10) returns 200.

Don't change Journey runtime code as part of scheduler troubleshooting unless an actual code defect is found.

## 12. Troubleshooting

### Error: `schema "cron" does not exist`

**Cause:** `pg_cron` isn't enabled or available in the Supabase database, so the `cron` schema and `cron.schedule()` don't exist.

**Resolution:**

1. Enable `pg_cron` (section 4).
2. Verify it appears in `pg_extension` (section 5).
3. Verify the `cron` schema exists (section 5).
4. Only then run `cron.schedule()` (sections 7–8).

This is a database configuration issue; no REOS code change is involved.

### Error: `schema "net" does not exist`

**Cause:** `pg_net` isn't enabled. This can appear in `cron.job_run_details.return_message` on every run if the job was created before `pg_net`.

**Resolution:** enable `pg_net` (section 4), then verify the `net` schema exists (section 5) before creating the job. An existing job picks it up on its next run.

### Other symptoms

Check `net._http_response` first. `cron.job_run_details` can show `succeeded` even when the HTTP call failed.

| Symptom | Likely cause |
|---|---|
| `failed` with `null value` / URL errors | A Vault secret is missing or misnamed; run the Vault check (section 6) |
| HTTP `401` | Vault `reos_journey_cron_secret` doesn't match Vercel Production `CRON_SECRET` (watch for trailing spaces or newlines), or Vercel wasn't redeployed after setting it |
| HTTP `501` | `CRON_SECRET` not set in Vercel Production |
| HTTP `503` | Supabase service-role env missing in Vercel (`SUPABASE_SERVICE_ROLE_KEY`, `NEXT_PUBLIC_SUPABASE_URL`) |
| HTTP `500` | The worker couldn't query due runs. Check Vercel function logs for `Journey worker failed:` |
| HTTP `301`/`308` or `404` | `reos_journey_cron_url` is wrong, has a trailing slash or path, or points at a redirecting host |
| `timed_out = true` | Pass took longer than the request timeout; the worker still finished. Confirm the timeout is 60000 |
| No new rows anywhere | Job inactive or missing; run the job check (section 9) |
| Two `reos-journey-worker` rows | `cron.schedule()` was run with a different name or after manual edits; unschedule the extras so exactly one remains |

Worker logs (Vercel → Logs) show one `Journey worker: {...}` line per call that found work or hit errors. Idle calls log nothing.

`cron.job_run_details` grows by about 1,440 rows a day. If needed, trim it occasionally:

```sql
delete from cron.job_run_details where end_time < now() - interval '7 days';
```
