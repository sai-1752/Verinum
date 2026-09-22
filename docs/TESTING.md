# Testing

Decision priority for the whole project is correctness first, so the test suite is weighted toward the parts where a silent error would be worst: the arithmetic in the analysis tools, the grounding gate, and tenant isolation.

## Running

```bash
npm ci
./scripts/db-bootstrap.sh          # once: roles + verinum / verinum_test databases (see README)
npm test                           # 423 unit + integration tests
npm run test:tz                    # the engine suite again under UTC, America/Los_Angeles and Asia/Kolkata
npm run typecheck && npm run lint  # strict TypeScript for all four packages; eslint (with react-hooks rules for the web app)
npm run test:e2e                   # builds the API and web app, starts a stack, drives Chromium: 33 browser tests
```

The API tests need PostgreSQL 16 and the `verinum_test` database (they migrate it themselves and connect as the real restricted runtime role, so row-level security is exercised for real). Files run serially because they share that database. The end-to-end run recreates its own `verinum_e2e` database from scratch each run, starts a mock Anthropic server, the built API, and `vite preview`, so it never touches development data. CI (`.github/workflows/ci.yml`) runs all of the above on every push and also builds both Docker images.

## What each suite proves

| Suite | Tests | What it is for |
|---|---:|---|
| `packages/core` | | |
| `tools.test.ts` | 62 | Golden numbers for every analysis tool on the demo dataset, refusal to sum non-additive columns, filters, complete-period rules, forecast gating, correlation guards, and time-zone independence |
| `grounding.test.ts` | 27 | Numeric-claim extraction (what counts as a claim, precision, hedges, currency, percent), the fact ledger, direction checks, the streaming sentence gate |
| `planner.test.ts` | 30 | The deterministic question → tool planner: phrasing variants, column and value resolution, "cannot answer" cases |
| `profile.test.ts` | 22 | Semantic profiling on the demo data and on adversarial columns (sentences, captions, shares, rates, identifiers) |
| `chat.test.ts` | 19 | The chat loop with a scripted model: tool calls, verified streaming, dropped sentences, fallbacks, provider failures, prompt injection, what the model is (and is not) shown |
| `insights.test.ts` | 16 | Insight generation, ranking transparency, determinism, and the guards (concentration, tautology, partial periods, margin) |
| `clean.test.ts`, `clean-actions.test.ts` | 13 + 5 | Number/date/blank parsing including ambiguous day/month order and European decimals; the 14 demo duplicates; lossless cleaning and the offered fixes |
| `safeguards.test.ts` | 11 | The prototype's hard-won safeguards that no more specific file covers (below) |
| `dashboard.test.ts`, `values.test.ts`, `time.test.ts` | 7 + 11 + 7 | Dashboard planning and filter application; display formatting; civil-date arithmetic round-trip over 1900–2100 |
| `packages/ingest` | 32 | Every supported format, format detection from bytes, encoding and delimiter sniffing, multi-table files, and hostile input: zip bombs (by counting inflated bytes), truncated and corrupt files, prototype-pollution keys, the worker sandbox |
| `apps/api` | | |
| `tenancy.test.ts` | 47 | Two real tenants attacked at every layer (routes, raw SQL as the app role with and without context, forged `workspace_id`, storage prefixes, job payloads), definer-function guards, and the enumeration of every `SECURITY DEFINER` function |
| `rbac.test.ts` | 11 | The role matrix over HTTP, invitations, last-owner protection, workspace lifecycle, an audit log that cannot be altered |
| `auth.test.ts`, `oauth.test.ts` | 11 + 5 | Sessions, lockout, verification, reset (single use, revokes sessions), Google code flow with PKCE, pre-hijack protection |
| `datasets.test.ts`, `jobs.test.ts` | 10 + 10 | Upload → processed → insights/dashboard/forecast end to end; versions; explorer; exports; deletion; the queue (per-tenant context, retries, backoff, leases, reaping, cancellation) |
| `chat.test.ts` | 10 | HTTP-level grounding: exact deterministic answers, fabricated numbers removed (asserted on the raw response body), fallback, outage, SSE framing, per-workspace AI metering |
| `providers.test.ts` | 14 | The Anthropic and OpenAI adapters against local HTTP servers: SSE parsing across split chunks, tool-call assembly, retry on 429, timeouts, outage |
| `billing.test.ts`, `limits.test.ts`, `config.test.ts` | 8 + 12 + 14 | Signature-verified, idempotent webhooks; config-driven plan limits and the 402 shape; production configuration refusals |
| `apps/web` | | |
| `verified-text.test.tsx`, `sse.test.ts` | 5 + 4 | Answer rendering (only verified figures get the mark; markup is escaped) and the SSE client |
| `e2e` (Playwright) | 33 | The acceptance criteria below, in a real browser against the real API and database |

