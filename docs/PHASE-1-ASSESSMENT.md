# Verinum — Phase 1: Assessment, Target Architecture, Migration, Roadmap

Status: Phase 1 deliverable. Written after unpacking and *running* the prototype, not just reading it.

## 0. How the prototype was inspected

The prototype arrived as one 4.4 MB `Verinum.html`. `engine.js` (1,499 lines), `extract.js` (588 lines), the demo CSV (6,764 lines), pdf.js and fflate are embedded as base64 assets and were decoded byte-for-byte. The UI is a ~550-line React component in a `text/x-dc` script with vendored React and SheetJS. The AI Analyst calls `api.anthropic.com` directly from the browser with a key stored in `localStorage`.

Evidence gathered by executing the prototype engine in Node against its bundled demo data (kept in `reference/prototype/` as a permanent parity baseline):

| Probe | Result |
|---|---|
| Demo dataset | 6,764 rows × 16 cols, quality 74/100, 14 insights, 14 duplicate rows |
| Golden numbers | total Sales 3,225,540.86 · margin 31.18% · top product Aura Watch 506,482.84 (15.7%) |
| Scale, 67,640 rows | parse 0.3 s + profile 1.8 s + insights 2.0 s, single thread, +170 MB RSS |
| Scale, 202,920 rows | parse 0.8 s + profile 5.9 s + insights 5.9 s (≈12 s), +222 MB RSS |
| `groupBy(..., "max")` on 300k rows | throws `RangeError: Maximum call stack size exceeded` (`Math.max(...e.vals)`) |
| Same file under three server timezones | primary-date range is a different instant in each (`2025-02-27T18:30Z` under IST vs `2025-02-28T08:00Z` under LA) |
| Free-text column (`note`: sentences) | classified as `id / id` |
| European decimals (`4.237,50`) | not parsed as numbers; column becomes `categorical` |

## A. Existing architecture assessment

### A1. What exists

- **`engine.js` — analytical core.** Column profiling, type/role inference, quality report, aggregation (`groupBy`, `timeSeries`), Pearson correlation, OLS trend, linear + seasonal-index forecast, a ~450-line insight generator, executive summary, suggested questions, and the 12-tool "agent toolbox" the LLM calls. Pure JS, no dependencies. **This is the asset worth preserving.**
- **`extract.js` — multi-format extraction.** PDF (text-position clustering), DOCX, JSON/NDJSON, XML, HTML, fixed-width, plus a screenplay/prose structurer that derives scene/character/paragraph/term tables from unstructured text. Browser-only (DOM, `window`, CDN loaders).
- **UI.** Landing → upload → table review → processing steps → six tabs (Summary, Data Overview/Quality, Insights, Dashboard, AI Analyst, Data Explorer), dark/light theme, offline-capable.
- **AI wiring.** Tool-use loop (max 8 turns) with JSON-only final answer, client-side.

### A2. Analytical safeguards that must survive (mapped to code, with the new home)

| # | Safeguard | Where it lives in the prototype | How it is preserved in the rebuild |
|---|---|---|---|
| 1 | Timezone bugs | `toDate` builds date-only ISO strings as *local* dates (`engine.js:101-105`) | Stronger: dates become **civil-day integers**; the `Date` object is never used in analytics, so results are independent of server TZ. Test suite runs under 3 TZs. |
| 2 | Phantom periods | same fix as #1; period keys from local getters | Period keys computed by integer civil arithmetic (`core/time`). |
| 3 | Incomplete-period distortion | `completePeriods` (`:412`) trims edge buckets < 30% of median row count | Ported, and applied **everywhere**. The prototype applies it in insights/KPIs/forecast but *not* in `time_series_analysis` (trend fit includes a partial tail) or in `compare_periods` (defaults to last vs previous raw period). Both are fixed. |
| 4 | Extreme % headlines from partial periods | consequence of #3 | Insight generators receive only complete-period series; "latest vs previous" also uses complete periods. |
| 5 | Blank groups → bad recommendations | `BLANK` + `material()` (`:619-625`) | Ported; `(blank)` can never be named as leader/laggard/recommendation target. |
| 6 | Concentration firing on even data | normalised HHI + baseline multiple (`:629-639`, gate at `:747`) | Ported with the same three-part gate (k ≥ 5, ≥1.4× baseline, normalised HHI ≥ 0.15). |
| 7 | Tautological correlations | name-containment, |r| ≥ .99, constant-ratio test (`:910-929`) | Ported **and** applied inside the correlation *tool*. In the prototype the tool returns unfiltered pairs, so tautologies reached the LLM. |
| 8 | Incorrect margin | derived margin only from an *additive* profit column (`:611-612`) | Ported; margin tool refuses non-additive numerators. |
| 9 | Free text classified as identity | only patched in customer-column selection (`:947-948`); the profiler itself still yields `id` for free text (probe above) | Fixed at the source: the semantic profiler measures word count/length/format regularity and emits `text` before `identifier`. |
| 10 | Profit insights needing additive columns | `additive` flag (`:205-212`) | Ported into the semantic model; every tool declares whether it needs additive measures. |
| 11 | "Share/rate and caption columns" | shares/rates never summed (`additive`); near-unique caption columns never dimensions (`uniquePct ≤ 50`, `:246-248`) | Ported. *Interpretation note:* I read "cross-tenant … share/rate and caption columns" as these cross-tabulation guards, since multi-tenancy is a separate concern here. Tell me if you meant something else. |

