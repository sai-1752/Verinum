# Architecture

## The contract everything else serves

> The AI reasons only over computed analytical results. It never invents statistics. Every number it states must be traceable to a tool result; a number that cannot be traced is not shown.

That sentence decides the shape of the system. Analysis is done by deterministic code (`packages/core`) that returns *structured results with provenance*. The language model is a planner and a narrator around that code, never a calculator, and everything it says is checked afterwards. The rest of the architecture — typed columns, structured evidence, capability-gated tools, a sentence-level output gate — exists to make that check possible and cheap.

## Components

```
                         ┌────────────────────────── browser ──────────────────────────┐
                         │ React SPA: charts, dashboards, chat (SSE), explorer, admin  │
                         └───────────────────────────────┬─────────────────────────────┘
                                                         │  same origin: /api  (cookies, no CORS)
                                            ┌────────────▼────────────┐
                                            │ nginx (prod) / Vite (dev)│
                                            └────────────┬────────────┘
                                                         │
┌────────────────────────────────────────────────────────▼────────────────────────────────────────────┐
│ apps/api  (Fastify 5, zod)                                                                          │
│  routes ─► services ─► tenant-scoped DB access (RLS) ─► Postgres                                    │
│    │           │                                                                                    │
│    │           ├─► ScopedStore ─► EncryptedStore (AES-256-GCM) ─► local disk | S3                    │
│    │           ├─► job queue (Postgres, SKIP LOCKED) ─► worker loop (same process or separate)      │
│    │           │       └─► pipeline: read → extract → clean → profile → quality → insights → dashboard│
│    │           ├─► packages/ingest  (format sniffing, extractors, sandboxed .xls, bounded zip)      │
│    │           └─► packages/core    (Frame, profiler, tools, insights, dashboard, chat, grounding)  │
│    └─► LLM adapters (Anthropic / OpenAI over fetch, SSE)   Stripe (fetch + HMAC)   SMTP / file mail │
└─────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

Three deployable pieces (web, API, Postgres) and two optional integrations (object storage, an LLM provider). The API can run its job worker in-process (`WORKER_ENABLED=true`, the default) or as separate processes; both claim work the same way.

### `packages/core` — the engine (no I/O)

Pure TypeScript with no filesystem, network or clock access, which is what makes it testable to the digit and runnable under any time zone.

- **Frame.** A typed, columnar table. Each column is a typed array plus a validity mask, parsed once. Dates are stored as *civil-day integers* (days since an epoch), never as `Date` objects, so no result can depend on the server's time zone. Frames serialise to a compact gzip form for storage and are cached in memory (`FRAME_CACHE_MB`).
- **Cleaning (`clean.ts`, `clean-actions.ts`).** Turns raw cells into typed columns. Decides date order (day-first or month-first) *per column* from the evidence, handles thousands/decimal conventions and currency symbols, normalises blank markers, trims, and records every change as a `Transformation`. Destructive fixes (remove duplicates, merge label variants) are *suggestions* that create a new version when applied.
- **Profiler (`profile.ts`).** Semantic classification of each column with reasons and confidence: type, meaning (revenue, cost, profit, price, discount, quantity, rate, region, product, customer…), whether it is *additive* (may be summed), default aggregation, unit. Free text is detected before identifiers so a sentence column is never treated as an ID. Derives *capabilities* — what the data can support — from the profile.
- **Quality (`quality.ts`).** A 0–100 score built from missing values, duplicates, implausible values, ambiguous dates and inconsistent labels, weighted by how much data each affects.
- **Tools (`tools/`).** About 27 typed analyses, each declaring the capabilities it needs. A tool that the data cannot support is not offered to the model at all; it is not merely allowed to fail. Every tool returns a `ToolResult`: a human summary, a list of `Fact`s (each number with a label, unit and display string), an optional `ChartSpec`, and a `Provenance` (tool, parameters, rows considered, filters, period, method, caveats).
- **Analytics (`analytics/`).** The mathematics: aggregation, group-by, complete-period detection, trend regression, MAD-based anomaly detection on detrended series, seasonality, forecasting with backtested model choice, correlation with tautology detection, concentration (normalised HHI), profitability.
- **Insights (`insights/`).** Generators emit structured `Insight`s (kind, evidence facts, method, chart, follow-ups). A separate ranking step scores each on magnitude, significance, novelty/actionability and data completeness (`RANK_WEIGHTS`), and the score breakdown is shown to the user.
- **Dashboard (`dashboard.ts`).** Plans widgets from capabilities (`WidgetSpec`), materialises them by running the same tools (`DashboardView`), and applies dashboard-wide filters. Saved dashboards store the specs, never data.
- **Grounding (`grounding/`, `facts.ts`).** The fact ledger, numeric-claim extractor and sentence gate described in [AI-GROUNDING.md](AI-GROUNDING.md).
- **Chat (`chat.ts`, `planner.ts`).** The provider-agnostic loop, and a deterministic planner that maps a question to a tool without any model. Emits events (`tool_start`, `tool_result`, `text`, `final`) that the API forwards as server-sent events.
- **Charts (`charts.ts`).** A renderer-agnostic `ChartSpec` (bar, line, scatter, histogram, heatmap, funnel, table). The web app renders it; the engine never knows about a renderer.

### `packages/ingest` — files to tables

Detects the format from the bytes (magic numbers and content), not the extension, then extracts one or more candidate tables. Formats: CSV/TSV/other delimited (delimiter and quoting sniffed, BOM and encoding detected), fixed-width, XLSX (all sheets, native cell types), legacy XLS (parsed in a resource-limited worker thread with an empty environment and a timeout), JSON/NDJSON (arrays, nested records flattened), XML, HTML tables, PDF tables (text clustering), DOCX tables, plain text. Files with several tables produce an `availableTables` list; the user can pick another table and the dataset reprocesses as a new version.

Hostile-input limits apply to every format (`IngestLimits`): byte size, rows, columns, characters per cell, total uncompressed bytes in a container, zip entry count, per-entry compression ratio, PDF pages, sheets, and a wall-clock budget. ZIP containers (XLSX, DOCX) are inflated through a streaming decoder that counts bytes actually produced, not the sizes the archive claims.

### `apps/api` — the service

| Concern | Where |
|---|---|
| HTTP, validation, errors | `app.ts`, `routes/*`, `errors.ts` (zod-validated bodies; every error is `{error:{code,message,details?,requestId}}`) |
| Authentication | `auth/` (opaque cookie sessions, scrypt, lockout, Google OAuth with PKCE) |
| Workspaces and roles | `workspaces/`, `permissions.ts` (one permission matrix used by routes and sent to the UI) |
| Tenant-scoped data access | `db/` (transactions that set `app.user_id` / `app.workspace_id` for row-level security) |
| Datasets and pipeline | `datasets/` (upload, versions, reprocess, pipeline, export) |
| Background work | `jobs/` (queue, worker, handlers) |
| Storage | `storage/` (`ScopedStore` enforces the `w/<workspace>/` prefix; `EncryptedStore`; local and S3 drivers) |
| Plans and usage | `plans.ts` + `config/plans.json`, `usage.ts` |
| Chat | `chat/`, `ai/` (Anthropic and OpenAI adapters over `fetch`, SSE parsing, retries, timeouts) |
| Billing | `billing/` (Stripe checkout/portal over `fetch`, webhook signature verification, idempotency) |
| Observability | `logger.ts` (pino, secrets redacted), `metrics.ts` (Prometheus text), `routes/system.ts` (health, readiness, metrics) |
| Audit | `audit.ts` (append-only) |

### `apps/web` — the app

React 18, Vite, Tailwind, React Router, TanStack Query, Recharts. The browser talks only to its own origin at `/api`. Heavy pages (dashboard, forecast, explorer, data, admin) are lazy-loaded so the charting library is not in the entry bundle. Charts always come with a "Show data" table, so no information exists only as pixels.

The visual identity is *the thread*: a figure that has been checked against a computed result carries a highlighter mark, and hovering or focusing it shows which calculation it came from. That is the product's guarantee made visible, and the marker is rendered only where the server has already removed unverifiable sentences.

## Data flow: upload to dashboard

1. `POST /workspaces/:id/datasets` streams the multipart body to a size-limited buffer, checks role and plan (dataset count, file size, storage), sniffs the format, stores the **original** encrypted under `w/<workspace>/datasets/<id>/v1/original`, creates the dataset and version rows, enqueues a `dataset.process` job, and returns `202`.
2. A worker claims the job (`SKIP LOCKED`, lease, heartbeat) and runs the pipeline in the job's own tenant context, reporting progress per stage: **Reading the file → Finding the data table → Cleaning and typing columns → Profiling columns → Scoring data quality → Generating insights → Building the dashboard.** The UI polls the dataset and shows those stages.
3. Ingest runs first (in a worker thread for legacy `.xls`), then the engine cleans, profiles, scores, ranks insights and plans the dashboard. The typed frame is stored (encrypted, gzip); profile, quality, transformation log, suggestions, insights and dashboard plan are stored on the version row.
4. Row limits for the plan are enforced against the *parsed* row count. Failures are classified: bad input (`PermanentJobError`, no retry, message shown to the user) versus transient (retry with backoff, up to three attempts).
5. The dataset flips to `ready` and becomes the current version, in one transaction. Everything the UI shows afterwards is read from stored results or recomputed from the cached frame.

Applying a suggested fix, choosing another table, excluding a column, or overriding date order creates **version N+1** from the *original* upload with new options. Versions are immutable; switching back is instant.

## Data flow: a question

1. `POST …/datasets/:id/chat` (Accept: `text/event-stream`). The API checks role, the AI allowance, and loads the frame.
2. The chat loop offers the model only the tools the data supports and a system prompt with the data description and grounding rules. The model never receives rows.
3. Each tool call runs in the engine; the result (summary, facts, caveats, scope) goes back to the model as the tool output and to the browser as a `tool_result` event.
4. The model's text is streamed through the **sentence gate**. A sentence containing a number that no fact in the ledger supports (rounding-aware, direction-aware) is dropped and counted; nothing is emitted before its sentence is complete and checked.
5. If too many numeric sentences were dropped (ratio above 0.34), the answer is empty, or the provider errored, the answer is replaced by the deterministic one built from the tool summaries. The `final` event carries the answer, mode (`llm`, `deterministic`, `no_answer`), sources with provenance, charts, follow-ups, and grounding *counts* (never the removed text).
6. The turn is stored. Only `llm` turns count against the AI allowance.

## Multi-tenancy in one paragraph

A workspace is the tenant. The API resolves the workspace from a verified membership on every request (a non-member gets **404**, so existence isn't revealed); every query names `workspace_id`; and Postgres enforces it independently with row-level security keyed on a per-transaction setting, so a forgotten `where` clause returns nothing rather than someone else's data. The runtime database role owns nothing and cannot bypass RLS. The few operations that must cross tenants (claiming jobs, accepting an invitation, billing webhooks, the admin console) are `SECURITY DEFINER` functions that are enumerated and tested. See [SECURITY.md](SECURITY.md) and [DATABASE.md](DATABASE.md).

## Decisions and why

- **A columnar, typed frame instead of rows of strings.** The prototype re-parsed every cell per aggregation; the frame parses once and makes million-row analysis cheap. It also makes results independent of locale.
- **Structured evidence instead of prose from analysis code.** Facts are `{value, unit, label, display}`. Prose is a rendering step, so the same result can be verified, charted, exported, or explained by a model.
- **Capability-gated tools.** Not offering a tool the data can't support is more reliable than teaching a model to read an error string.
- **Postgres for the queue.** One less system to run, transactional with the data, and enough for this workload. The queue interface is small enough to replace.
- **Opaque server-side sessions, not JWTs.** Revocation is immediate, nothing sensitive is in the cookie, and the cookie is `HttpOnly`.
- **Same-origin deployment.** Cookies stay first-party, CSRF surface shrinks, and no CORS is configured in production.
- **Fetch-based provider adapters.** Small, auditable, easy to mock; no SDK version drift.
- **Config-driven plans** (`config/plans.json`). Limits and features are data; changing a price or an allowance is not a code change.
- **Decision priority when they conflict:** correctness, then data security, tenant isolation, maintainability, analytical reliability, scalability, and finally UX.

## Limits of this design

- Frames live in the API process's memory (bounded cache); very large concurrent analyses need more RAM or a columnar store.
- The job worker shares a process with the API by default. Run it separately (`WORKER_ENABLED=false` on web-facing instances, dedicated worker instances) before load makes that matter.
- Exports and chat are rate-limited and metered per workspace; there is no global fairness scheduler across tenants.
