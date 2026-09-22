# Parity with the prototype

The offline prototype (`Verinum.html`) was rebuilt from scratch, using it as a reference for *what the product should know*, not as code to wrap. This document records what was kept, what is deliberately different, and what was left behind. The prototype's engine, extractor and demo dataset are kept in `reference/prototype/` so any claim below can be checked by running it.

The baseline numbers were taken by running the prototype's engine in Node on its bundled demo dataset (6,764 rows × 16 columns) during Phase 1 ([PHASE-1-ASSESSMENT.md](PHASE-1-ASSESSMENT.md)):

| Quantity | Prototype | This build |
|---|---|---|
| Rows × columns | 6,764 × 16 | same |
| Quality score | 74 / 100 | 74 / 100 |
| Duplicate rows | 14 | 14 |
| Total Sales | 3,225,540.86 | same |
| Margin (Σ profit ÷ Σ revenue) | 31.18% | same |
| Top product | Aura Watch, 506,482.84 (15.7%) | same |

The tests assert these as hard-coded golden values (see [TESTING.md](TESTING.md)). The prototype is **not executed** by the test suite; the numbers were captured once and are checked against, not recomputed.

## Safeguards that were kept

Every analytical safeguard the prototype had learned is preserved, each with a named regression test. In several places (marked below) the rebuild is *stronger* than the prototype, because Phase 1 found gaps in the original.

| # | Safeguard | Where it lives now | Test | Stronger than the prototype? |
|---|---|---|---|---|
| 1 | Time-zone bugs | Dates are **civil-day integers** (`core/time.ts`); the `Date` object is never used in analysis | `time.test.ts`, `tools.test.ts › TZ independence`, `npm run test:tz` | Yes. The prototype built date-only strings as *local* dates, so the same file gave a different range under different server time zones (probed in Phase 1). Here the answer cannot depend on the zone |
| 2 | Phantom periods | Period keys are integer calendar arithmetic; a month with no rows is a gap, never a zero | `safeguards.test.ts › phantom periods` | Same behaviour, different mechanism |
| 3 | Incomplete-period distortion | `completePeriods` (`analytics/periods.ts`) trims partial edge periods and flags them | `safeguards.test.ts`, `tools.test.ts › time_series never draws the partial edge month` | Yes. The prototype applied it in insights, KPIs and forecast but not in the time-series tool's trend fit or in period comparison. Here every consumer uses it |
| 4 | Extreme % from partial periods | Insight generators and KPI deltas receive only complete periods; comparisons default to the last two *complete* periods | `safeguards.test.ts › incomplete periods and extreme percentage headlines` (5 tests), `insights.test.ts` | Yes (follows from 3) |
| 5 | Blank groups | `(blank)` is never a leader, laggard or recommendation target, and is reported | `safeguards.test.ts › blank groups` | Same |
| 6 | Concentration firing on even data | Three-part gate: at least 5 groups, at least 1.4× the even-split baseline, normalised HHI ≥ 0.15 | `insights.test.ts › does not call an evenly split dimension concentrated` | Same |
| 7 | Tautological correlations | Name containment, |r| ≥ 0.99 and constant-ratio tests | `insights.test.ts`, `tools.test.ts › relationship guards in tools` | Yes. In the prototype only the insight generator filtered them; the *tool* the language model called returned raw pairs, so tautologies reached the model. Here the tool labels "related by construction" and its scan omits them and says how many |
| 8 | Margin calculation | Σprofit ÷ Σrevenue, never an average of row margins; refuses non-additive numerators | `safeguards.test.ts`, `tools.test.ts`, `insights.test.ts` | Same |
| 9 | Free text taken for identity | The profiler measures word count, length and format regularity, and emits `text` *before* `identifier` | `profile.test.ts › classifies sentences as free text` | Yes. The prototype patched this only where the customer column was chosen; its profiler still labelled sentence columns as identifiers. Fixed at the source |
| 10 | Profit insights need additive columns | Every column carries `additive`; every tool declares whether it needs additive measures | `profile.test.ts`, `tools.test.ts › refuses to sum…` | Same |
| 11 | Share / rate / caption columns | Shares and rates are never summed; near-unique caption columns are never chart dimensions | `profile.test.ts` (3 tests) | Same |
| – | Forecast gating | A forecast needs at least 6 complete periods, and says why when refused | `safeguards.test.ts › refuses to forecast from fewer than six complete periods` | Same threshold |

