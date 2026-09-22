import { Link } from "react-router-dom";
import { PlanGrid, usePlans } from "../components/Marketing";
import { VerifiedText } from "../components/chat/VerifiedText";
import { useSeo } from "../lib/seo";
import type { Fact, SourceRef } from "../lib/types";

/* Real values from the built-in demo dataset (6,764 rows of retail sales), as computed by the top_n tool. */
const SPECIMEN_ANSWER = "The five best-selling products by total sales are:\n1. Aura Watch — 506.5K (15.7% of the total)\n2. Nimbus Ring — 441.4K (13.7% of the total)\n3. Orbit Dock — 407.0K (12.6% of the total)\n4. Shield Case — 374.3K (11.6% of the total)\n5. Vista Hub — 364.7K (11.3% of the total)";
const fact = (n: number, label: string, value: number, unit: Fact["unit"], display: string): Fact => ({ id: `call1:f${n}`, label, value, unit, display });
const SPECIMEN_FACTS: Fact[] = [
  fact(1, "Aura Watch: total Sales", 506500, "currency", "506.5K"), fact(2, "Aura Watch: share of total", 15.7, "percent", "15.7%"),
  fact(3, "Nimbus Ring: total Sales", 441400, "currency", "441.4K"), fact(4, "Nimbus Ring: share of total", 13.7, "percent", "13.7%"),
  fact(5, "Orbit Dock: total Sales", 407000, "currency", "407.0K"), fact(6, "Orbit Dock: share of total", 12.6, "percent", "12.6%"),
  fact(7, "Shield Case: total Sales", 374300, "currency", "374.3K"), fact(8, "Shield Case: share of total", 11.6, "percent", "11.6%"),
  fact(9, "Vista Hub: total Sales", 364700, "currency", "364.7K"), fact(10, "Vista Hub: share of total", 11.3, "percent", "11.3%"),
];
const SPECIMEN_SOURCES: SourceRef[] = [{ callId: "call1", tool: "top_n", params: {}, summary: "", factCount: 10, provenance: { tool: "top_n", params: {}, rowsConsidered: 6764, filters: [], method: "Sum of Sales per Product, ranked", caveats: [] } }];

function Specimen() {
  return (
    <figure className="w-full max-w-xl" aria-label="Example question and answer from the demo data">
      <div className="rounded-lg border border-line bg-panel p-5 shadow-[0_1px_0_rgb(var(--line))] sm:p-6">
        <p className="inline-block rounded-lg bg-sunk px-3.5 py-2 text-[0.95rem] font-medium text-ink">What are the top 5 products?</p>
        <div className="thread-rail mt-5"><VerifiedText text={SPECIMEN_ANSWER} facts={SPECIMEN_FACTS} sources={SPECIMEN_SOURCES} /></div>
        <div className="mt-4 rounded-md bg-sunk px-3.5 py-2.5 text-xs leading-5 text-ink-2">
          <p><span className="font-medium text-ink">Where it came from.</span> <code className="rounded bg-panel px-1 py-0.5">top_n</code> summed Sales by Product across all <span className="num">6,764</span> rows.</p>
          <p className="mt-1.5 text-ink-3"><span className="font-medium text-ink-2">Left out:</span> <s>“That's roughly a 20% lift on last year.”</s> No calculation produced 20%, so the sentence never reached the screen.</p>
        </div>
      </div>
      <figcaption className="mt-2 text-xs text-ink-3">Real output from the built-in demo data. Hover a highlighted figure.</figcaption>
    </figure>
  );
}

const STEPS = [
  { h: "You ask in plain English", p: "“Why did margin fall in March?” or “Which region is most dependent on one product?” No formulas, no query language." },
  { h: "A calculation runs on your data", p: "The AI picks from a fixed set of analysis tools and never sees your rows. The tool does the arithmetic against the actual dataset and returns the result along with its working." },
  { h: "The working travels with the result", p: "Rows used, filters applied, the period covered, the method, and any caveats — the partial month that was excluded, the column that isn't additive — come back with every figure." },
  { h: "The wording is checked before you see it", p: "Every number in the AI's explanation must match a computed result. A sentence with a number that doesn't is removed; if too much fails, you get the computed answer as it stands." },
];

