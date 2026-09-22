# Verinum

An AI data analyst for spreadsheets and data files, built around one rule: **the AI never invents a statistic.**

You upload a file. Verinum cleans it, works out what each column means, scores its quality, finds what stands out, builds a dashboard, and answers questions in plain English. Every answer follows the same path:

```
question → the model picks an analysis tool → the tool computes from your data
         → the result comes back with its working (rows used, filters, period, caveats)
         → the model words an explanation → every number in it is checked against the result
         → a sentence containing a number that can't be traced is removed before you see it
```

The model never sees your rows, and it is never trusted with arithmetic. If it fails, misbehaves, or is switched off, the answer is the computed one, stated plainly. See [docs/AI-GROUNDING.md](docs/AI-GROUNDING.md).

## What is in the box

| Area | What it does |
|---|---|
| Accounts | Email + password and Google sign-in, email verification, password reset, session management, lockout after repeated failures |
| Workspaces | Owner / Admin / Analyst / Viewer roles, invitations, per-workspace data isolation enforced in the database (row-level security), audit log |
| Ingestion | CSV, TSV, delimited and fixed-width text, XLSX, XLS, JSON/NDJSON, XML, HTML tables, tables inside PDF and DOCX, plain text. Encoding, delimiter, number and date formats are detected from the content, not the extension |
| Cleaning | Every automatic change is lossless and listed in a transformation log. Anything that removes rows or merges labels is offered as a fix, never applied silently. Each fix creates a new immutable version |
| Understanding | A semantic profiler classifies every column (revenue, cost, price, rate, date, identifier, free text…) and shows why. Data-quality score with plain-language issues |
| Analysis | ~27 tools: rankings, breakdowns, trends, period comparison, "why did it change", anomalies, seasonality, forecasting (gated on data sufficiency, always with a range), profitability, cohorts, correlations, customer analysis, pareto, funnels |
| Insights and dashboards | Ranked findings with visible scoring; a dashboard planned from what the data supports; filters that apply to every chart; saved dashboards |
| Chat | Streaming answers, follow-ups, conversation history, feedback, provenance on every figure |
| Product | Config-driven plans and usage limits, Stripe-ready billing, admin console, CSV/XLSX/JSON export (formula-injection safe), demo dataset, landing page |
| Operations | Postgres-backed job queue, structured logs with secret redaction, Prometheus metrics, health/readiness probes, Docker images |

## Quick start (development)

Requirements: Node 22+, PostgreSQL 16.

```bash
npm ci

# 1. database: two roles (owner for migrations, restricted app role for the API) and two databases
export PGHOST=127.0.0.1 PGUSER=postgres PGPASSWORD=<your postgres password>
./scripts/db-bootstrap.sh
npm run db:migrate

# 2. run it
npm run dev:api        # http://localhost:4000
npm run dev:web        # http://localhost:5173   (proxies /api to the API)
```

Open http://localhost:5173, create an account, and choose **Try the demo dataset**. Verification and reset emails are printed to the API's console (`MAIL_DRIVER=log`).

By default the AI provider is off, so every answer is the deterministic computed one. To let a model word the explanations, set `AI_PROVIDER=anthropic` and `ANTHROPIC_API_KEY` (or `openai`) in `apps/api/.env` — see [apps/api/.env.example](apps/api/.env.example). Grounding applies either way.

To make yourself a platform admin (for the `/admin` console):

```bash
npm run build -w @verinum/api
node apps/api/dist/admin.mjs promote you@example.com
```

## Quick start (containers)

```bash
cp .env.example .env        # set the three passwords, COOKIE_SECRET, STORAGE_ENCRYPTION_KEY, your URL and SMTP
docker compose up --build   # Postgres → migrations → API → web on http://localhost:8080
```

Production notes, TLS, backups, scaling and the checklist are in [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Repository layout

```
packages/core     the analysis engine: typed columns, profiler, cleaning, quality, tools, insights,
                  dashboard planner, forecasting, grounding (ledger + sentence gate), chat loop. No I/O.
packages/ingest   file → table extraction for every supported format, with size/zip-bomb/timeout limits
apps/api          Fastify API: auth, workspaces, RLS-backed data access, job queue, storage, billing, chat
apps/web          React + Vite + Tailwind single-page app
e2e               Playwright acceptance tests (real browser, real API, real Postgres, mock LLM)
deploy            nginx config and Postgres role bootstrap for the container stack
reference         the original offline prototype, kept as a parity oracle (see docs/PARITY.md)
docs              architecture, API, database, security, grounding, deployment, testing
```

## Tests

```bash
npm test               # 423 unit + integration tests (needs the verinum_test database)
npm run test:tz        # the engine suite again under three time zones
npm run typecheck && npm run lint
npm run test:e2e       # 33 browser tests: builds the API and web app, starts everything, drives Chromium
```

Details, and what each suite proves, in [docs/TESTING.md](docs/TESTING.md).

## Documentation

- [ARCHITECTURE](docs/ARCHITECTURE.md) — components, data flow, the processing pipeline, design decisions
- [AI-GROUNDING](docs/AI-GROUNDING.md) — how the "never invents a number" guarantee is built and tested
- [SECURITY](docs/SECURITY.md) — threat model, tenant isolation, authentication, upload hardening
- [DATABASE](docs/DATABASE.md) — schema, row-level security, the SECURITY DEFINER functions
- [API](docs/API.md) — endpoint reference
- [DEPLOYMENT](docs/DEPLOYMENT.md) — configuration, containers, operations, checklist
- [TESTING](docs/TESTING.md) — test strategy and acceptance-criteria map
- [PARITY](docs/PARITY.md) — what was kept from the prototype, and every deliberate difference
- [PHASE-1-ASSESSMENT](docs/PHASE-1-ASSESSMENT.md) — the original assessment of the prototype and the migration plan

## Known limits

Stated plainly, because they matter:

- **Not exercised against live third parties.** The Anthropic and OpenAI adapters, Google sign-in and Stripe billing are tested against local mock servers that speak the same protocols. They have not been run against the real services. The S3 storage driver has no automated test at all (the local driver is fully tested).
- **The container images are written but were not built in the environment where this was developed** (no container runtime was available). The production bundle that goes into the API image was run from a pruned production install and passes its health checks; see [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).
- **The landing page's SEO tags are set by the single-page app.** Search engines that run JavaScript will see them; crawlers that don't will see the static title, description and structured data in `index.html` only. Pre-rendering is the next step if organic search matters.
- **Forecasts are simple** (linear trend, seasonal index when two full cycles exist), backtested on your data, and labelled with a confidence level. They are estimates, not predictions.
- **Rows are held in memory per analysis** (columnar, cached, bounded by `FRAME_CACHE_MB`). The plan limits (up to 1,000,000 rows) are what the design targets; beyond that, analysis would need to move to a columnar store.
