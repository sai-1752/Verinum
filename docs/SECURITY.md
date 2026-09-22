# Security

This describes what is enforced, where, and what is not covered. Decision priority for the whole project: correctness, then data security, then tenant isolation.

## Threat model

| Adversary | Goal | Primary defences |
|---|---|---|
| Another customer | Read or change my workspace's data | Membership-resolved workspaces (404 for non-members), `workspace_id` in every query, Postgres row-level security, composite foreign keys, prefix-scoped object storage |
| Anyone on the internet | Take over an account, brute-force logins, abuse uploads | Lockout, per-route rate limits, opaque hashed sessions, HttpOnly cookies, origin checks, bounded upload parsing |
| A malicious file | Crash the server, exhaust memory, read secrets, execute code | Format sniffing from bytes, hard limits on size/rows/columns/zip expansion/time, sandboxed legacy-XLS parser, no macro or script execution anywhere |
| A malicious cell or prompt | Steer the AI, smuggle a formula into an export | Model never sees rows; output verified against computed facts; formula-guarded exports |
| A compromised app process | Read every tenant's data | Runtime DB role has no BYPASSRLS and owns nothing; only enumerated definer functions cross tenants; uploads encrypted at rest with a key the database doesn't hold. Limit: the identity tables are readable and writable by that role (see "What this does not cover") |
| An insider with database read | Read customer files | Stored objects are AES-256-GCM encrypted; passwords are scrypt; session, reset and invitation tokens are stored only as SHA-256 hashes |

Out of scope for this codebase: DDoS absorption, WAF, endpoint security of operators, physical security, and the security of the LLM provider and payment processor.

## Tenant isolation (three independent layers)

1. **Application.** `resolveWorkspace` loads the caller's membership for the workspace in the URL. No membership → `404 not_found` (not 403, so workspace and dataset IDs can't be probed). The permission matrix (`permissions.ts`) is checked next.
2. **Query.** Every tenant query filters on `workspace_id`, and child tables use composite foreign keys `(workspace_id, id)`, so a row cannot reference another tenant's parent even by mistake.
3. **Database.** Row-level security is enabled on every tenant table (`workspaces`, `memberships`, `invitations`, `datasets`, `dataset_versions`, `dashboards`, `conversations`, `messages`, `usage_events`, `jobs`, `audit_logs`, `billing_events`). `billing_events` has RLS and deliberately no policy, so it is unreachable except through the billing functions below. On the others, policies compare `workspace_id` to `app_workspace_id()`, which reads a setting the API sets with `set_config(..., true)` **inside each transaction**. When unset the function returns NULL and the policies match nothing: it fails closed. The runtime role `verinum_app` owns no tables, has no `BYPASSRLS`, and is granted only the privileges listed in `004_grants.sql` (for instance it can insert and read `audit_logs` but not update or delete them, and can insert jobs but not update them).

`006_role_guards.sql` adds role-aware policies: only owners and admins can change memberships, admins cannot touch owners or other admins, only owners/admins can update a workspace's `name` and `settings`, and neither `plan_id`/`billing` nor `users.is_platform_admin` can be written by the runtime role at all.

### The cross-tenant exceptions (all `SECURITY DEFINER`, `search_path` pinned)

Some operations must see across tenants by nature. They are implemented as functions, granted individually to the runtime role, and nothing else can:

| Function | Why it must cross tenants |
|---|---|
| `create_workspace`, `delete_workspace` | Creates the workspace and its first owner membership atomically; delete is owner-only and verifies the role inside the function |
| `accept_invitation`, `invitation_preview` | The invitee has no membership yet; the token hash is the credential; acceptance checks the invited email matches the signed-in user |
| `job_claim`, `job_heartbeat`, `job_finish`, `job_fail`, `job_reap`, `job_cancel` | Workers claim across tenants; all work on tenant data then happens in that job's own tenant context |
| `admin_overview`, `admin_workspaces`, `admin_jobs`, `admin_audit`, `admin_set_workspace_plan` | Platform admin console; each begins with `assert_platform_admin()` |
| `billing_record_event`, `billing_workspace_for_customer`, `billing_apply` | Payment webhooks arrive with no user; signature-verified first, idempotent by event id |
| `app_role_in`, `app_can_manage`, `assert_platform_admin` | Helpers used inside the row-level-security policies and the admin functions. They read the caller's own membership or admin flag (which the policies themselves cannot do without recursing) and return only a role, a boolean, or an error |