const SAFEGUARDS: [string, string][] = [
  ["A half-finished month makes revenue look like it collapsed.", "Partial periods at the edge of your data are detected and left out of trends and comparisons, and the answer says so."],
  ["“Margin up 400%” from a week with three orders.", "Percentage changes are suppressed when the base is too small to mean anything, and the absolute change is shown instead."],
  ["Profit “strongly correlates” with revenue and cost.", "Relationships that are just arithmetic (profit = revenue − cost) are recognised and never presented as discoveries."],
  ["Discounts and margins get summed as if they were dollars.", "Rates, prices and shares are averaged or recomputed from their parts, never added up."],
  ["A forecast drawn from a handful of data points.", "Forecasts stay switched off until there are at least six complete periods of history. They are backtested on your data and always show a range and a confidence level."],
  ["Free text treated as a customer ID.", "Columns are classified from their content, with the reasons shown, and you can leave any column out of the analysis."],
];

const FAQ: [string, string][] = [
  ["Does the AI see my data?", "No. The model is given the question, a description of your columns, and the summaries and figures that the analysis tools have already computed. It is never sent your rows."],
  ["Can it still be wrong?", "It can misunderstand a question and pick the wrong calculation, which is why every answer lists its sources so you can see exactly what was computed. What it can't do is state a figure that no calculation produced."],
  ["Which files can I upload?", "CSV, Excel (XLSX and XLS), JSON, XML, HTML tables, PDF tables, Word tables, plain text and fixed-width files. If a file contains several tables you choose which to analyse."],
  ["Will you change my data?", "Only in ways you can see. Lossless tidying (trimming whitespace, standardising dates) is logged. Anything that removes rows or merges labels is offered as a suggestion and applied only if you accept it, as a new version. Your original file is kept."],
  ["Who can see my workspace?", "Only its members. Isolation between workspaces is enforced in the API and again inside the database, so a bug in one layer can't expose another team's data. Files are encrypted at rest."],
  ["What happens when I run out of AI answers?", "Questions keep working. You get the computed result without the AI's wording until the allowance resets."],
];

