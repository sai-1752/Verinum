# Deployment

Verinum is three pieces: the **web** container (nginx serving the built single-page app and proxying `/api`), the **API** container (Fastify, plus an in-process job worker), and **PostgreSQL 16**. Uploads are kept in object storage: a local volume by default, S3-compatible storage for anything you intend to scale.

> **Honest status.** The Dockerfiles and `docker-compose.yml` were written but not built in the environment where this was developed, because no container runtime was available there. What was verified: the API's production bundle, run from a pruned production `node_modules`, starts, migrates, serves `/healthz` and `/readyz`, and passes the API tests' health checks; the web build's output and the nginx template were reviewed but not run. Build the images once in your CI and run the smoke test at the bottom of this page before trusting them.

## The container stack

```bash
cp .env.example .env     # fill in every CHANGE value
docker compose up --build
```

Start-up order is enforced: `db` (creates the two roles on first boot) → `migrate` (one-shot, as the schema owner) → `api` (as the restricted runtime role) → `web`. The web container publishes `WEB_PORT` (default 8080). Put a TLS-terminating load balancer or ingress in front of it; the app refuses to start in production with an `http` public URL or insecure cookies.

Deliberate details in the compose file:

- The API container receives only the variables listed under its `environment:` key. It is **not** given `POSTGRES_PASSWORD` or `VN_OWNER_PASSWORD`, so a compromise of the API process cannot connect as the schema owner (which would bypass row-level security).
- The `migrate` service is the only one that holds the owner password.
- Uploaded files go to the `storage` volume, encrypted. Back the volume up together with the database, or use S3.
- The API's user is the unprivileged `node` user; the image has a health check on `/readyz`.

### Without compose

Build `apps/api/Dockerfile` and `apps/web/Dockerfile` from the repository root, run `node dist/migrate.mjs` (with `DATABASE_MIGRATION_URL` set to the owner URL) as a release step, then start `node dist/server.mjs` with the runtime environment. Any orchestrator that can run a pre-deploy job and two services works. For an existing Postgres, create the two roles by hand as below. (`scripts/db-bootstrap.sh` is for development and CI: it also gives the owner role `CREATEDB` so tests can create throwaway databases, which production does not need.)

```sql
create role verinum_owner login password '…';
create role verinum_app   login password '…' nosuperuser nobypassrls nocreatedb nocreaterole;
create database verinum owner verinum_owner;
```

For a managed database (RDS, Cloud SQL, …) do the same with the provider's admin user, and append `?sslmode=require` to both URLs.

## Configuration

All configuration is environment variables, validated at start-up; the process refuses to start on any error and says what is wrong. The full annotated list is in [`apps/api/.env.example`](../apps/api/.env.example) and `apps/api/src/config.ts`. The ones that matter for a deployment:

| Variable | Notes |
|---|---|
| `DATABASE_URL` | Runtime role (`verinum_app`). Production refuses the development password |
| `DATABASE_MIGRATION_URL` | Owner role. Read only by `migrate` and `admin`, never by the server |
| `PUBLIC_WEB_URL`, `PUBLIC_API_URL` | Must be `https://` in production. The web URL is also the allowed `Origin` for state-changing requests. Same value when nginx fronts both |
| `COOKIE_SECURE` | Must be `true` in production |
| `COOKIE_SECRET` | Signs OAuth state cookies. Required in production |
| `STORAGE_ENCRYPTION_KEY` | 32 bytes, base64. Required in production. **Losing it makes stored files unreadable**; keep it in a secret manager. There is no rotation tool |
| `TRUST_PROXY` | `true` behind nginx/a load balancer, so client IPs (rate limiting, audit) are real |
| `MAIL_DRIVER`, `SMTP_URL`, `MAIL_FROM` | `smtp` in production; `log`, `memory`, `file` are for development and are refused in production |
| `AI_PROVIDER` | `none` (default), `anthropic`, `openai`; with the matching `*_API_KEY` and `*_MODEL` |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Enables Google sign-in. Authorised redirect URI: `${PUBLIC_API_URL}/api/v1/auth/oauth/google/callback` |
| `BILLING_PROVIDER` | `none` or `stripe`, with `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_PRO`, `STRIPE_PRICE_TEAM` |
| `STORAGE_DRIVER` | `local` (default) or `s3` with `S3_BUCKET`, `S3_REGION`, optional `S3_ENDPOINT`, `S3_FORCE_PATH_STYLE`. Credentials come from the AWS SDK's standard chain; prefer a role over static keys |
| `WORKER_ENABLED`, `WORKER_CONCURRENCY`, `JOB_LEASE_SECONDS` | Job processing (below) |
| `FRAME_CACHE_MB`, `INGEST_MEMORY_MB` | Memory budgets (below) |
| `RATE_LIMIT_GLOBAL_PER_MIN`, `RATE_LIMIT_AUTH_PER_MIN` | Defaults 600 and 10 |
| `METRICS_TOKEN` | `/metrics` is off in production unless set, then needs `Authorization: Bearer` |
| `ALLOW_REGISTRATION`, `REQUIRE_EMAIL_VERIFICATION` | Access policy |
| `PLANS_FILE` | Optional path to a replacement `plans.json` |