## Acceptance criteria, and the test that proves each

The criteria are numbered as in the end-to-end specs (`e2e/specs/`); the wording here is each test's own description.

| # | Criterion | Test |
|---|---|---|
| AC1 | A person can create an account and lands in their own workspace | `auth.spec.ts` |
| AC2 | The session cookie is HttpOnly and survives a reload; sign-out ends the session | `auth.spec.ts`, `api/auth.test.ts` |
| AC3 | Wrong credentials are refused with one message; right ones sign in | `auth.spec.ts`, `api/auth.test.ts` (lockout) |
| AC4 | Email verification works from the emailed link | `auth.spec.ts` |
| AC5 | A forgotten password can be reset from the emailed link, once | `auth.spec.ts`, `api/auth.test.ts` |
| AC6 | Uploading a CSV shows progress, then a ready dataset | `analysis.spec.ts`, `api/datasets.test.ts` |
| AC7 | The overview leads with a computed headline, KPIs and ranked findings | `analysis.spec.ts`, `core/insights.test.ts` |
| AC8 | Every finding can show its working | `analysis.spec.ts` |
| AC9 | Data quality: a score, plain-language issues, an itemised transformation log, and fixes offered rather than applied | `analysis.spec.ts`, `core/clean*.test.ts`, `core/profile.test.ts` (quality 74) |
| AC10 | Applying a suggested fix creates a new version and re-runs the analysis | `analysis.spec.ts`, `api/datasets.test.ts` (original preserved) |
| AC11 | The dashboard is planned from the data; a filter applies to every chart at once | `analysis.spec.ts`, `core/dashboard.test.ts` |
| AC12 | A forecast appears only with enough history, shows its range, and says what it assumes | `analysis.spec.ts`, `core/safeguards.test.ts` |
| AC13 | A file with too little history gets no forecast, and the page says why | `analysis.spec.ts` |
| AC14 | The explorer searches, pages and exports exactly the rows in view | `analysis.spec.ts`, `api/datasets.test.ts` |
| AC15 | Usage meters and the audit log reflect what was done | `analysis.spec.ts`, `api/limits.test.ts`, `api/rbac.test.ts` |
| AC16 | The free plan's dataset limit is enforced with a clear message | `analysis.spec.ts`, `api/limits.test.ts` |
| AC17 | A dataset can be deleted, and it disappears from the list | `analysis.spec.ts`, `api/datasets.test.ts` |
| AC18 | "What are the top 5 products?" returns the exact ranking with a chart and every figure checked (AC18b: the same with the provider down) | `ask.spec.ts`, `api/chat.test.ts` |
| AC19 | A marked figure shows where it came from | `ask.spec.ts`, `web/verified-text.test.tsx` |
| AC20 | With a model configured, an invented figure is removed before it is shown, and the answer says so | `ask.spec.ts`, `api/chat.test.ts`, `core/chat.test.ts` |
| AC21 | Another workspace's data is unreachable: by URL, by API, and by guessing ids | `teams.spec.ts`, `api/tenancy.test.ts` |

The end-to-end suite also covers invitations and viewer restrictions, an invitation refused for the wrong email, the landing page and its SEO essentials, keyboard-operable FAQ, the not-found page, that the API hides internals (metrics need a token, unknown routes are JSON 404s), and that the app is usable at phone width with no horizontal scroll.

## Regression tests for the prototype's safeguards