export function LandingPage() {
  const plans = usePlans();
  useSeo({
    title: "Verinum — an AI data analyst that can't make up numbers",
    description: "Upload a spreadsheet and ask questions in plain English. Verinum computes every answer from your data and traces every number back to the calculation behind it.",
    path: "/",
    jsonLd: { "@context": "https://schema.org", "@type": "FAQPage", mainEntity: FAQ.map(([q, a]) => ({ "@type": "Question", name: q, acceptedAnswer: { "@type": "Answer", text: a } })) },
  });
  return (
    <>
      <section className="mx-auto grid max-w-6xl items-center gap-12 px-5 pb-16 pt-12 sm:px-8 lg:grid-cols-[1.05fr_1fr] lg:gap-16 lg:pb-24 lg:pt-20">
        <div>
          <h1 className="text-[2.6rem] leading-[1.06] sm:text-6xl lg:text-[4.1rem]">An analyst that can't make up numbers.</h1>
          <p className="mt-6 max-w-xl text-lg leading-8 text-ink-2">Upload a spreadsheet and ask questions in plain English. Verinum calculates every answer from your data, then shows the working behind every figure it gives you.</p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link to="/register" className="btn btn-primary btn-lg" data-testid="cta-start">Start free</Link>
            <Link to="/how-it-works" className="btn btn-quiet btn-lg">How it stays honest</Link>
          </div>
          <p className="mt-4 text-sm text-ink-3">No card needed. A demo dataset is waiting in every new workspace.</p>
        </div>
        <div className="flex justify-center lg:justify-end"><Specimen /></div>
      </section>

      <section className="border-t border-line bg-panel" aria-labelledby="steps-h">
        <div className="mx-auto max-w-6xl px-5 py-16 sm:px-8">
          <h2 id="steps-h" className="max-w-2xl text-3xl">How a number earns its place on your screen</h2>
          <ol className="mt-10 grid gap-x-10 gap-y-8 md:grid-cols-2 lg:grid-cols-4">
            {STEPS.map((s, i) => (
              <li key={s.h} className="border-t-2 border-thread pt-4"><span className="num font-serif text-sm text-thread-ink">Step {i + 1}</span><h3 className="mt-1 text-lg">{s.h}</h3><p className="mt-2 text-sm leading-6 text-ink-2">{s.p}</p></li>
            ))}
          </ol>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-5 py-16 sm:px-8" aria-labelledby="guard-h">
        <h2 id="guard-h" className="max-w-2xl text-3xl">It knows when not to say something</h2>
        <p className="mt-3 max-w-2xl text-ink-2">Most wrong answers from data tools aren't arithmetic mistakes. They're plausible-looking claims built on something the tool should have noticed. These are the ones Verinum is built to catch.</p>
        <dl className="mt-10 divide-y divide-line border-y border-line">
          {SAFEGUARDS.map(([bad, good]) => (
            <div key={bad} className="grid gap-x-10 gap-y-1 py-5 md:grid-cols-2"><dt className="text-[0.95rem] text-ink-2 line-through decoration-down/50">{bad}</dt><dd className="text-[0.95rem] text-ink">{good}</dd></div>
          ))}
        </dl>
      </section>

      <section className="border-t border-line bg-panel" aria-labelledby="files-h">
        <div className="mx-auto grid max-w-6xl gap-12 px-5 py-16 sm:px-8 lg:grid-cols-2">
          <div>
            <h2 id="files-h" className="text-3xl">Bring the file you actually have</h2>
            <p className="mt-3 text-ink-2">CSV and Excel, of course. Also JSON, XML, HTML and Word tables, tables inside PDFs, and fixed-width text exports. Encodings, delimiters and date formats are detected from the content, not the file extension.</p>
            <p className="mt-3 text-ink-2">Before any analysis, each column is classified (revenue, product, region, date…) with the reasons shown, and the file gets a quality score with plain-language fixes. Every automatic change is written to a log you can read.</p>
          </div>
          <div>
            <h2 className="text-3xl">Built for teams from the start</h2>
            <ul className="mt-3 space-y-2.5 text-ink-2">
              <li>Workspaces with owner, admin, analyst and viewer roles.</li>
              <li>Tenant isolation enforced in the database itself, not only in application code.</li>
              <li>Files encrypted at rest, exports formula-injection safe, and an append-only audit log.</li>
              <li>Saved dashboards, filters that apply to every chart at once, and CSV, Excel or JSON export.</li>
            </ul>
          </div>
        </div>
      </section>

      {plans.length > 0 && (
        <section className="mx-auto max-w-6xl px-5 py-16 sm:px-8" aria-labelledby="price-h">
          <div className="flex flex-wrap items-baseline justify-between gap-3"><h2 id="price-h" className="text-3xl">Start free, upgrade when the team grows</h2><Link to="/pricing" className="link text-sm">Compare plans in detail</Link></div>
          <div className="mt-8"><PlanGrid plans={plans} action={(p) => <Link to="/register" className={`btn ${p.priceMonthlyUsd === 0 ? "btn-primary" : "btn-quiet"}`}>{p.priceMonthlyUsd === 0 ? "Start free" : `Start with ${p.name}`}</Link>} /></div>
        </section>
      )}

      <section className="border-t border-line bg-panel" aria-labelledby="faq-h">
        <div className="mx-auto max-w-3xl px-5 py-16 sm:px-8">
          <h2 id="faq-h" className="text-3xl">Questions people ask first</h2>
          <div className="mt-8 divide-y divide-line border-y border-line">
            {FAQ.map(([q, a]) => (
              <details key={q} className="group py-4"><summary className="flex cursor-pointer list-none items-center justify-between gap-4 font-medium text-ink [&::-webkit-details-marker]:hidden">{q}<span aria-hidden className="text-ink-3 transition-transform group-open:rotate-45">+</span></summary><p className="mt-2 max-w-prose text-[0.95rem] leading-7 text-ink-2">{a}</p></details>
            ))}
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-5 py-20 text-center sm:px-8">
        <h2 className="mx-auto max-w-2xl text-4xl">Ask your data a question you'd have to trust the answer to.</h2>
        <Link to="/register" className="btn btn-primary btn-lg mt-8">Start free</Link>
      </section>
    </>
  );
}