Generate secrets with `openssl rand -hex 24` (passwords; keep them alphanumeric because they are placed in URLs), `openssl rand -hex 32` (`COOKIE_SECRET`) and `openssl rand -base64 32` (`STORAGE_ENCRYPTION_KEY`).

### Plans and limits

Plans live in `apps/api/config/plans.json`, not in code: limits (datasets, upload size, rows, members, AI messages and exports per month, storage) and feature switches, with `-1` meaning unlimited. Edit the file (or point `PLANS_FILE` at your own) and restart; nothing needs recompiling. A workspace's plan is stored on the workspace; only billing webhooks and platform admins can change it, never the workspace's own users.

### Billing (optional)

Set `BILLING_PROVIDER=stripe` and the four Stripe values, create the Pro and Team prices in Stripe, and add a webhook endpoint `${PUBLIC_API_URL}/api/v1/billing/webhook` for `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated` and `customer.subscription.deleted`. Webhooks are verified by signature over the raw body and are idempotent by event id. Without billing configured, the Upgrade buttons are hidden and platform admins can move a workspace between plans in the admin console.

### The AI provider (optional)

With `AI_PROVIDER=none` everything works and every answer is the deterministic, computed one. With a provider, only column names, up to 12 common values for up to 8 category columns, counts, the date range, the question and the tool summaries are sent (see [SECURITY.md](SECURITY.md#privacy-and-the-ai-provider)). Choose a model with reliable tool calling; if it misbehaves, the grounding gate degrades to the deterministic answer rather than showing something unverified. Watch `chat_dropped_sentences_total` and `chat_messages_total{mode}` after enabling it.

## First run

1. Bring the stack up and open your URL. Register the first account.
2. Make yourself a platform admin (this can only be done from the command line, on purpose):

   ```bash
   docker compose run --rm migrate node dist/admin.mjs promote you@example.com
   ```

3. Sign in and open `/admin`.

## Operations

**Processes and scaling.** The API is stateless apart from an in-memory cache of parsed datasets, so run as many replicas as you need behind the load balancer. By default each replica also runs job workers (`WORKER_ENABLED=true`, `WORKER_CONCURRENCY=2`); the queue is a Postgres table claimed with `FOR UPDATE SKIP LOCKED`, so replicas never process the same job twice. To separate concerns, run some replicas with `WORKER_ENABLED=false` for serving and others (unrouted) with it enabled for processing. All replicas must share the same object storage: use S3 or a shared volume, not per-replica local disks.

**Memory.** Uploads are parsed in the job worker, one job per slot, each inside a worker thread whose heap is capped by `INGEST_MEMORY_MB` (default 2048; a cap, not a reservation) and by the plan's row and size limits. Analysis loads a dataset into a typed, columnar in-memory frame, cached up to `FRAME_CACHE_MB` (default 512) per process and evicted least-recently-used. Size the container for `FRAME_CACHE_MB` + `WORKER_CONCURRENCY × INGEST_MEMORY_MB` + roughly 300 MB. A million-row file of typical width is in the hundreds of megabytes once parsed.

**Job reliability.** A running job renews a lease every few seconds; if a worker dies, the reaper (every replica that has the worker enabled runs one) requeues the job after `JOB_LEASE_SECONDS`, up to three attempts with backoff. See the "stuck datasets" note in [DATABASE.md](DATABASE.md) for the one gap.

**Graceful shutdown.** On SIGTERM the API stops accepting requests, lets in-flight ones finish, gives running jobs up to 20 seconds, then exits; anything unfinished is picked up again by the reaper. Set the orchestrator's termination grace period above 30 seconds.

**Streaming.** Chat answers stream as server-sent events. Any proxy in front of nginx must not buffer responses for `/api/` and must allow read timeouts above the 180 seconds nginx uses. The bundled nginx sets `proxy_buffering off` and `X-Accel-Buffering: no`.

**Upload size.** Three places must agree: the plan's `maxUploadBytes` (the API enforces it, refusing early from `Content-Length`), nginx's `client_max_body_size` (the `MAX_UPLOAD` variable on the web container, default 300m), and any load balancer in front. The largest plan must fit under the smallest of the outer limits.

**Health and monitoring.** `/healthz` (liveness) and `/readyz` (readiness, checks the database) at the API root, which the bundled nginx does *not* expose (it proxies only `/api/`), so point orchestrator probes at the API container directly; the web container answers `/healthz` itself. `/metrics` exposes Prometheus counters and histograms for requests, jobs, datasets, chat modes, dropped sentences, billing events and the frame cache. Logs are JSON on stdout with a request ID on every line and secrets redacted; ship them wherever you ship logs. Useful alerts: `readyz` failing, `jobs_total{outcome="failed"}` rising, job queue age (`select now() - min(created_at) from jobs where status='queued'`), and 5xx rate.

**Backups.** Back up PostgreSQL (point-in-time recovery if available) and the object store **together**: the database holds pointers and results, the store holds the encrypted files. Back up `STORAGE_ENCRYPTION_KEY` separately from both. Test a restore.

**Upgrades.** Deploy the new API image with the `migrate` step first. Migrations are forward-only and additive by policy; the runner refuses to continue if an already-applied file was modified. Old and new API versions must both work against the new schema for the length of a rolling deploy, so keep migrations backward compatible for one release. When the analysis engine changes, each dataset version records the `analysis_version` it was computed with, and reprocessing recomputes it.

**Data retention and deletion.** `audit_logs`, `usage_events` and finished `jobs` are not pruned automatically. Deleting a workspace removes its rows and (best-effort, with an error logged if it fails) its stored objects; check the log for "workspace files could not be purged". Audit records are kept by design.

## Production checklist

- [ ] TLS terminates in front of the web container; HSTS stays on.
- [ ] `PUBLIC_WEB_URL` / `PUBLIC_API_URL` are the real https URLs; `COOKIE_SECURE=true`; `TRUST_PROXY=true`.
- [ ] Three distinct, generated database passwords; the API container has only the runtime one.
- [ ] `COOKIE_SECRET` and `STORAGE_ENCRYPTION_KEY` generated, stored in a secret manager, and the key backed up separately.
- [ ] SMTP configured and a real verification email received; SPF/DKIM set for the sender domain.
- [ ] Shared object storage if running more than one replica; bucket private, encrypted, versioned if you want recovery.
- [ ] Database backups and object-store backups taken together, and a restore tested.
- [ ] `METRICS_TOKEN` set and scraped; alerts on readiness, failed jobs and queue age.
- [ ] `plans.json` reviewed; Stripe prices, webhook and (if used) Google redirect URI configured.
- [ ] First platform admin created from the CLI; registration policy (`ALLOW_REGISTRATION`, `REQUIRE_EMAIL_VERIFICATION`) decided.
- [ ] `npm audit` reviewed, the images scanned, and the SQL policies reviewed by someone other than their author.
- [ ] Smoke test (below) passes against the deployed URL.

## Smoke test

```bash
BASE=https://analytics.example.com
curl -fsS $BASE/healthz                 # web: ok
curl -fsS $BASE/api/v1/auth/config      # API reachable through the proxy, lists plans
```

Then in a browser: register, click **Try the demo dataset**, wait for processing, open the dashboard, ask "Which product made the most revenue?", confirm the answer's figures are highlighted and that a member with the Viewer role cannot upload. The Playwright suite (`npm run test:e2e`) does exactly this against a local stack and is the best reference for expected behaviour.