The admin functions return aggregate and metadata fields only; there is no function that reads dataset contents across tenants. A test enumerates every `SECURITY DEFINER` function in the schema, requires each to pin `search_path = public, pg_temp`, and fails if one appears that is not on this list.

### Tests

`apps/api/test/tenancy.test.ts` (47 tests) runs two real tenants and attacks in each layer: API routes with the other tenant's IDs (404), raw SQL as the runtime role with and without context (no rows, or refused writes), forged `workspace_id` on inserts, storage keys outside the prefix, job payload tampering, and each definer function's guards. `rbac.test.ts` covers the role matrix. `e2e/specs/teams.spec.ts` repeats the isolation check through a browser and the HTTP API.

## Authentication and sessions

- **Passwords:** scrypt (N=32768, r=8, p=1, 64-byte key, per-user salt), parameters stored with the hash so they can be raised later; NFKC-normalised input; 10–128 characters; rejects a short list of very common passwords, passwords containing the email name, and repeated single characters. That common-password list is deliberately small; there is no breach-corpus check.
- **Login:** identical error for unknown email and wrong password, with a dummy verify to keep timing uniform. After 10 consecutive failures the account locks for 15 minutes (a successful password reset clears it). Login is rate-limited per IP (`RATE_LIMIT_AUTH_PER_MIN`, default 10) on top of the lockout.
- **Sessions:** a random 256-bit token in an `HttpOnly`, `SameSite=Lax` cookie (`Secure` in production); only its SHA-256 is stored. Expiry is rolling (`SESSION_TTL_DAYS`, default 30). Users can list and revoke sessions; changing or resetting a password revokes the others. No token ever appears in a URL or a log.
- **CSRF:** any state-changing request that carries the session cookie must have an `Origin` header matching `PUBLIC_WEB_URL` or `CORS_ORIGINS`; otherwise it is refused. Combined with `SameSite=Lax`.
- **Email verification and reset:** single-use random tokens stored as hashes; 24 h and 1 h lifetimes. The forgot-password response does not reveal whether the address exists. `REQUIRE_EMAIL_VERIFICATION` can gate the app on verification.
- **Google OAuth:** authorization-code flow with PKCE (S256) and a signed, short-lived state cookie. Accounts are linked by verified email only when the provider asserts the email is verified, and an existing password account that was never verified cannot be taken over by a matching Google identity (the "pre-hijacking" case).
- **Invitations:** 7-day, single-use, token stored hashed, tied to an email address; accepting as a different address fails.
- **Platform admin** is a flag on the user that only the owner-role CLI can set (`node dist/admin.mjs promote <email>`); the runtime role cannot write it.

## Upload hardening

