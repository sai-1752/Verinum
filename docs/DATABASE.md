# Database

PostgreSQL 16. The schema is plain SQL in `apps/api/migrations/`, applied in filename order by the migration runner. There is no ORM; queries are parameterised SQL in the service modules.

## Roles

| Role | Used by | Can |
|---|---|---|
| `verinum_owner` | Migrations and the admin CLI only | Owns every table, function and type; bypasses RLS as any table owner does. Never used by the running API |
| `verinum_app` | The API and the job worker | Only what `004_grants.sql` and `006_role_guards.sql` grant. Owns nothing, no `BYPASSRLS`, not a superuser |

`deploy/postgres/init-roles.sh` (container stack) creates both roles on first boot; `scripts/db-bootstrap.sh` does the same for development and CI, additionally giving the owner role `CREATEDB` so the end-to-end run can create a throwaway database. Keeping them separate is what makes row-level security a real boundary: a table owner is exempt from its own policies, so if the API ran as the owner the policies would be decoration.

## Migrations

| File | Contents |
|---|---|
| `001_core.sql` | `app_user_id()` / `app_workspace_id()`, users, sessions, OAuth identities, email tokens, workspaces, memberships, invitations, their RLS, `create_workspace`, `accept_invitation`, `invitation_preview`, `delete_workspace` |
| `002_datasets.sql` | datasets, dataset versions, dashboards, conversations, messages, usage events, audit log (with its append-only trigger) |
| `003_jobs.sql` | jobs, the queue functions, `assert_platform_admin`, the admin functions |
| `004_grants.sql` | revokes everything from `PUBLIC`, then grants the runtime role exactly what it needs |
| `005_billing.sql` | `billing_events` and the three billing functions |
| `006_role_guards.sql` | role-aware policies, `app_role_in`, `app_can_manage`, column-level `UPDATE` grants |

The runner (`apps/api/src/db/migrate.ts`) takes an advisory lock so two instances cannot migrate at once, runs each file in its own transaction, records a SHA-256 checksum in `schema_migrations`, and **refuses to start if an applied file has been edited**. Change the schema by adding a new file, never by editing an old one. Run it with `npm run db:migrate` or, in containers, the one-shot `migrate` service that the API waits for. There are no down-migrations; roll back by restoring a backup or writing a forward migration.

## Tables

`ws` = has a `workspace_id` and row-level security.

| Table | ws | Purpose and notable constraints |
|---|:-:|---|
| `users` | | Email is stored lower-cased (a check constraint enforces it) and is unique. `password_hash` is null for OAuth-only users. `failed_logins` / `locked_until` implement lockout. `is_platform_admin` |
| `sessions` | | Only `token_hash` (SHA-256) is stored, never the token. `expires_at`, `revoked_at`, `last_seen_at`, IP and user agent |
| `oauth_identities` | | `(provider, subject)` primary key, linked to a user |
| `email_tokens` | | Verify and reset tokens, hashed, single use, with expiry |
| `workspaces` | ✓ | `plan_id`, `billing` (customer/subscription state), `settings`, slug. The runtime role can update only `name` and `settings` |
| `memberships` | ✓ | `(workspace_id, user_id)` primary key, role enum |
| `invitations` | ✓ | Hashed token, role (never `owner`), one open invitation per workspace and email (partial unique index), expiry, accepted/revoked timestamps |
| `datasets` | ✓ | Name, status (`queued`, `processing`, `ready`, `failed`, `deleting`), pointer to the current version, source format, `is_demo` |
| `dataset_versions` | ✓ | One row per processing run: `version`, options used, `storage_original` and `storage_frame` object keys, row/column counts, and the results as JSON (`profile`, `quality`, `transformations`, `suggestions`, `insights`, `plan`, `document`, `warnings`), plus `analysis_version` so results can be recomputed when the engine improves |
| `dashboards` | ✓ | Saved widget lists (tool + parameters) per dataset |
| `conversations`, `messages` | ✓ | Conversation per user per dataset. A message stores the verified answer, `sources`, `charts`, `facts` (so follow-ups can restate figures), `grounding` (the report, **including the removed sentences**, for operator review) and token usage. `feedback` is 1, 0 or -1 |
| `usage_events` | ✓ | Metered events (`ai_message`, `export`) with quantity, for plan allowances |
| `audit_logs` | ✓ | Append-only, `bigint` id. `workspace_id` is nullable and has **no foreign key**, so records survive deletion of the workspace or user |
| `jobs` | ✓ | The queue: status, attempts, lease fields, progress, result, `dedupe_key` (unique among queued/running jobs) |
| `billing_events` | ✓ | Provider event ids already processed (idempotency). No policy at all: reachable only through `billing_record_event` |
| `schema_migrations` | | Migration bookkeeping |

**Composite foreign keys.** Child tables reference `(workspace_id, id)` on their parent, for example `conversations (workspace_id, dataset_id) → datasets (workspace_id, id)`. A row therefore cannot point at a parent in another workspace, even through a bug that supplied the wrong ID.