Each behaviour the prototype learned the hard way has a named test, so a regression fails loudly. The full mapping of each to its code is in [PARITY.md](PARITY.md).

| Safeguard | Test |
|---|---|
| Time-zone bugs | `time.test.ts › timezone independence`; `tools.test.ts › TZ independence`; the whole core suite under three zones via `npm run test:tz` |
| Phantom periods | `safeguards.test.ts › a month with no data is a gap…`, `period-over-period change is never computed across a gap` |
| Incomplete-period distortion; extreme % from partial periods | `safeguards.test.ts › incomplete periods and extreme percentage headlines` (five tests), `insights.test.ts › never anchors a comparison on the partial first month`, `tools.test.ts › time_series never draws the partial edge month` |
| Blank groups | `safeguards.test.ts › blank groups` |
| Concentration firing on even data | `insights.test.ts › does not call an evenly split dimension concentrated` |
| Tautological correlations | `insights.test.ts › does not offer tautological correlations`; `tools.test.ts › relationship guards in tools` |
| Margin calculation | `safeguards.test.ts › is Σprofit ÷ Σrevenue, not the average of row-level margins`; `tools.test.ts › uses SUM(profit)/SUM(revenue)…`; `insights.test.ts › does not compute margin insights from a margin-% column` |
| Free text treated as identity | `profile.test.ts › classifies sentences as free text, not identifiers` |
| Additive-only profit insights | `profile.test.ts › treats prices and discounts as non-additive`; `tools.test.ts › refuses to sum a price, discount or share column` |
| Share / rate / caption columns | `profile.test.ts › marks share, rate and percentage columns non-additive`, `detects a column of shares`, `does not offer near-unique captions as chart dimensions` |
| Forecast gating | `safeguards.test.ts › refuses to forecast from fewer than six complete periods, with a reason` |
| Golden totals (Sales 3,225,540.86; margin 31.18%; top product Aura Watch 506,482.84, 15.7%) | `profile.test.ts › matches the golden totals`, `tools.test.ts › returns the exact golden ranking`, `insights.test.ts › reports golden KPI values` |

## What the tests do not prove

- **There is no live-model evaluation.** Every "model" in the tests is scripted (`ScriptedProvider`, or a mock Anthropic server in the browser tests), and the adversarial outputs are ones I could think of. The grounding gate's guarantee is structural (numbers are checked against computed facts regardless of what the model is), but nothing here measures how a real model performs, how often it triggers the fallback, or the residual "correct number, wrong subject" risk described in [AI-GROUNDING.md](AI-GROUNDING.md#9-honest-limits). Before relying on a provider, run a sample of real questions and review `messages.grounding`.
- **Third-party services are mocked.** Anthropic, OpenAI, Google OAuth and Stripe are tested against local servers that speak their documented protocols, not the real services. SMTP delivery is not tested (the tests use in-memory and file mailers). The S3 storage driver has **no automated test**; the local driver, and the encryption layer over it, are fully tested.
- **The container images were not built** in the environment where this was developed. CI builds them.
- **Golden numbers come from the prototype run once**, on one dataset. The prototype is kept in `reference/prototype/` but is not executed by the test suite; if you change an analysis, the golden tests will tell you the numbers moved, and you decide whether the change is right.
- **No load, soak or penetration testing** has been done, and the SQL policies have not been reviewed by anyone but their author. The tenancy tests are thorough, but they are the author's attacks.
- **Browser coverage** is Chromium only (desktop and a phone-sized viewport); there are no visual-regression tests, and accessibility is covered by semantic locators and keyboard tests rather than an automated audit.

## Writing new tests

- Numbers in a test come from an independent computation (a hand calculation, or a query in the database), not from the code under test.
- A new analysis tool gets a golden test on the demo dataset, a test for each capability it refuses to run without, and a check that every figure in its summary is in its `facts`.
- A new table gets a row-level-security test in `tenancy.test.ts` (the "every tenant table has RLS enabled" check will remind you), and a new `SECURITY DEFINER` function must be added to the enumeration test and to [SECURITY.md](SECURITY.md).
- Tests that build a `Frame` from strings should assert on typed results, never on formatted strings alone, so a display change doesn't hide a value change.
