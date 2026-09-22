# API reference

Base URL: `/api/v1` (behind the web app's nginx this is same-origin, so cookies and CSP need no special handling). Health, readiness and metrics live at the root: `/healthz`, `/readyz`, `/metrics`. The billing webhook is `/api/v1/billing/webhook`.

Every request and response body is JSON except file upload (`multipart/form-data`), exports (file bytes) and chat streaming (server-sent events). Request bodies are validated with strict zod schemas: **unknown fields are rejected** with `400`.

## Conventions

**Authentication.** A session cookie (`vn_session`, `HttpOnly`, `SameSite=Lax`, `Secure` in production). Any state-changing request carrying the cookie must also carry an `Origin` header that matches `PUBLIC_WEB_URL` or `CORS_ORIGINS`; browsers do this automatically.

**Workspace scoping.** Everything a workspace owns lives under `/workspaces/:workspaceId/…`. The caller must be a member; otherwise the response is `404 not_found`, indistinguishable from a workspace that does not exist. Roles then gate each route (see the matrix below).

**Errors.** One envelope everywhere; the message is written for end users and never contains SQL, stack traces or internals:

```json
{ "error": { "code": "plan_limit", "message": "Your Free plan allows 3 datasets.", "details": { "limit": "maxDatasets" }, "requestId": "…" } }
```

| Status | `code` | Meaning |
|---|---|---|
| 400 | `bad_request`, `bad_json`, `bad_signature` | Invalid body/params, malformed JSON, bad webhook signature |
| 401 | `unauthorized` | Not signed in, or session expired/revoked |
| 402 | `plan_limit` | A plan limit was reached; `details.limit` names it (`maxDatasets`, `maxUploadBytes`, `maxRowsPerDataset`, `maxMembers`, `storageBytes`, `exportsPerMonth`, …) so a client can show an upgrade prompt |
| 403 | `forbidden` | Signed in and a member, but the role does not allow it (or a plan feature is off) |
| 404 | `not_found` | Missing, or not visible to you |
| 409 | `conflict`, `email_taken`, `already_member`, `last_owner`, `still_processing`, `demo_exists`, `already_on_plan`, `no_subscription`, `dataset_not_ready` | State conflicts; the workspace must always keep an owner |
| 422 | `unprocessable`, `weak_password`, `invalid_token`, `invalid_invitation`, `email_not_verified`, `limit`, or a tool error code | Well-formed but not acceptable |
| 429 | `rate_limited` | Rate limit; honour `Retry-After` |
| 500/501/502 | `internal`, `storage_*`, `billing_disabled`, `billing_error`, `billing_unavailable` | Server side, or billing not configured |

Every response carries an `x-request-id` header equal to `error.requestId`; quote it when reporting a problem and it will find the log lines and audit records.

**Rate limits.** Global `RATE_LIMIT_GLOBAL_PER_MIN` (default 600) per client IP. Stricter: auth routes `RATE_LIMIT_AUTH_PER_MIN` (default 10), uploads 30/min, chat 30/min, analysis, rows, export and tool-run 120/min.

## Permission matrix

The single source of truth is `apps/api/src/permissions.ts`; `/auth/me` returns each workspace's resolved `permissions` array so the UI never guesses.

| Action | Owner | Admin | Analyst | Viewer |
|---|:-:|:-:|:-:|:-:|
| `workspace.read`, `member.read`, `dataset.read`, `chat.ask` | ✓ | ✓ | ✓ | ✓ |
| `dataset.create` / `update` / `delete` / `export`, `dashboard.save`, `usage.read` | ✓ | ✓ | ✓ | |
| `workspace.update`, `member.invite` / `remove` / `role`, `billing.read`, `audit.read` | ✓ | ✓ | | |
| `workspace.delete`, `billing.manage` | ✓ | | | |

Role management has one more rule, enforced both in the API and by the database's policies: admins may only add, change or remove analysts and viewers; only owners touch admins and owners. Any member may remove themselves; the last owner cannot.

## Auth

| Method and path | Body / query | Notes |
|---|---|---|
| `GET /auth/config` | | Public. Which features are on: registration, email verification, Google, AI provider name, billing, and the plan catalogue (id, name, price, limits, features) |
| `POST /auth/register` | `{ email, password, name }` | `201`, sets the session cookie, creates a personal workspace. Password 10–128 characters; `422 weak_password` says why |
| `POST /auth/login` | `{ email, password }` | Same error for unknown email and wrong password. Locks the account for 15 minutes after 10 consecutive failures |
| `POST /auth/logout` | | Revokes this session |
| `GET /auth/me` | | `{ user, workspaces: [{ id, name, role, permissions }] }` |
| `PATCH /auth/profile` | `{ name }` | |
| `POST /auth/verify-email` | `{ token }` | Token from the emailed link |
| `POST /auth/resend-verification` | | |
| `POST /auth/forgot-password` | `{ email }` | Always `{ ok: true }`, whether or not the account exists |
| `POST /auth/reset-password` | `{ token, password }` | Revokes every session and clears any lockout |
| `POST /auth/change-password` | `{ currentPassword, newPassword }` | Revokes the other sessions |
| `GET /auth/sessions` | | Includes `current: true` on this one |
| `DELETE /auth/sessions/:id` | | |
| `POST /auth/sessions/revoke-others` | | |
| `GET /auth/oauth/google/start` | | Redirects to Google (PKCE + signed state cookie). `404` when Google isn't configured |
| `GET /auth/oauth/google/callback` | `code`, `state` | Redirects into the web app, or to `/login?error=…` |

## Workspaces, members, billing

| Method and path | Permission | Body / notes |
|---|---|---|
| `GET /workspaces` | signed in | Your workspaces |
| `POST /workspaces` | signed in | `{ name }`. Always starts on the default plan; a plan can never be client-supplied |
| `GET /workspaces/:ws` | `workspace.read` | Workspace, your role and permissions, plan limits and features |
| `PATCH /workspaces/:ws` | `workspace.update` | `{ name }` |
| `DELETE /workspaces/:ws` | `workspace.delete` | `{ confirm }` must equal the workspace name |
| `GET /workspaces/:ws/members` | `member.read` | `{ members, invitations }`; invitations only for owners and admins |
| `POST /workspaces/:ws/invitations` | `member.invite` | `{ email, role }`. Emails a single-use link valid 7 days. Counts toward `maxMembers` |
| `DELETE /workspaces/:ws/invitations/:id` | `member.invite` | Revoke |
| `PATCH /workspaces/:ws/members/:userId` | `member.role` | `{ role }` |
| `DELETE /workspaces/:ws/members/:userId` | `member.remove` (or yourself) | |
| `GET /invitations/preview?token=` | public | Workspace name, inviter, role. Nothing else |
| `POST /invitations/accept` | signed in | `{ token }`. The signed-in email must match the invited email |
| `GET /workspaces/:ws/usage` | `usage.read` | This period's usage against each limit |
| `GET /workspaces/:ws/audit?limit=&before=` | `audit.read` | Newest first; `before` is an event id for paging |
| `GET /workspaces/:ws/billing` | `billing.read` | `{ enabled, plan, subscription, hasCustomer }` |
| `POST /workspaces/:ws/billing/checkout` | `billing.manage` | `{ plan }` → `{ url }` to the payment provider's hosted checkout |
| `POST /workspaces/:ws/billing/portal` | `billing.manage` | → `{ url }` |
| `POST /billing/webhook` | signature | Verified against the raw body; idempotent by event id. Configure it in Stripe |

## Datasets

`:ds` is the dataset id. All routes are under `/workspaces/:ws/datasets`.

| Method and path | Permission | Notes |
|---|---|---|
| `GET /` | `dataset.read` | Datasets, plus the ordered list of pipeline `stages` for progress display |
| `POST /` | `dataset.create` | `multipart/form-data` with a `file` field and optional `name`. `202 { datasetId, versionId, jobId }`. Refused from `Content-Length` alone when over the plan's upload limit. Processing happens in the job worker |
| `POST /demo` | `dataset.create` | Creates the bundled demo retail dataset. `409 demo_exists` if already there |
| `GET /:ds` | `dataset.read` | Status (`queued`, `processing`, `ready`, `failed`, `deleting`), current version, warnings, and the active job |
| `PATCH /:ds` | `dataset.update` | `{ name }` |
| `DELETE /:ds` | `dataset.delete` | Marks it `deleting`; a job removes the stored objects |
| `POST /:ds/reprocess` | `dataset.update` | `{ options }` → `202 { versionId, jobId, version }`. Creates a **new version**; earlier versions are untouched (below) |
| `GET /:ds/versions` | `dataset.read` | Version list with the transformation counts and quality score |
| `POST /:ds/versions/:v/activate` | `dataset.update` | Make an earlier version current |
| `GET /jobs/:jobId` (under `/workspaces/:ws`) | `dataset.read` | `{ status, progress, error, stages, … }`, for polling |
| `POST /jobs/:jobId/cancel` (under `/workspaces/:ws`) | `dataset.update` | `{ cancelled }` |

Processing options (all optional; each change makes a new immutable version):

```json
{ "tableIndex": 0, "removeDuplicates": false, "normalizeLabels": false,
  "dateOrders": { "Order Date": "dmy" }, "excludeColumns": ["Notes"] }
```

`removeDuplicates` and `normalizeLabels` are the two fixes that change the data's meaning, so they are only ever applied when asked for; everything else the cleaner does is lossless and appears in the version's transformation log.

## Analysis

All routes are under `/workspaces/:ws/datasets/:ds` and require `dataset.read` unless noted. They return `409 dataset_not_ready` until processing has finished.

| Method and path | Body | Returns |
|---|---|---|
| `GET /profile` | | Dataset, version, per-column profile (type, semantic meaning with the reasons, additivity, stats), and the dataset document (default metric, date range, granularity) |
| `GET /quality` | | Score (0–100), issues with plain-language explanations, the full transformation log, offered fixes, ingest warnings |
| `GET /insights` | | Ranked insights, each with its score components |
| `GET /starter-questions` | | Questions this dataset can actually answer |
| `POST /dashboard` | `{ filters?, dateFrom?, dateTo?, widgets?, dashboardId? }` | The dashboard view (widgets with charts, facts and provenance) over the optional filters. With no `widgets` the planned dashboard is used |
| `GET /dashboards` · `POST /dashboards` · `PUT /dashboards/:id` · `DELETE /dashboards/:id` | `{ name, widgets }` | Saved dashboards (`dashboard.save`; up to 25 per dataset). Widgets name a tool and its parameters; unknown tools are refused |
| `GET /tools` | | The tools this dataset supports, with parameter schemas, and the ones it doesn't support with the reason |
| `POST /tools/run` | `{ tool, params, filters? }` | Runs one tool directly: `{ summary, facts, chart, provenance, data }`. The same registry the AI uses |
| `GET /columns` | | Columns and the filter controls the data supports, plus row count |
| `POST /rows` | `{ filters?, search?, offset?, limit≤200, sort?, columns? }` | A page of rows for the explorer |
| `POST /export` | `{ format: csv\|xlsx\|json, filters?, search?, sort?, columns? }` | `dataset.export`; metered and audited; cells that could run as spreadsheet formulas are neutralised |

**Filters** apply identically to the dashboard, tools, explorer, chat and export:

```json
{ "column": "Region", "op": "in", "values": ["West", "East"] }
```

`op` is one of `eq neq in not_in contains gt gte lt lte between is_null not_null`. At most 20 per request.

**Tools:** `aggregate`, `anomalies`, `cohort_retention`, `compare_groups`, `compare_periods`, `correlation`, `cross_tab`, `customer_analysis`, `data_quality`, `describe_column`, `describe_dataset`, `distribution`, `explain_change`, `find_value`, `forecast`, `funnel`, `group_by`, `list_values`, `outliers`, `pareto`, `profitability`, `seasonality`, `share_of_total`, `time_series`, `top_n`, `trend`, `volume_vs_margin`. Which of them a dataset offers depends on what the profiler found (a dataset without dates has no `trend`; one without a cost column has no `profitability`), and `GET /tools` says why any is missing. A tool that cannot run returns `422` with its own `code`, a message, and often a `hint`.

## Chat

| Method and path | Permission | Notes |
|---|---|---|
| `POST /chat` | `chat.ask` | Body `{ message (≤ 2000 chars), conversationId?, filters? }` |
| `GET /conversations` | `chat.ask` | Your conversations on this dataset (conversations are private to the user who started them) |
| `GET /conversations/:id` | `chat.ask` | Messages with their verified answer, sources, charts, follow-ups, grounding report |
| `DELETE /conversations/:id` | `chat.ask` | |
| `POST /workspaces/:ws/messages/:messageId/feedback` | `chat.ask` | `{ value: 1 \| 0 \| -1 }` |

With `Accept: text/event-stream` the answer streams as server-sent events; without it, the completed answer is returned as one JSON body. Events:

| Event | Data |
|---|---|
| `meta` | `{ conversationId }`, first |
| `tool_start` | `{ type, callId, tool, params }` |
| `tool_result` | `{ type, callId, tool, ok: true, summary, chart?, provenance }` or `{ …, ok: false, message }` |
| `text` | `{ type, delta }`: **only sentences that have already been verified** |
| `final` | The complete answer (below) |
| `error` | `{ message, requestId }` if the turn could not complete |

A `: keep-alive` comment is sent every 15 seconds. The final payload:

```json
{
  "conversationId": "…", "messageId": "…",
  "answer": "…", "mode": "llm | deterministic | no_answer", "replaced": false,
  "sources": [ { "callId": "…", "tool": "top_n", "params": { … }, "summary": "…", "provenance": { … }, "factCount": 5 } ],
  "charts": [ … ], "followUps": [ "…" ],
  "grounding": { "sentences": 6, "numericSentences": 4, "dropped": 1, "dropRatio": 0.25 },
  "facts": [ … ],
  "warnings": [ "…" ], "usage": { "inputTokens": 0, "outputTokens": 0 }, "provider": "anthropic", "model": "…"
}
```

`replaced: true` means text that already streamed has been superseded by `answer`, and the client should swap it in. `grounding` carries counts only, never the removed text. When the plan has no AI messages left, or no provider is configured, `mode` is `deterministic` and a `warnings` entry says why. Only `mode: "llm"` uses up an AI message.

## Admin (platform administrators only)

`403` for everyone else. These call the database's admin functions and return aggregates and metadata, never dataset contents.

| Method and path | Notes |
|---|---|
| `GET /admin/overview` | Counts of users, workspaces, datasets, jobs, usage |
| `GET /admin/workspaces?q=&limit=&offset=` | Workspaces with plan, members, dataset count, storage |
| `GET /admin/jobs?status=&limit=` | Recent jobs across tenants |
| `GET /admin/audit?limit=` | Recent audit events across tenants |
| `POST /admin/workspaces/:ws/plan` | `{ plan }`; audited as `admin.set_plan` |

## System

| Path | Notes |
|---|---|
| `GET /healthz` | Liveness: the process is up |
| `GET /readyz` | Readiness: `503` when the database can't be reached |
| `GET /metrics` | Prometheus text. In production disabled unless `METRICS_TOKEN` is set, and then requires `Authorization: Bearer <token>` |

Metrics: `http_requests_total`, `http_request_duration_seconds`, `jobs_total`, `job_duration_seconds`, `datasets_created_total`, `chat_messages_total{mode}`, `chat_dropped_sentences_total`, `billing_events_total`, `frame_cache_bytes`, `frame_cache_entries`.

## Audit action names

`auth.register`, `auth.login`, `auth.locked`, `auth.email_verified`, `auth.reset_requested`, `auth.password_reset`, `auth.password_changed`, `auth.sessions_revoked`, `workspace.create`, `workspace.rename`, `workspace.delete`, `member.invite`, `member.invite_revoked`, `member.joined`, `member.left`, `member.removed`, `member.role_changed`, `dataset.upload`, `dataset.create_demo`, `dataset.processed`, `dataset.failed`, `dataset.rename`, `dataset.reprocess`, `dataset.set_version`, `dataset.delete`, `dataset.export`, `dashboard.save`, `billing.event`, `admin.set_plan`.
