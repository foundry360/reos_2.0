# Journeys — production scheduler (Supabase pg_cron → pg_net → Vercel)

Runbook for invoking the Journey worker every minute from Supabase.

**Status (2026-10-04):** Supabase pg_cron is the production Journey scheduler. Job `reos-journey-worker` runs `* * * * *`, is active, and returns HTTP 200. The temporary daily Vercel Journey cron has been removed from `apps/agent-service/vercel.json`. See [section 10](#10-production-validation-completed) for what was validated.

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
- `/api/cron/journeys` on Vercel remains the worker endpoint, but Vercel no longer schedules it. Supabase `reos-journey-worker` is the only scheduler; there's no Vercel Journey cron fallback.
- The billing cron (`/api/cron/close-billing-cycles`, `0 6 1 * *` in `apps/agent-service/vercel.json`) is independent and stays scheduled by Vercel.

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

Rotating the secret: update Vercel `CRON_SECRET` and redeploy, then update the Vault secret (UI, or `vault.update_secret` with the secret's `id` from `vault.secrets`). Expect 401s in `net._http_response` between the two updates. Journey waits and retries don't resume during that window; they're picked up on the first successful call afterwards, so update Vault right after the deploy.

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

## 10. Production validation (completed)

Validated in production on 2026-10-04:

- **HTTP endpoint:** `reos-journey-worker` fires every minute and `net._http_response` shows HTTP 200 from `https://www.getreos.app/api/cron/journeys`.
- **Live wait/resume:** a production journey with a short wait resumed at minute-level timing.
- **Retries:** a transient step failure retried after about 1 minute, then about 5 minutes.
- **Maximum three attempts:** after the third failed attempt the run was marked `failed`, with no further attempts.
- **Concurrent workers:** with 5 workers executing the same run at once, exactly one claimed it and the action ran once.
- **Lease takeover/fencing:** a worker that stalled past its lease couldn't write after another worker claimed the run. Recovery didn't repeat the non-repeatable action.

The temporary Vercel Journey cron was then removed from `apps/agent-service/vercel.json`. The billing cron was left unchanged.

### Setup procedure (reference: rebuilding the scheduler)

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
10. **Test a short wait.** Activate a test journey: `Trigger → Wait 2 minutes → Action`, using a test lead and a harmless action such as a task or team notification. Trigger it, then confirm the run resumes about 2 minutes later:

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
11. **Test a retry.** Use a test journey whose step fails with `error_kind = 'transient'`. The engine retries transient failures after about 1 minute, then about 5 minutes, and fails the run after 3 attempts. With the queries above, confirm that `resume_at` advances and `attempt_count` increases on that schedule.
12. **Check lease behavior.** Confirm each step in `journey_run_steps` runs once per attempt (no duplicate actions), and no run stays `running` with an expired `locked_until`.

## 11. Rollback

Rollback only touches the Supabase job; the application, `vercel.json`, and the billing cron stay as they are.

While the job is paused, nothing resumes Journey waits or retries. Due runs aren't lost: they stay due and are picked up by the first successful worker call after the job is re-enabled. If needed during an outage, run a pass by hand with the authenticated call in step 3 of the setup procedure (section 10).

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

2. Investigate the Supabase, pg_net, and Vault configuration (section 12).
3. Re-enable the job (`active := true`) or re-create it (sections 7–8) only after an authenticated manual call (step 3 of the setup procedure) returns 200.

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