### A3. Reusable / obsolete / problematic

**Reusable (port the logic, not the file):** `numStats`/`quantile`, `histogram`, `pearson`, `linreg`, `completePeriods`, `concentration`, `material`, forecast gating and assumptions text, the insight generator's *rules and thresholds* (not its string-building), `qualityReport` checks, `structureDocument` + screenplay/prose parsing, the extractors' heuristics (`scoreGrid`, PDF clustering, fixed-width detection), the tool descriptions, the system-prompt rules.

**Obsolete:** `window.XLSX`/`window.__resources`/blob-URL loaders, CDN script loading, `readDataFile`, `downloadCSV/XLSX` (DOM), the browser-direct Anthropic call and API-key prompt, `localStorage` key handling, the `x-dc` component wrapper, `sampleIdx` (dead code), the global insight ID counter.

**Architectural problems**

1. **Rows are `Record<string,string>[]` and every aggregation re-parses strings** (`toNum` runs a regex per cell per call). This is the root of the scale numbers above. Needs typed columnar storage parsed once.
2. **Analysis and prose are welded together.** Generators build final English with `toLocaleString`-formatted strings inside the computation; evidence values are strings (`"$1.84M"`), so nothing downstream can verify, rank, chart or re-format them. Needs structured evidence (`{value:number, unit, provenance}`) with rendering as a separate step.
3. **Ranking is a 5-bucket label sort** (`Critical/High/Medium/Low`) with hand-set priorities; no magnitude, significance, novelty, completeness. Observed consequence on the demo: two separate "Wearables" insights, a "100% of customers repeat" non-finding, and "Sales +82% first→latest month" (endpoint comparison of a ramp-up month) sitting above a latest-vs-previous KPI of −7.7%.
4. **No grounding contract.** Tools return `JSON.stringify` of rounded values; the model's final JSON is parsed with `indexOf("{")`; nothing checks that numbers in `answer` came from a tool. The system prompt is the only defence.
5. **Tools leak raw data.** `sample_rows` and `filter_aggregate.alsoAvailable`/outlier `examples` send raw rows to the LLM, contradicting the privacy goal.
6. **Tools are not capability-gated.** They return an error *string* at call time (e.g. "no date column") rather than not being offered.
7. **Locale- and currency-dependent formatting** (`toLocaleString`, hard-coded `$`, `isMoney` by column name) make server output non-deterministic and wrong for ₹/€ data.
8. **Ambiguous parsing.** `dd/mm` vs `mm/dd` is decided per-cell (US default unless first part > 12) instead of per-column; European number formats unsupported; only the first XLSX sheet is read, after a lossy `sheet_to_csv` round trip that discards native cell types.
9. **Duplicate detection** hashes only the first 24 columns.
10. **`groupBy` crash** at ~100k+ rows per group (spread into `Math.max`).
11. **Forecast intervals** are residual-σ bands (not true prediction intervals) and the multiplicative seasonal index divides by the trend fit, which is unstable when the fit is near zero. Kept, but gated and labelled honestly; documented as a limitation.