Every uploaded file goes through `packages/ingest` with these limits (all configurable per call; the plan's `maxUploadBytes` applies first):

- format decided from the bytes; the extension and client MIME type are hints only;
- raw size, rows (`≤ 1,000,000`), columns (`≤ 500`), characters per cell (`≤ 32,768`), sheets (`≤ 50`), PDF pages (`≤ 300`), zip entries (`≤ 5,000`), total uncompressed bytes (`≤ 400 MB`), per-entry compression ratio (`≤ 200×` once an entry exceeds 1 MB), and a wall-clock budget (`120 s`);
- ZIP containers are inflated through a streaming decoder that counts bytes actually produced and aborts at the limit; the limits apply to every entry, including ones never read; entry names with traversal are rejected (names are never used as paths anyway);
- all parsing runs in a worker thread with a V8 heap cap (`INGEST_MEMORY_MB`), an empty environment (no secrets visible) and a hard timeout, so a hostile file can be killed without touching the API process; the legacy `.xls` parser runs in a further nested worker of its own;
- XLSX/DOCX are read as data: macros, external links, embedded objects and formulas are never evaluated (formulas contribute their cached values);
- encrypted or corrupt files fail with a specific, user-safe message.

The original file is stored **encrypted** and is never modified. Parsing happens in the job worker, not in the request path.

## Data at rest and in transit

- Every stored object (originals and typed frames) is encrypted with AES-256-GCM using `STORAGE_ENCRYPTION_KEY`; the object key is bound as authenticated data, so ciphertext copied to another key fails to decrypt. The key is required in production. Rotating it requires re-encrypting stored objects (no tool is provided for that).
- Object keys are `w/<workspace>/…` and every access goes through `ScopedStore`, which refuses any key outside the caller's workspace prefix.
- TLS is terminated in front of the containers (load balancer or ingress). Production configuration refuses to start unless `PUBLIC_WEB_URL` is `https` and `COOKIE_SECURE` is true. HSTS is sent by both the API and nginx.
- The database connection uses whatever `DATABASE_URL` specifies; add `?sslmode=require` for a managed database.

## Browser and API hardening

- API: helmet with `default-src 'none'`, `frame-ancestors 'none'`, `nosniff`, HSTS; body limit 1 MB (uploads use the multipart route with its own limit); zod validation with `.strict()` schemas (unknown fields are rejected); errors are `{error:{code,message,requestId}}` with no stack traces or SQL.
- Web (nginx): CSP `default-src 'self'` with `script-src 'self'` (no inline or eval scripts), `frame-ancestors 'none'`, `object-src 'none'`, `nosniff`, `Referrer-Policy`, `Permissions-Policy`. `style-src` allows `'unsafe-inline'` because the charting library sets inline styles. Fonts are self-hosted.
- React escapes all text; the only HTML-ish rendering is the answer renderer, which builds elements rather than injecting strings (there is a test that markup in an answer is escaped).
- Exports: cells beginning with `=`, `+`, `-`, `@`, tab or CR are neutralised in CSV and XLSX so a spreadsheet application will not execute them as formulas.
- Rate limits: global (`RATE_LIMIT_GLOBAL_PER_MIN`, default 600) plus stricter limits on auth, invitations, workspace creation, uploads, chat and export routes.
- No endpoint fetches a user-supplied URL, so there is no SSRF surface.

## Secrets, logging and audit

- Secrets come from the environment only. `.env` files are git-ignored. Production start-up validation refuses the development database password, the development cookie secret, a missing encryption key, `http` URLs, insecure cookies, and the `memory`/`file` mail drivers (whose messages contain live tokens).
- Logs are structured (pino) with request IDs and redaction of `authorization`, cookies, `set-cookie`, passwords, tokens, OAuth codes and API keys. Dataset contents and question text are not logged.
- `audit_logs` is append-only (a trigger rejects update and delete; the runtime role lacks the privileges as well), has no foreign keys so it outlives users and workspaces, and records sign-ins, registrations, lockouts, password changes, membership and role changes, uploads, processing results, exports, saved dashboards, plan changes and billing events, with actor, IP and request ID. Owners and admins can read their workspace's trail in the app.
- Metrics (`/metrics`) are disabled in production unless `METRICS_TOKEN` is set, and require it as a bearer token when set.

## Privacy and the AI provider

When an AI provider is configured, the following leave your infrastructure for that provider: the dataset's column names and semantic types, up to 12 common values for up to 8 category columns, row/column counts and date range, the question text and conversation so far, and the summaries and formatted figures of tool results (aggregates, names of ranked entities). Raw rows and structured tool payloads are never sent. Turning the provider off (`AI_PROVIDER=none`) sends nothing anywhere and answers remain available in their computed form. Check the provider's data-retention terms before enabling it for regulated data.

## Deleting data

Deleting a dataset marks it `deleting` and a job removes its stored objects; deleting a workspace (owner only, name confirmation required) removes its rows through cascading foreign keys and its objects by prefix. Audit records are retained by design. Backups follow your database and object-store retention.

## What this does not cover

- The identity tables (`users`, `sessions`, `oauth_identities`, `email_tokens`) hold no tenant data and have no row-level security: the runtime role can read and write them as the application needs to sign people in. A fully compromised API process could therefore read every user's email and password hash, and could insert a session for any user, so the tenant-isolation layers do not protect against a process-level compromise of the API itself. What the database does still prevent is that process rewriting plans, billing or platform-admin flags, editing the audit trail, or reading other tenants' rows without a valid workspace context.
- No SSO/SAML, no MFA, no per-IP allow-lists, no customer-managed keys, no field-level encryption of database columns.
- No automated malware scanning of uploads (files are parsed as data, never executed or served back for viewing except as your own export).
- Penetration testing, a dependency-vulnerability process, and a formal review of the SQL policies by someone other than the author have not been done. Run `npm audit` and review before exposing this to real customers.
- The S3 storage driver has not been exercised by an automated test; verify bucket policy and encryption settings in your environment.