export function PricingPage() {
  const plans = usePlans();
  useSeo({ title: "Pricing — Verinum", description: "Plans for individuals and teams. Start free with a demo dataset; upgrade for larger files, more members and more AI answers.", path: "/pricing" });
  return (
    <div className="mx-auto max-w-6xl px-5 py-14 sm:px-8">
      <h1 className="text-5xl">Pricing</h1>
      <p className="mt-3 max-w-xl text-ink-2">Every plan includes grounded answers, insights, dashboards and exports. Plans differ in how much data, how many people, and how many AI-worded answers a month.</p>
      <div className="mt-10">{plans.length === 0 ? <div className="skeleton h-64" /> : <PlanGrid plans={plans} action={(p) => <Link to="/register" className={`btn ${p.priceMonthlyUsd === 0 ? "btn-primary" : "btn-quiet"}`}>{p.priceMonthlyUsd === 0 ? "Start free" : `Start with ${p.name}`}</Link>} />}</div>
      <section className="mt-14 max-w-2xl">
        <h2 className="text-2xl">What counts against a limit</h2>
        <dl className="mt-4 space-y-4 text-sm leading-6">
          <div><dt className="font-medium text-ink">AI answers</dt><dd className="text-ink-2">One per question answered with the AI's wording. When the allowance is used, questions still return the computed result without the wording.</dd></div>
          <div><dt className="font-medium text-ink">Exports</dt><dd className="text-ink-2">One per file exported (CSV, Excel or JSON).</dd></div>
          <div><dt className="font-medium text-ink">Storage</dt><dd className="text-ink-2">Original files plus the processed copies for each dataset version.</dd></div>
        </dl>
      </section>
    </div>
  );
}

export function HowItWorksPage() {
  useSeo({ title: "How Verinum stays honest — grounded AI analysis", description: "Every answer is calculated from your data by a fixed set of analysis tools. The AI explains results; it never invents them. See exactly how figures are verified.", path: "/how-it-works" });
  const tools: [string, string][] = [["Rankings and breakdowns", "Top and bottom values, shares of total, concentration, cross-tabs"], ["Change over time", "Trends, period comparisons, what drove a change, unusual periods"], ["Profitability", "Margin by group, loss-makers, volume versus margin"], ["Relationships", "Correlations that aren't just arithmetic, outliers"], ["Customers", "Repeat behaviour, cohort retention"], ["Looking ahead", "Forecasts with a stated range, gated on having enough history"]];
  return (
    <article className="mx-auto max-w-3xl px-5 py-14 sm:px-8">
      <h1 className="text-5xl">How Verinum stays honest</h1>
      <p className="mt-4 text-lg leading-8 text-ink-2">Large language models are fluent and confident, and they will happily produce a statistic that sounds right. Verinum is built so that isn't possible for the numbers that matter.</p>

      <h2 className="mt-12 text-2xl">The AI explains; the tools calculate</h2>
      <p className="mt-3 leading-7 text-ink-2">When you ask a question, the model chooses from a fixed set of analysis tools and supplies parameters such as the column and the period. The tool runs against your dataset and returns a structured result: the values, the method, the number of rows used, the filters applied and the caveats that apply. The model then writes an explanation of that result. It is not sent your rows and it is not asked to do arithmetic.</p>

      <h2 className="mt-12 text-2xl">Every number is checked</h2>
      <p className="mt-3 leading-7 text-ink-2">Before you see an answer, each sentence is scanned for numbers, percentages and currency amounts. Each one is matched to a figure the tools produced in that conversation, allowing only for rounding to the precision shown. Direction is checked too: “fell 12%” doesn't pass for a figure that rose. A sentence that can't be matched is dropped. If too many fail, or the AI service is unavailable, you get the computed answer directly, so the worst case is a plainer answer rather than an invented one.</p>
      <p className="mt-3 leading-7 text-ink-2">You can see what happened. Figures that passed carry a highlighter mark; hover one to see the calculation it was checked against. Below each answer, Sources lists every calculation, with the rows, filters and period it used.</p>

      <h2 className="mt-12 text-2xl">What the tools can calculate</h2>
      <dl className="mt-4 divide-y divide-line border-y border-line">{tools.map(([k, v]) => <div key={k} className="grid gap-x-8 gap-y-1 py-3 sm:grid-cols-[14rem_1fr]"><dt className="font-medium text-ink">{k}</dt><dd className="text-sm text-ink-2">{v}</dd></div>)}</dl>
      <p className="mt-3 text-sm text-ink-3">If your data can't support a tool (there's no date column, or too little history), it isn't offered, and Verinum says why.</p>

      <h2 className="mt-12 text-2xl">What it can't promise</h2>
      <p className="mt-3 leading-7 text-ink-2">Verinum can't tell whether your data is right, only whether its answers follow from it. The quality report exists to help with that. The AI can also misread a question and calculate something you didn't mean; the sources line makes that easy to spot. And a forecast is an estimate: it comes with its backtested error and a range, and it is never presented as a certainty.</p>

      <div className="mt-12"><Link to="/register" className="btn btn-primary btn-lg">Try it on the demo data</Link></div>
    </article>
  );
}