**Security risks**

- Provider API key in browser `localStorage` and sent with `anthropic-dangerous-direct-browser-access` — unacceptable for SaaS; must be server-side only.
- Entire dataset, including raw sample rows, is reachable by the LLM tool layer (see A3-5).
- No auth, no tenancy, no upload validation (type sniffing is extension-only), no size limits, no zip-bomb/CSV-formula-injection defences on parse/export, XLSX parsing via a vendored SheetJS build on untrusted input.
- Nothing is persisted; there is nothing to protect *yet*, but every property in the SaaS spec (isolation, retention, deletion, audit) is absent by construction.

**Scalability problems**

- Blocks the UI thread for ~12 s at 200k rows; ~1M rows would exceed browser memory. Server-side, single-threaded compute needs typed arrays, worker isolation and a job queue.

### A4. Verdict

Keep the **knowledge** in `engine.js` (thresholds, guards, tool contracts, prompt rules) and `extract.js` (format heuristics, document structurer). Rewrite the **structure**: typed columnar frame, structured evidence, transparent ranking, grounded tool ledger, server-side everything. The prototype becomes a **parity oracle**: the new engine must reproduce its golden numbers on the demo dataset before any deliberate improvement is accepted.

## B. Target architecture

```
                        ┌────────────────────────────────────────────┐
 Browser (React SPA) ──▶│  Backend API (Fastify, modular monolith)   │
   marketing + app      │  auth · workspaces · datasets · analysis   │
                        │  analyst · usage · billing · admin · audit │
                        └───┬───────────┬───────────────┬────────────┘
                            │           │               │
                    PostgreSQL (RLS)  Object storage   AI providers
                    + job queue       (local/S3/R2)    (Anthropic/OpenAI)
                            ▲
                     Worker loop (same codebase, claims jobs with SKIP LOCKED)
```

Packages (npm workspaces, TypeScript strict, ESM):

| Package | Responsibility | Environment |
|---|---|---|
| `packages/core` | Frame, time, cleaning, semantic profiler, quality, analytics ops, forecast, insight engine + ranking, dashboard planner, tool registry + provenance ledger, claim validator, formatting | Pure TS, no I/O, runs in Node and browser |
| `packages/ingest` | File-type sniffing, safe extraction of CSV/XLSX/XLS/JSON/XML/HTML/PDF/DOCX/TXT/fixed-width, document structuring | Node only, executed in a worker thread with limits |
| `apps/api` | HTTP API, DB, storage, queue, auth, tenancy, AI orchestration, billing, admin | Node |
| `apps/web` | Marketing site + authenticated app | Browser |

### B1. Frontend
React 18 + TypeScript + Tailwind + Vite, React Router, TanStack Query for server state, Recharts for charts (wrapped in our own chart components so the visual language is ours). Routes: marketing (`/`, `/pricing`, `/privacy`), auth, and `/app/:workspaceId/{home,datasets,datasets/:id/{summary,overview,insights,dashboard,analyst,explorer}}`, plus `/admin`. Server-state only via typed API client; no hidden global state. Light/dark tokens, keyboard-navigable, semantic landmarks. Explorer is server-paginated (never ships full datasets to the browser).

### B2. Backend
Fastify 5 + zod validation, pino structured logs with request/user/workspace IDs, `@fastify/helmet|cors|cookie|multipart|rate-limit`. Modules communicate through plain TypeScript service functions (no microservices). Every tenant route resolves `workspaceId` from the URL, verifies membership + role in application code, then opens a transaction with tenant context (see B3). Consistent error envelope `{error:{code,message,requestId}}`; no stack traces to clients.

### B3. Database (PostgreSQL 16)
Tables: `users, sessions, email_tokens, oauth_identities, workspaces, workspace_members, datasets, dataset_files, dataset_columns, dataset_profiles, analyses, analysis_results, insights, dashboards, dashboard_widgets, conversations, messages, tool_calls, usage_events, subscriptions, audit_logs, jobs`. Every tenant-owned table carries a denormalised `workspace_id` so policies are single-column and index-friendly.