**Deletion.** Removing a workspace cascades to everything it owns. Removing a dataset cascades to its versions, dashboards, conversations and messages; stored objects are removed by a `dataset.purge` job. Users are deleted only by cascade from operator action (there is no self-service account deletion in this version).

**Versions.** A new `dataset_versions` row is created for every processing run, and the stored frame object of a version is never rewritten. The row itself is updated once, by the pipeline, when processing finishes; there is no trigger preventing later updates, so immutability of the row is by convention and the tests, while immutability of the stored data is by never overwriting object keys.

## Row-level security

Every request that touches tenant data runs in a transaction that begins with:

```sql
select set_config('app.user_id', $1, true), set_config('app.workspace_id', $2, true);
```

`true` makes the setting transaction-local, so a pooled connection can never carry one request's context into the next. `app_user_id()` and `app_workspace_id()` return NULL when unset, and every policy compares against them, so a query with no context matches no rows and a write fails its `WITH CHECK`. This is the "fail closed" property the tenancy tests assert.

| Table | Policy |
|---|---|
| `datasets`, `dataset_versions`, `dashboards`, `conversations`, `messages`, `usage_events`, `jobs` | `tenant_isolation`: `workspace_id = app_workspace_id()` for every command, as both `USING` and `WITH CHECK` |
| `workspaces` | Select if it is the current workspace or you are a member of it; update only the current workspace (and only `name`/`settings`, by column grant) |
| `memberships` | Select your own rows, or any row in the current workspace. Insert/update need `app_can_manage(workspace, new_role)`; delete your own row, or manage that role |
| `invitations` | Current workspace, and `app_can_manage` for the invited role |
| `audit_logs` | Select rows of the current workspace, or your own platform-level events (those with no workspace, such as sign-ins); insert into the current workspace or with no workspace. No update/delete policy, no privilege, and a trigger that raises on update or delete |
| `billing_events` | RLS on, no policy: nobody but the owner and the functions below |

`app_can_manage(workspace, role)`: owners may manage any role; admins may manage `analyst` and `viewer`; nobody else may manage anything. This is why an admin cannot promote themselves to owner even by writing SQL directly, which the tests attempt.

## Functions that cross tenants

These are `SECURITY DEFINER` with `search_path = public, pg_temp`, granted to the runtime role one at a time. The complete list, with the reason for each, is in [SECURITY.md](SECURITY.md#the-cross-tenant-exceptions-all-security-definer-search_path-pinned); a test fails if the set in the schema differs from it.

**Queue.** `job_claim(worker, kinds[])` picks the oldest runnable job with `FOR UPDATE SKIP LOCKED`, so any number of worker processes can poll safely. `job_heartbeat` renews the lease and records progress. `job_finish` and `job_fail` succeed only for the worker that holds the lease; a failure retries with exponential backoff (5 s × 2^attempts) until `max_attempts` (3), then fails permanently. `job_reap(lease_seconds)` requeues jobs whose worker stopped heartbeating, or fails them if out of attempts. `job_cancel` is limited to the caller's current workspace. Claiming necessarily returns the job's payload across tenants to whichever worker runs it; payloads carry identifiers, never file contents.

## Indexes worth knowing

`jobs_claim_idx` (partial, queued only), `jobs_dedupe_uq` (prevents double-enqueueing the same work), `datasets_ws_idx`, `dataset_versions_ds_idx (dataset_id, version desc)`, `conversations_ds_idx`, `messages_conv_idx`, `usage_events_idx (workspace_id, kind, created_at)`, `audit_ws_idx`, `audit_actor_idx`, `invitations_open_uq`, `users_email_uq`.

## What is not in the database

Uploaded files and the typed, compressed frames used for analysis live in object storage (local disk or S3-compatible), under keys `w/<workspace>/datasets/<dataset>/…`, encrypted with AES-256-GCM. The database holds only the keys. Backups of the database alone therefore do not contain customer files, and a restore must be paired with a matching object-store snapshot: a version row whose objects are missing will fail to load and can be reprocessed only if its original file still exists.

## Operations

- **Backups:** use your provider's point-in-time recovery, or `pg_dump` of the `verinum` database plus a snapshot of the object store taken close together. `schema_migrations` is included, so a restored database knows what is applied.
- **Connections:** the API opens a pool per process (`DATABASE_POOL_MAX`). Each request holds one connection only while its transaction runs. If you put PgBouncer in front, use **transaction** pooling; the transaction-local settings are compatible with it, session-local ones would not be, and none are used.
- **Retention:** `audit_logs`, `usage_events` and finished `jobs` grow without bound in this version; add a retention job for your compliance needs.
- **Stuck datasets (known gap):** when a job fails normally (bad file, plan limit, exhausted retries) its failure hook marks the version, and a first-version dataset, as `failed`. If a worker *dies* on its final attempt, the reaper fails the job but runs no hook, so that dataset can remain `processing`. Cancelling or re-uploading resolves it, and an operator can find such rows with `select d.id from datasets d join jobs j on j.payload->>'datasetId' = d.id::text where d.status = 'processing' and j.status in ('failed','cancelled')`. A reconciliation sweep is the obvious next addition.