Note on safeguard 11: the original brief wrote "cross-tenant … share/rate and caption columns". Because multi-tenancy is a separate concern, this was read as the prototype's cross-tabulation guards for share, rate and caption columns. If something else was meant, it is not covered.

## Deliberate differences

Changes to analytical behaviour, each made because the prototype's choice was wrong or unsafe for a multi-user product, with the reasoning:

- **Complete-period rule.** The prototype trimmed an edge period only when it held fewer than 30% of the median row count. That rule is kept, and a calendar-coverage test is added: a first or last period covering under 80% of its calendar span is also partial. A month that is only half present can still hold more than 30% of the median month's rows, and would have passed the old rule.
- **Non-additive measures.** Price, discount, rate and margin-percentage columns are averaged or weighted, never summed, and cannot feed additive insights. A profit-*rate* column is given the meaning `margin` so it is not mistaken for profit.
- **Name precedence.** A column named for marketing spend is `marketing`, not `cost`, even though both words are present.
- **Seasonality needs two full cycles** of history at the chosen grain, and reports the number of cycles it saw. The prototype's forecast already required two cycles, but its seasonal *insight* fired from 18 months of monthly data; that gate is now the stricter two-cycle rule (24 months) everywhere.
- **Anomalies** are found with a median/MAD score on the *detrended* series, so steady growth is not flagged and one huge spike does not hide the others.
- **Date order** (day-first or month-first) is decided per column from the evidence, and the user can override it as a processing option, which creates a new version.
- **Duplicates** are detected by hashing all columns. Removing them is offered, never applied silently (14 on the demo data).
- **Numeric strings in tool payloads are not exempt.** In the grounding layer, a number that appears only as a display string in a tool's structured data no longer counts as a "label", which would have let an invented figure through. Covered by a regression test.
- **Charts draw complete periods only.** A partial edge month stays in the table, flagged `complete: false`, but is not plotted, because plotting it looked like a collapse to zero.
- **Quality score thresholds** were tuned so the demo data scores 74 as in the prototype. On other data, the score is this build's own and will not always equal what the prototype would have said.
- **Forecast minimum** stays at 6 complete periods for parity, but a forecast from few periods is labelled *low confidence*, is always shown with a range, and states its assumptions.

## Beyond the prototype

Things that did not exist, or existed only informally:

- **A checked AI.** The prototype's model call ran in the browser with the user's own key, with no check of the figures in its answer. Now the model runs server-side, can only choose tools, never sees rows, and every number in what it says is verified against computed results before it is shown ([AI-GROUNDING.md](AI-GROUNDING.md)). The prototype's twelve tools became about 27, each capability-gated and returning facts with provenance.
- **Accounts, workspaces, roles, isolation, audit, billing, admin, limits, async jobs, versions, exports, observability.** None of this existed in a single-user offline page.
- **Server-side ingestion** with size, row, zip-expansion and time limits, and a sandboxed worker, replacing browser-only parsing. European number formats (`4.237,50`), which the prototype turned into categorical columns, are now read as numbers. A `groupBy(max)` over 300,000 rows overflowed the prototype's call stack (it spread a row array into `Math.max`); the columnar engine's aggregations loop over typed arrays and never do that on row-sized data.
- **Every transformation is logged** and every destructive fix is a new immutable version.

## What was left behind

- **The screenplay / prose structurer.** The prototype's `extract.js` could derive scene, character, paragraph and term tables from screenplay-like text. The rebuild structures PDF, DOCX, HTML and plain text generically (headings, paragraphs, key-value pairs, tables) and does not do screenplay-specific extraction. A plain text file with no table structure yields little to analyse.
- **Offline use.** The prototype worked from a single file with no server. This product needs its API and database.
- **Prototype UI details.** The visual design is new, and the six prototype tabs map onto Overview, Insights, Dashboard, Forecast, Explore, Ask and Data. Anything in the prototype's interface that is not in that list was not carried over.
- **Bring-your-own-key in the browser.** Removed on purpose: the key lives on the server.