**Tenant isolation in three layers:** (1) route-level membership/role checks; (2) every query is written with `workspace_id = $n`; (3) **Row Level Security** with `FORCE ROW LEVEL SECURITY`: the API connects as a non-owner, non-superuser role, and each request/job transaction runs `set_config('app.user_id', …, true)` and `set_config('app.workspace_id', …, true)`. Policies compare `workspace_id` to the session setting, so a forgotten `WHERE` still returns nothing. `jobs` is reachable only through `SECURITY DEFINER` functions. Global tables (`users`, `sessions`, …) are accessed only by the auth module. RLS is defence in depth against application bugs, not against arbitrary SQL execution; this limit is documented in `SECURITY.md`.

### B4. Analytics architecture
`Frame` = immutable, columnar, typed: `Float64Array` measures (NaN = null), civil-day `Int32Array` dates, dictionary-encoded strings (`Uint32Array` codes). Parsed **once** at ingestion; all later operations are array scans. Pipeline: `raw table → clean (logged transformations) → typed frame → semantic profile (+confidence, reasons) → capability set → analytical ops → insights/dashboards (structured, stored)`. Frames are serialised to object storage (gzip'd columnar container) and loaded into an in-memory LRU for chat/explorer/dashboard queries. Scale path (documented, interface-compatible): swap the `Frame` backend for DuckDB/Parquet without touching tools or insight code.

### B5. AI architecture (the grounding contract)
```
question → LLM plans → tool call ──▶ Tool (pure function over Frame)
                                       └─▶ ToolResult { data, facts[], provenance }
                                                     │  facts appended to the turn's Ledger
LLM drafts answer ──▶ SentenceGate ──▶ each sentence's numbers must match Ledger ∪ question ∪ prior verified facts
                          ├─ pass  → streamed to user
                          └─ fail  → dropped (never shown), counted, user told "N statement(s) removed: not verifiable"
```
- `AIProvider` interface (`streamChat` with tools) with `AnthropicProvider` and `OpenAIProvider`; a registry selects the platform default from env; adding Gemini/Azure is one new class. Keys server-side only. A local "bring your own key" mode exists only when `VERINUM_MODE=development` and is off in production.
- **Capability-gated tool registry:** a tool is *offered to the model* only if the dataset's capability set satisfies its `requires` (e.g. no event date → no time-series/forecast tools; no additive profit → no profitability tools; no customer identifier → no customer tools).
- Tools never return raw rows beyond a small, explicitly-bounded, workspace-owner-visible sample flag; the LLM never receives the dataset.
- When no provider is configured or it fails, a **deterministic fallback planner** answers common question shapes (totals, top-N, trend, compare periods, forecast) directly from tools with templated grounded text and says why AI narration is unavailable.
- Conversation memory is stored, but only *entities in focus* (e.g. "it" → the last top product) and previously verified facts are carried; history never overrides tool results.

### B6. Storage
`ObjectStorage` interface (`put/getStream/delete/signedUrl`). Drivers: local filesystem (dev; HMAC-signed, expiring URLs served by the API) and S3-compatible (AWS, Cloudflare R2, Supabase Storage, MinIO). Keys are `ws/{workspaceId}/datasets/{datasetId}/{original|frame}/…`; buckets private; secure deletion removes all keys then the rows.

### B7. Authentication
Email + password (scrypt, per-user salt), opaque server-side sessions (hashed token in `sessions`, HttpOnly + SameSite=Lax + Secure cookie; revocable), email verification and password-reset via single-use hashed tokens, login throttling, optional Google OAuth (authorization-code flow, enabled by env). `Mailer` abstraction (log driver for dev, SMTP for prod).

### B8. Billing
Plans are configuration (`plans.ts`, env-overridable JSON): limits for file size, rows, datasets, storage, monthly AI requests/tokens, analysis runs, forecasts, exports, members. The backend enforces limits before every metered action and records `usage_events`. `BillingProvider` interface with a Stripe implementation (checkout, portal, webhooks → `subscriptions`) and a no-op provider for self-hosted/dev. Trial, upgrade, downgrade, cancel all flow through the provider + webhook, never the frontend.

## C. Migration strategy: offline HTML → SaaS without losing functionality

1. **Freeze** the prototype under `reference/prototype/` and capture golden outputs (done — see §0).
2. **Parity harness first.** The new `core` must reproduce the golden numbers (totals, group shares, KPI headlines, quality score, primary-date detection) on the demo CSV before it is allowed to differ. Each *intentional* behavioural difference (e.g. explicit text type, per-column date-order detection, trimmed default comparison) is listed in `docs/PARITY.md` with its own test.
3. **Port by layer, bottom-up:** time & frame → parsing/cleaning → profiler → analytics ops → forecast → insights → tools. Each layer lands with unit tests, including the regression tests for every safeguard in §A2.
4. **Feature map (nothing dropped):**

| Prototype | New home |
|---|---|
| Upload + table review (multi-table PDF/DOCX/JSON/XML/HTML) | Upload → `dataset_files` → *table picker* step when >1 candidate table; derived script/prose tables preserved |
| Processing steps | Job stages persisted on the dataset, polled/streamed to the same 7-step progress UI |
| Summary (KPIs, exec summary, top insights, suggested questions) | `/summary`, generated once at analysis time and stored |
| Data Overview / Quality | `/overview` + `dataset_columns`, `dataset_profiles` |
| Insights (categories, evidence, method, viz) | `/insights`, stored in `insights` with structured evidence and ranking factors |
| Dashboard (auto charts, forecast) | `/dashboard`, stored widget specs + on-demand filtered recompute |
| AI Analyst (tools, charts, trace) | `/analyst`, server-side orchestration, SSE, provenance drawer |
| Data Explorer | `/explorer`, server-paginated/sorted/filtered, CSV/XLSX export |
| Theme toggle, offline | Theme kept; offline mode dropped by design (server-side product) |

5. **Verify after each milestone** that the parity suite and the full regression suite still pass (`npm test`), and that the running app performs the previous milestone's user journeys.

## D. Implementation roadmap

Each milestone lists Objective · Files · Dependencies · Tasks · Tests · Definition of done.

**M0 — Repository & tooling.** *Objective:* reproducible workspace. *Files:* root `package.json`, `tsconfig.base.json`, `vitest` config, `.env.example`. *Deps:* Node 22, PostgreSQL 16. *Tasks:* workspaces, strict TS, lint/format, scripts. *Tests:* smoke test per package. *DoD:* `npm test` green on empty suites; CI-equivalent script runs.

**M1 — Core: frame, time, cleaning.** *Files:* `core/src/{frame,time,parse-values,clean}`. *Deps:* M0. *Tasks:* civil-date math, typed columns, value parsers (numbers incl. EU formats & currency/percent, dates with per-column day/month order detection), null tokens, transformation log, duplicates on all columns. *Tests:* unit + property tests; TZ matrix (UTC, America/Los_Angeles, Asia/Kolkata); phantom-period regression. *DoD:* demo CSV → frame in <1 s; TZ-independent output.

**M2 — Core: semantic profiler & quality.** *Files:* `core/src/{profile,semantic,quality,capabilities}`. *Tasks:* roles + confidence + reasons, additive detection, text-vs-identifier, primary event-date selection, quality report, capability set. *Tests:* free-text regression, share/rate additivity, caption columns, date-kind selection, parity with prototype profile. *DoD:* parity report shows every prototype role/type decision matches or is a documented improvement.

**M3 — Core: analytics operations.** *Files:* `core/src/analytics/*`. *Tasks:* stats, group/aggregate/rank, filters, growth/pct change, contribution & contribution-to-change, concentration, correlation (+tautology guard), outliers, anomalies, time-series (complete-period aware), period comparison, trend, seasonality, forecast (gated), profitability/margin, customer/product/regional, cohort, funnel. *Tests:* known-answer unit tests, regression tests for every safeguard, golden parity (totals, shares, margin). *DoD:* golden numbers reproduced exactly.

**M4 — Core: insight engine, ranking, dashboard planner.** *Files:* `core/src/{insights,ranking,summary,dashboard}`. *Tasks:* structured evidence, transparent score (magnitude, relevance, significance, novelty, confidence, completeness), de-duplication, suppression of trivial findings, exec summary, KPI selection, widget specs. *Tests:* ranking property tests, "0.2% is not a headline", partial-period headline regression, demo golden. *DoD:* demo yields ≤ the prototype's noise and surfaces its real findings.

**M5 — Core: tools, provenance, claim validation.** *Files:* `core/src/{tools,grounding}`. *Tasks:* ~35 tools with `requires`, provenance on every result, facts ledger, number extraction/normalisation/matching, `SentenceGate`. *Tests:* tool known-answers, gating matrix, validator positive/negative/fuzz cases. *DoD:* an invented number in any sentence is never emitted.

**M6 — Ingest package.** *Files:* `packages/ingest/src/*`. *Tasks:* magic-byte sniffing, safe extractors for all formats, table candidates + confidence, worker-thread execution with time/memory limits, zip-bomb caps, document structurer port. *Tests:* fixtures per format, malicious-file tests (bomb, wrong extension, huge cells), CSV-formula-escape on export. *DoD:* every format in the spec produces a table or a specific, human-readable refusal.

**M7 — API foundation.** *Files:* `apps/api/src/{config,db,auth,workspaces,security}`, SQL migrations. *Deps:* M0. *Tasks:* migrations, RLS + tenant tx helper, sessions, email flows, OAuth, roles, rate limits, audit log. *Tests:* auth flows, **cross-workspace access tests** (HTTP and raw-SQL/RLS level), role matrix. *DoD:* workspace A can neither read nor write B through any route or through SQL with A's context.

**M8 — Data platform.** *Files:* `apps/api/src/{storage,queue,pipeline,datasets}`. *Tasks:* upload (multipart, limits, sniffing), storage drivers, Postgres queue, staged pipeline with progress, lifecycle states, profile/insight/dashboard persistence, explorer endpoint, exports, secure delete. *Tests:* integration `upload → processing → analysis → dashboard`, failure paths, deletion completeness. *DoD:* demo and messy files complete end-to-end with visible progress.

**M9 — AI Analyst.** *Files:* `apps/api/src/{ai,analyst}`. *Tasks:* provider interface + Anthropic/OpenAI adapters, orchestration loop, SSE, sentence-gated streaming, fallback planner, conversation store, follow-up entity resolution, tool-call persistence. *Tests:* AI eval suite (known-answer questions), hallucination injection, adapter tests against protocol-faithful local servers. *DoD:* acceptance questions 12–17 pass with numerically exact, traceable answers.

**M10 — SaaS: usage, plans, billing, admin.** *Files:* `apps/api/src/{usage,billing,admin}`. *Tasks:* limits enforcement, usage events, Stripe provider + webhooks, admin API. *Tests:* limit-exceeded paths, webhook signature/idempotency, admin authorisation. *DoD:* limits enforced server-side; plan changes flow through billing provider.

**M11 — Web app.** *Files:* `apps/web/src/*`. *Tasks:* design system, landing/SEO, onboarding, all app pages, charts, chat UX (streaming, tool indicators, provenance drawer, retry/copy/export), explorer, admin, responsive + a11y. *Tests:* component tests, Playwright journey covering the 21 acceptance criteria, axe checks. *DoD:* new-user journey works in a real browser at desktop and mobile widths.

**M12 — Hardening & deployment.** *Files:* Dockerfiles, `docker-compose.yml`, docs (`README`, `ARCHITECTURE`, `API`, `DATABASE`, `SECURITY`, `AI-GROUNDING`, `DEPLOYMENT`, `TESTING`), `.env.*`. *Tasks:* prod builds, migrations runner, health/readiness, log hygiene, final verification. *Tests:* full suite + acceptance script against a fresh database. *DoD:* fresh clone → documented commands → working product.

## E. Decisions I made, and what cannot be verified in the build sandbox

**Decisions (change any of them and I will adjust):** rebuild in TypeScript rather than wrap the JS; modular monolith; in-process columnar engine now, DuckDB as scale path; PostgreSQL RLS + application authorisation; cookie sessions rather than JWT-only; sentence-gated streaming for the grounding contract; deterministic fallback when no AI key is present; Recharts for charting.

**Verified for real in the sandbox:** PostgreSQL 16 with RLS and the queue, the HTTP API, parsers, the analytics/insight engine, the grounding validator, the web build and a headless-Chromium user journey.

**Not verifiable without your credentials (implemented against the documented protocols and tested against local protocol-faithful mocks only):** live Anthropic/OpenAI calls, Stripe checkout/webhooks, S3/R2, SMTP delivery, Google OAuth. `DEPLOYMENT.md` lists a smoke test for each to run once real keys are configured.
