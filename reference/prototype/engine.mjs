// Analysis engine. Pure JS, no deps. Everything here is computed from the
// uploaded rows — nothing is hardcoded to a column name.

/* ---------------------------------- parsing --------------------------------- */

function sniffDelimiter(text) {
  const head = text.slice(0, 20000).split(/\r?\n/).slice(0, 5);
  const cands = [",", ";", "\t", "|"];
  let best = ",", bestScore = -1;
  for (const d of cands) {
    const counts = head.map(l => l.split(d).length - 1);
    const avg = counts.reduce((a, b) => a + b, 0) / (counts.length || 1);
    const consistent = counts.every(c => c === counts[0]) ? 1 : 0;
    const score = avg + consistent;
    if (avg > 0 && score > bestScore) { best = d; bestScore = score; }
  }
  return best;
}

export function parseCSV(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const d = sniffDelimiter(text);
  const rows = [];
  let row = [], field = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === d) { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); field = ""; rows.push(row); row = []; }
    else if (c === "\r") { /* skip */ }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  while (rows.length && rows[rows.length - 1].every(v => v === "")) rows.pop();
  if (!rows.length) throw new Error("The file appears to be empty.");
  const header = rows[0].map((h, i) => (h || "").trim() || `column_${i + 1}`);
  const seen = {};
  const columns = header.map(h => { seen[h] = (seen[h] || 0) + 1; return seen[h] > 1 ? `${h}_${seen[h]}` : h; });
  const body = rows.slice(1).map(r => {
    const o = {};
    columns.forEach((c, i) => { const v = r[i]; o[c] = v === undefined ? "" : v.trim(); });
    return o;
  });
  return { columns, rows: body };
}

export async function readDataFile(file) {
  const name = file.name.toLowerCase();
  if (/\.(csv|tsv|txt|dat|log|text|psv)$/.test(name) || !/\.(xlsx|xlsm|xls)$/.test(name)) {
    return parseCSV(await file.text());
  }
  if (!window.XLSX) throw new Error("The spreadsheet reader is still loading. Try again in a moment.");
  const wb = window.XLSX.read(await file.arrayBuffer(), { type: "array", cellDates: true });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const csv = window.XLSX.utils.sheet_to_csv(sheet);
  return parseCSV(csv);
}

/* --------------------------------- detection -------------------------------- */

const NULLS = new Set(["", "na", "n/a", "null", "none", "nan", "-", "--", "?", "undefined"]);
const isBlank = v => v == null || NULLS.has(String(v).trim().toLowerCase());

const NUM_RE = /^-?\(?\s*[$€£¥₹]?\s*-?[\d,\s]*\.?\d+\s*\)?%?$/;
function toNum(v) {
  if (typeof v === "number") return isFinite(v) ? v : null;
  let s = String(v).trim();
  if (!s || !NUM_RE.test(s)) return null;
  const neg = /^\(.*\)$/.test(s);
  const pct = s.endsWith("%");
  s = s.replace(/[()%$€£¥₹,\s]/g, "");
  let n = parseFloat(s);
  if (!isFinite(n)) return null;
  if (pct) n = n / 100;
  return neg ? -n : n;
}

const DATE_RES = [
  /^\d{4}-\d{1,2}-\d{1,2}([ T].*)?$/,
  /^\d{1,2}\/\d{1,2}\/\d{2,4}([ T].*)?$/,
  /^\d{1,2}-[A-Za-z]{3,}-\d{2,4}$/,
  /^[A-Za-z]{3,}\s+\d{1,2},?\s+\d{4}$/,
  /^\d{4}[-/](0?[1-9]|1[0-2])$/,
];
function toDate(v) {
  if (v instanceof Date) return isNaN(v) ? null : v;
  const s = String(v).trim();
  if (!s || !DATE_RES.some(r => r.test(s))) return null;
  let d;
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  const iso = s.match(/^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?$/);
  if (m) {
    let [, a, b, y] = m;
    if (+y < 100) y = +y + 2000;
    // ambiguous: use month/day (US) unless first part > 12
    const [mo, day] = +a > 12 ? [b, a] : [a, b];
    d = new Date(+y, +mo - 1, +day);
  } else if (iso) {
    // Date-only ISO strings are parsed as UTC by the Date constructor, which shifts
    // them a day backwards in western timezones and creates phantom edge periods.
    // Build them as local dates so period bucketing is stable.
    d = new Date(+iso[1], +iso[2] - 1, iso[3] ? +iso[3] : 1);
  } else d = new Date(s);
  return isNaN(d) ? null : d;
}

const kw = {
  revenue: /(revenue|sales|amount|gross|turnover|booking|gmv|income|arr|mrr|total_?price|line_?total)/i,
  profit: /(profit|margin|net|ebitda|earning|contribution)/i,
  cost: /(cost|cogs|expense|spend|cac|opex)/i,
  qty: /(qty|quantity|units?|volume|count|orders?)/i,
  price: /(price|rate|unit_?cost|asking|list)/i,
  discount: /(discount|promo|coupon|markdown)/i,
  marketing: /(marketing|ad_?spend|campaign|media|acquisition)/i,
  customer: /(customer|client|account|user|buyer|member|patient|subscriber)/i,
  freeText: /(note|notes|comment|description|remark|memo|feedback|review|text|message|summary|detail)/i,
  product: /(product|sku|item|service|plan|model|title)/i,
  region: /(region|country|state|city|market|territory|geo|location|zone|store)/i,
  channel: /(channel|source|medium|campaign|platform|referr)/i,
  segment: /(segment|tier|category|type|class|group|industry|plan)/i,
  churn: /(churn|cancel|attrit|lost|inactive|unsub)/i,
  id: /(^|_)(id|uuid|code|key|no|number|ref)($|_)/i,
  employee: /(employee|staff|headcount|salary|hire|attrition|department)/i,
  ops: /(delivery|shipping|lead_?time|downtime|defect|utilization|capacity|inventory|stock|fulfil|latency|ticket|sla|duration)/i,
  eventDate: /(^|_)(date|order_?date|invoice_?date|transaction|created|timestamp|period|day|month|week|year|posted|closed|paid|shipped)($|_)|(date|timestamp)$/i,
  attrDate: /(since|joined|join_?date|signup|sign_?up|registered|birth|dob|hire|hired|start_?date|first_?seen|member_?since|founded|expiry|expires|renewal|due)/i,
};

function quantile(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q, b = Math.floor(pos), r = pos - b;
  return sorted[b + 1] !== undefined ? sorted[b] + r * (sorted[b + 1] - sorted[b]) : sorted[b];
}

function numStats(vals) {
  const s = [...vals].sort((a, b) => a - b);
  const n = s.length;
  const sum = s.reduce((a, b) => a + b, 0);
  const mean = sum / n;
  const variance = n > 1 ? s.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1) : 0;
  const q1 = quantile(s, 0.25), q3 = quantile(s, 0.75), iqr = q3 - q1;
  const lo = q1 - 1.5 * iqr, hi = q3 + 1.5 * iqr;
  const outliers = s.filter(v => v < lo || v > hi);
  return {
    count: n, sum, mean, median: quantile(s, 0.5), min: s[0], max: s[n - 1],
    std: Math.sqrt(variance), variance, p05: quantile(s, 0.05), q1, q3,
    p95: quantile(s, 0.95), iqr, outlierCount: outliers.length,
    outlierPct: (outliers.length / n) * 100, fenceLow: lo, fenceHigh: hi,
    zeros: s.filter(v => v === 0).length, negatives: s.filter(v => v < 0).length,
    skew: variance > 0 ? s.reduce((a, b) => a + ((b - mean) / Math.sqrt(variance)) ** 3, 0) / n : 0,
  };
}

function histogram(vals, bins = 24) {
  const st = numStats(vals);
  const lo = st.p05, hi = st.p95;
  if (!(hi > lo)) return [];
  const w = (hi - lo) / bins;
  const out = Array.from({ length: bins }, (_, i) => ({ x0: lo + i * w, x1: lo + (i + 1) * w, n: 0 }));
  for (const v of vals) {
    let i = Math.floor((v - lo) / w);
    if (i < 0) i = 0; if (i >= bins) i = bins - 1;
    out[i].n++;
  }
  return out;
}

export function buildProfile(data, fileMeta = {}) {
  const { columns, rows } = data;
  if (!rows.length) throw new Error("No data rows were found in this file.");
  const n = rows.length;
  const sampleIdx = n > 4000 ? Array.from({ length: 4000 }, () => Math.floor(Math.random() * n)) : null;
  const cols = columns.map(name => {
    const raw = rows.map(r => r[name]);
    const present = raw.filter(v => !isBlank(v));
    const missing = n - present.length;
    const probe = present.slice(0, 600);
    const numHit = probe.filter(v => toNum(v) !== null).length;
    const dateHit = probe.filter(v => toDate(v) !== null).length;
    const uniq = new Set(present.map(String));
    const col = {
      name, missing, missingPct: (missing / n) * 100, present: present.length,
      unique: uniq.size, uniquePct: present.length ? (uniq.size / present.length) * 100 : 0,
    };
    const ratio = probe.length ? 1 : 0;
    if (probe.length && dateHit / probe.length > 0.85) {
      col.type = "date";
      const ds = present.map(toDate).filter(Boolean).sort((a, b) => a - b);
      col.min = ds[0]; col.max = ds[ds.length - 1];
      col.spanDays = (col.max - col.min) / 86400000;
    } else if (probe.length && numHit / probe.length > 0.9) {
      const vals = present.map(toNum).filter(v => v !== null);
      const allInt = vals.every(v => Number.isInteger(v));
      col.stats = numStats(vals);
      const looksId = kw.id.test(name) && col.uniquePct > 90;
      // A dense, gap-free integer sequence is a row index, not a measure —
      // summing it produces meaningless "totals".
      const isSequence = allInt && vals.length > 4 && col.uniquePct > 99
        && Math.abs((col.stats.max - col.stats.min + 1) - vals.length) <= Math.max(1, vals.length * 0.02);
      col.type = looksId || isSequence ? "id" : "numeric";
      col.isInteger = allInt;
      // Additive = a sum of it means something. Shares, rates and scores do not
      // add up, so they must never be totalled or chosen as a lead metric.
      const nameShare = /(share|pct|percent|proportion|ratio|rate|score|index|avg|average|mean|median|per_|_per|margin_?pct)/i.test(name);
      const inUnit = col.stats.min >= 0 && col.stats.max <= 1.0001;
      const inPct = col.stats.min >= 0 && col.stats.max <= 100.01;
      const sumsToWhole = (inUnit && Math.abs(col.stats.sum - 1) < 0.02) || (inPct && Math.abs(col.stats.sum - 100) < 0.5);
      col.additive = !(nameShare || sumsToWhole);
      if (col.type === "numeric") col.histogram = histogram(vals);
      if (allInt && uniq.size <= 2) col.type = "boolean";
    } else if (uniq.size <= 2 && present.length > 4) {
      col.type = "boolean";
    } else if (col.uniquePct > 92 && uniq.size > 40) {
      col.type = "id";
    } else {
      col.type = "categorical";
    }
    if (col.type === "categorical" || col.type === "boolean" || col.type === "id") {
      const freq = new Map();
      for (const v of present) { const k = String(v); freq.set(k, (freq.get(k) || 0) + 1); }
      col.top = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)
        .map(([value, count]) => ({ value, count, pct: (count / present.length) * 100 }));
      col.cardinality = freq.size;
      const lens = present.slice(0, 400).map(v => String(v).length);
      col.avgLen = lens.reduce((a, b) => a + b, 0) / (lens.length || 1);
    }
    col.role = classifyRole(col);
    return col;
  });

  // duplicates (full-row)
  const seen = new Set(); let dupes = 0;
  const keyCols = columns.slice(0, 24);
  for (const r of rows) {
    const k = keyCols.map(c => r[c]).join("\u0001");
    if (seen.has(k)) dupes++; else seen.add(k);
  }

  const byType = t => cols.filter(c => c.type === t);
  const metrics = cols.filter(c => c.type === "numeric" && c.role !== "id");
  // Groupable = materially more rows than groups. A near-unique label column is
  // a caption, not a dimension: ranking it compares individual records.
  const dimensions = cols.filter(c => (c.type === "categorical" || c.type === "boolean")
    && c.unique > 1 && c.uniquePct <= 50
    && c.cardinality <= Math.max(2, Math.min(60, n / 5)));
  // Primary date = the column that looks like the event/transaction date, ranked by
  // how densely rows populate its periods — not simply the widest span, which tends
  // to pick up attribute dates like "CustomerSince".
  const dates = byType("date").map(c => {
    const grain = pickGrain(c.spanDays);
    const keyf = GRAINS[grain] || GRAINS.month;
    const periods = new Set();
    const stride = Math.max(1, Math.floor(n / 3000));
    let sampled = 0;
    for (let i = 0; i < n; i += stride) {
      const d = toDate(rows[i][c.name]);
      if (d) { periods.add(keyf(d)); sampled++; }
    }
    const attr = kw.attrDate.test(c.name);
    const event = kw.eventDate.test(c.name);
    c.periodCount = periods.size;
    c.density = periods.size ? sampled / periods.size : 0;
    c.dateKind = attr && !event ? "attribute" : event ? "event" : "unknown";
    c.dateScore = (event && !attr ? 100 : attr ? -100 : 0)
      + Math.min(30, Math.log10(1 + c.density) * 22)
      - c.missingPct * 0.4;
    return c;
  }).sort((a, b) => b.dateScore - a.dateScore || (b.spanDays || 0) - (a.spanDays || 0));

  const profile = {
    file: fileMeta, rowCount: n, colCount: columns.length, columns: cols, columnNames: columns,
    duplicateRows: dupes, duplicatePct: (dupes / n) * 100,
    missingCells: cols.reduce((a, c) => a + c.missing, 0),
    missingPct: (cols.reduce((a, c) => a + c.missing, 0) / (n * columns.length)) * 100,
    numeric: metrics, categorical: byType("categorical"), dateCols: dates, ids: byType("id"),
    metrics, dimensions, additiveMetrics: metrics.filter(c => c.additive),
    primaryDate: dates.find(d => d.dateKind !== "attribute") || (dates.length && dates[0].dateKind !== "attribute" ? dates[0] : null),
    domain: detectDomain(cols),
  };
  profile.quality = qualityReport(profile);
  profile.kpis = autoKPIs(profile, rows);
  return profile;
}

function classifyRole(col) {
  const n = col.name;
  if (col.type === "id") return "id";
  if (col.type === "date") return "time";
  if (col.type === "numeric") {
    for (const k of ["revenue", "profit", "cost", "marketing", "discount", "price", "qty"])
      if (kw[k].test(n)) return k;
    return "measure";
  }
  for (const k of ["customer", "product", "region", "channel", "segment"])
    if (kw[k].test(n)) return k;
  return "dimension";
}

function detectDomain(cols) {
  const names = cols.map(c => c.name).join(" ");
  const tags = [];
  if (kw.revenue.test(names) || kw.profit.test(names)) tags.push("financial");
  if (kw.customer.test(names)) tags.push("customer");
  if (kw.product.test(names)) tags.push("product");
  if (kw.marketing.test(names) || kw.channel.test(names)) tags.push("marketing");
  if (kw.employee.test(names)) tags.push("hr");
  if (kw.ops.test(names)) tags.push("operations");
  if (kw.churn.test(names)) tags.push("retention");
  return tags;
}

/* ---------------------------------- quality --------------------------------- */

function qualityReport(p) {
  const issues = [];
  for (const c of p.columns) {
    if (c.missingPct > 2) issues.push({
      severity: c.missingPct > 25 ? "high" : c.missingPct > 8 ? "medium" : "low",
      kind: "Missing values", column: c.name,
      detail: `${c.missing.toLocaleString()} of ${p.rowCount.toLocaleString()} rows (${c.missingPct.toFixed(1)}%) are empty in "${c.name}".`,
      fix: c.missingPct > 25 ? "Treat aggregates on this column as partial, or exclude it." : "Rows with blanks are skipped in per-column aggregates.",
    });
    if (c.type === "numeric" && c.stats && c.stats.outlierPct > 1 && p.rowCount >= 12) issues.push({
      severity: c.stats.outlierPct > 6 ? "medium" : "low",
      kind: "Outliers", column: c.name,
      detail: `${c.stats.outlierCount.toLocaleString()} values in "${c.name}" fall outside the 1.5×IQR fences (below ${fmtN(c.stats.fenceLow)} or above ${fmtN(c.stats.fenceHigh)}).`,
      fix: "Kept in the data. Median is reported alongside mean where distributions are skewed.",
    });
    if (c.type === "numeric" && c.stats && c.stats.negatives > 0 && /(qty|quantity|price|sales|revenue|units)/i.test(c.name)) issues.push({
      severity: "medium", kind: "Implausible values", column: c.name,
      detail: `"${c.name}" contains ${c.stats.negatives.toLocaleString()} negative values, which is unusual for this kind of field. These may be returns or data-entry errors.`,
      fix: "Confirm whether negatives represent refunds before reading totals as gross.",
    });
    if (c.type === "categorical" && c.top) {
      const norm = new Map();
      for (const t of c.top) {
        const k = t.value.trim().toLowerCase();
        norm.set(k, (norm.get(k) || 0) + 1);
      }
      const clashes = [...norm.entries()].filter(([, v]) => v > 1);
      if (clashes.length) issues.push({
        severity: "low", kind: "Inconsistent labels", column: c.name,
        detail: `"${c.name}" has labels that differ only by case or whitespace (${clashes.map(c2 => `"${c2[0]}"`).slice(0, 3).join(", ")}). They are counted as separate categories.`,
        fix: "Normalise casing upstream for cleaner grouping.",
      });
    }
  }
  if (p.duplicateRows > 0) issues.unshift({
    severity: p.duplicatePct > 3 ? "high" : "medium", kind: "Duplicate rows", column: "—",
    detail: `${p.duplicateRows.toLocaleString()} rows (${p.duplicatePct.toFixed(2)}%) are exact duplicates of an earlier row.`,
    fix: "Duplicates inflate totals. Deduplicate upstream if each row should be unique.",
  });
  const w = { high: 9, medium: 4, low: 1.2 };
  let score = 100;
  score -= Math.min(30, p.missingPct * 1.6);
  score -= Math.min(20, p.duplicatePct * 4);
  score -= Math.min(35, issues.reduce((a, i) => a + w[i.severity], 0));
  score = Math.max(12, Math.round(score));
  return {
    score, issues,
    label: score >= 90 ? "Excellent" : score >= 75 ? "Good" : score >= 60 ? "Fair" : "Needs attention",
    completeness: 100 - p.missingPct,
    counts: { high: issues.filter(i => i.severity === "high").length, medium: issues.filter(i => i.severity === "medium").length, low: issues.filter(i => i.severity === "low").length },
  };
}

/* ------------------------------ aggregation core ----------------------------- */

export const num = (r, c) => toNum(r[c]);
export const dateOf = (r, c) => toDate(r[c]);

export function groupBy(rows, dim, metric, agg = "sum", limit = 0) {
  const m = new Map();
  for (const r of rows) {
    const k = isBlank(r[dim]) ? "(blank)" : String(r[dim]);
    const v = metric ? num(r, metric) : 1;
    if (metric && v === null) continue;
    let e = m.get(k);
    if (!e) { e = { key: k, sum: 0, n: 0, vals: [] }; m.set(k, e); }
    e.sum += metric ? v : 1; e.n++;
    if (agg === "median" || agg === "max" || agg === "min") e.vals.push(v);
  }
  let out = [...m.values()].map(e => ({
    key: e.key, n: e.n,
    value: agg === "count" ? e.n : agg === "avg" ? e.sum / e.n
      : agg === "median" ? quantile(e.vals.sort((a, b) => a - b), 0.5)
        : agg === "max" ? Math.max(...e.vals) : agg === "min" ? Math.min(...e.vals) : e.sum,
    sum: e.sum,
  }));
  out.sort((a, b) => b.value - a.value);
  const total = out.reduce((a, b) => a + b.value, 0);
  out.forEach(o => { o.share = total ? (o.value / total) * 100 : 0; });
  return limit ? out.slice(0, limit) : out;
}

const p2 = v => String(v).padStart(2, "0");
const localISO = d => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
const GRAINS = {
  day: d => localISO(d),
  week: d => { const x = new Date(d); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return localISO(x); },
  month: d => `${d.getFullYear()}-${p2(d.getMonth() + 1)}`,
  quarter: d => `${d.getFullYear()}-Q${Math.floor(d.getMonth() / 3) + 1}`,
  year: d => String(d.getFullYear()),
};

// Trims leading and trailing buckets that hold far fewer records than a typical
// period — a mid-month extract, a fiscal-year boundary or a timezone edge would
// otherwise anchor first-vs-last comparisons on a sliver of data.
export function completePeriods(pts, minShare = 0.3) {
  if (pts.length < 3) return { series: pts, trimmedStart: 0, trimmedEnd: 0 };
  const counts = [...pts.map(p => p.n || 0)].sort((a, b) => a - b);
  const median = counts[Math.floor(counts.length / 2)] || 0;
  if (!median) return { series: pts, trimmedStart: 0, trimmedEnd: 0 };
  const floor = median * minShare;
  let a = 0, b = pts.length;
  while (b - a > 3 && (pts[a].n || 0) < floor) a++;
  while (b - a > 3 && (pts[b - 1].n || 0) < floor) b--;
  return {
    series: pts.slice(a, b), trimmedStart: a, trimmedEnd: pts.length - b,
    partialTail: pts.length - b > 0 ? pts[b] : null,
  };
}

export function pickGrain(spanDays) {
  if (spanDays == null) return "month";
  if (spanDays <= 45) return "day";
  if (spanDays <= 200) return "week";
  if (spanDays <= 1200) return "month";
  return "quarter";
}

export function timeSeries(rows, dateCol, metric, grain = "month", agg = "sum", filter = null) {
  const key = GRAINS[grain] || GRAINS.month;
  const m = new Map();
  for (const r of rows) {
    if (filter && !filter(r)) continue;
    const d = dateOf(r, dateCol);
    if (!d) continue;
    const v = metric ? num(r, metric) : 1;
    if (metric && v === null) continue;
    const k = key(d);
    let e = m.get(k);
    if (!e) { e = { period: k, sum: 0, n: 0 }; m.set(k, e); }
    e.sum += metric ? v : 1; e.n++;
  }
  const pts = [...m.values()].sort((a, b) => (a.period < b.period ? -1 : 1))
    .map(e => ({ period: e.period, n: e.n, value: agg === "avg" ? e.sum / e.n : agg === "count" ? e.n : e.sum }));
  return pts;
}

export function pearson(xs, ys) {
  const n = xs.length;
  if (n < 3) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { const a = xs[i] - mx, b = ys[i] - my; sxy += a * b; sxx += a * a; syy += b * b; }
  if (sxx === 0 || syy === 0) return null;
  return sxy / Math.sqrt(sxx * syy);
}

export function correlations(rows, metrics, minAbs = 0.25) {
  const names = metrics.map(m => m.name);
  const pairs = [];
  for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) {
    const xs = [], ys = [];
    for (const r of rows) {
      const a = num(r, names[i]), b = num(r, names[j]);
      if (a === null || b === null) continue;
      xs.push(a); ys.push(b);
      if (xs.length > 20000) break;
    }
    const r = pearson(xs, ys);
    if (r !== null) pairs.push({ a: names[i], b: names[j], r, n: xs.length });
  }
  pairs.sort((x, y) => Math.abs(y.r) - Math.abs(x.r));
  return { pairs, strong: pairs.filter(p => Math.abs(p.r) >= minAbs) };
}

export function linreg(ys) {
  const n = ys.length;
  const xs = ys.map((_, i) => i);
  const mx = (n - 1) / 2, my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0;
  for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; }
  const slope = sxx ? sxy / sxx : 0, intercept = my - slope * mx;
  const fit = xs.map(x => intercept + slope * x);
  const ssTot = ys.reduce((a, b) => a + (b - my) ** 2, 0);
  const ssRes = ys.reduce((a, b, i) => a + (b - fit[i]) ** 2, 0);
  return { slope, intercept, fit, r2: ssTot ? 1 - ssRes / ssTot : 0, residStd: Math.sqrt(ssRes / Math.max(1, n - 2)) };
}

/* --------------------------------- forecasting ------------------------------- */

function nextPeriods(last, grain, k) {
  const out = [];
  if (grain === "month") {
    let [y, m] = last.split("-").map(Number);
    for (let i = 0; i < k; i++) { m++; if (m > 12) { m = 1; y++; } out.push(`${y}-${String(m).padStart(2, "0")}`); }
  } else if (grain === "quarter") {
    let [y, q] = last.split("-Q").map(Number);
    for (let i = 0; i < k; i++) { q++; if (q > 4) { q = 1; y++; } out.push(`${y}-Q${q}`); }
  } else if (grain === "year") {
    let y = Number(last);
    for (let i = 0; i < k; i++) out.push(String(++y));
  } else {
    const [ly, lm, ld] = last.split("-").map(Number);
    let d = new Date(ly, lm - 1, ld);
    const step = grain === "week" ? 7 : 1;
    for (let i = 0; i < k; i++) { d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + step); out.push(localISO(d)); }
  }
  return out;
}

export function forecast(series, grain, horizon = 3) {
  const ys = series.map(p => p.value);
  const n = ys.length;
  if (n < 6) return { ok: false, reason: `Only ${n} ${grain} periods of history are available. At least 6 are needed before a trend estimate is meaningful.` };
  const season = { month: 12, quarter: 4, week: 52, day: 7 }[grain] || 0;
  const reg = linreg(ys);
  let idx = null, model = "Ordinary least-squares linear trend";
  if (season && n >= season * 2) {
    idx = Array(season).fill(0).map(() => []);
    ys.forEach((y, i) => { const f = reg.fit[i]; if (f) idx[i % season].push(y / f); });
    idx = idx.map(a => (a.length ? a.reduce((x, b) => x + b, 0) / a.length : 1));
    model = `Linear trend × ${season}-period seasonal index`;
  }
  const periods = nextPeriods(series[n - 1].period, grain, horizon);
  const resid = ys.map((y, i) => y - reg.fit[i] * (idx ? idx[i % season] : 1));
  const rStd = Math.sqrt(resid.reduce((a, b) => a + b * b, 0) / Math.max(1, n - 2));
  const points = periods.map((period, k) => {
    const base = reg.intercept + reg.slope * (n + k);
    const v = base * (idx ? idx[(n + k) % season] : 1);
    const widen = Math.sqrt(1 + (k + 1) / n) * 1.96 * rStd;
    return { period, value: Math.max(0, v), lo: Math.max(0, v - widen), hi: v + widen, forecast: true };
  });
  const histMean = ys.reduce((a, b) => a + b, 0) / n;
  return {
    ok: true, points, model, r2: reg.r2, horizon, grain,
    slopePerPeriod: reg.slope,
    confidence: reg.r2 > 0.6 && n >= 12 ? "Moderate" : reg.r2 > 0.35 ? "Low–moderate" : "Low",
    intervalNote: "Shaded band is a ±1.96×residual-σ interval, widened with horizon.",
    assumptions: [
      `Assumes the historical ${grain}ly pattern continues unchanged.`,
      idx ? `Seasonality estimated from ${Math.floor(n / season)} full cycles — thin, so seasonal factors are approximate.` : "No seasonal component: history is too short to estimate one.",
      "No external drivers (pricing changes, campaigns, supply shocks) are modelled.",
    ],
    limitations: [
      `R² of the trend fit is ${reg.r2.toFixed(2)}${reg.r2 < 0.4 ? " — the trend explains little of the variation, so treat the level as indicative only." : "."}`,
      n < 12 ? `Only ${n} periods of history.` : `Based on ${n} periods of history (mean ${fmtN(histMean)}).`,
      "This is a forecast estimate, not a guaranteed outcome.",
    ],
  };
}

/* ------------------------------- insight engine ------------------------------ */

const pct = (a, b) => (b === 0 ? null : ((a - b) / Math.abs(b)) * 100);
export function fmtN(v, opts = {}) {
  if (v == null || !isFinite(v)) return "—";
  const a = Math.abs(v);
  if (opts.money) {
    if (a >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
    if (a >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
    if (a >= 1e4) return `$${(v / 1e3).toFixed(1)}K`;
    return `$${v.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
  }
  if (a >= 1e9) return (v / 1e9).toFixed(2) + "B";
  if (a >= 1e6) return (v / 1e6).toFixed(2) + "M";
  if (a >= 1e4) return (v / 1e3).toFixed(1) + "K";
  if (Number.isInteger(v)) return v.toLocaleString();
  if (a < 1) return v.toFixed(3);
  return v.toLocaleString(undefined, { maximumFractionDigits: 2 });
}
const isMoney = c => /(revenue|sales|profit|cost|price|amount|spend|margin|income|fee|salary|value|gmv|arr|mrr)/i.test(c.name);
export const fmtCol = (v, col) => fmtN(v, { money: col && isMoney(col) });

export function autoKPIs(p, rows) {
  const order = { revenue: 0, profit: 1, marketing: 3, cost: 4, qty: 2, price: 6, discount: 7, measure: 5 };
  const scored = p.metrics.map(c => ({
    col: c,
    score: (order[c.role] ?? 8) + (c.missingPct > 30 ? 5 : 0) + (c.stats && c.stats.std === 0 ? 9 : 0),
  })).sort((a, b) => a.score - b.score);
  const chosen = scored.slice(0, 4).map(s => s.col);
  const dateCol = p.primaryDate;
  const grain = dateCol ? pickGrain(dateCol.spanDays) : null;
  const kpis = chosen.map(c => {
    const k = { column: c.name, role: c.role, money: isMoney(c), total: c.stats.sum, avg: c.stats.mean, agg: "sum" };
    if (c.role === "price" || c.role === "discount" || c.additive === false || /rate|pct|percent|ratio|score/i.test(c.name)) { k.agg = "avg"; k.headline = c.stats.mean; }
    else k.headline = c.stats.sum;
    if (dateCol) {
      const raw = timeSeries(rows, dateCol.name, c.name, grain, k.agg);
      const ts = completePeriods(raw).series;
      if (ts.length >= 2) {
        const cur = ts[ts.length - 1], prev = ts[ts.length - 2];
        k.series = ts; k.grain = grain;
        k.delta = pct(cur.value, prev.value);
        k.deltaLabel = `vs previous ${grain}`;
        k.current = cur.value; k.previous = prev.value; k.currentPeriod = cur.period; k.previousPeriod = prev.period;
      }
    }
    return k;
  });
  // derived: distinct customer count, margin %
  const custDim = p.columns.find(c => kw.customer.test(c.name) && !kw.freeText.test(c.name) && (c.type === "id" || c.type === "categorical"));
  if (custDim) kpis.push({ column: custDim.name, role: "customer", label: "Distinct " + custDim.name, headline: custDim.unique, agg: "distinct", money: false });
  // A margin/profit-rate column is not a profit amount — dividing its sum by revenue
  // is meaningless, so derived margin only uses an additive profit column.
  const rev = p.metrics.find(c => c.role === "revenue"), pr = p.metrics.find(c => c.role === "profit" && c.additive !== false);
  if (rev && pr && rev.stats.sum) kpis.push({ column: "margin", role: "ratio", label: "Profit margin", headline: (pr.stats.sum / rev.stats.sum) * 100, unit: "%", agg: "derived", formula: `sum(${pr.name}) ÷ sum(${rev.name})`, money: false });
  return kpis.slice(0, 6);
}

let IID = 0;
const mk = (o) => ({ id: "i" + (++IID), ...o });

const BLANK = "(blank)";

// A group is only nameable in a title or recommendation if it is a real category
// (not the missing-value bucket) and material enough to act on.
function material(groups, rowTotal, minShare = 2, minRowShare = 1) {
  return groups.filter(g => g.key !== BLANK && g.share >= minShare && (!rowTotal || (g.n / rowTotal) * 100 >= minRowShare));
}

// Normalised Herfindahl: 0 = perfectly even, 1 = everything in one group. Guards
// against "top 3 of 3 hold 100%" and against calling an even split concentrated.
function concentration(groups) {
  const k = groups.length;
  if (k < 2) return null;
  const total = groups.reduce((a, b) => a + Math.max(0, b.value), 0);
  if (!total) return null;
  const hhi = groups.reduce((a, b) => a + (Math.max(0, b.value) / total) ** 2, 0);
  const even = 1 / k;
  const topN = Math.min(3, k - 1);
  const topShare = groups.slice(0, topN).reduce((a, b) => a + (Math.max(0, b.value) / total) * 100, 0);
  return { k, topN, topShare, hhi, normalized: (hhi - even) / (1 - even), baseline: (topN / k) * 100 };
}

// The lead metric must be additive — a share column summed to 100 is not a finding.
function leadMetricOf(p) {
  const add = p.additiveMetrics && p.additiveMetrics.length ? p.additiveMetrics : p.metrics;
  return add.find(c => c.role === "revenue") || add.find(c => c.role === "measure") || add[0] || p.metrics[0] || null;
}

export function generateInsights(p, rows) {
  const out = [];
  const rev = leadMetricOf(p);
  const profitCol = p.metrics.find(c => c.role === "profit" && c.additive !== false);
  const dateCol = p.primaryDate;
  const grain = dateCol ? pickGrain(dateCol.spanDays) : null;
  const dims = p.dimensions.filter(d => d.cardinality >= 2 && d.cardinality <= 40);
  const covered = new Set();

  /* --- performance: headline totals --- */
  if (rev) {
    const s = rev.stats;
    out.push(mk({
      category: "Performance", priority: "Medium", confidence: "High",
      title: rev.additive === false
        ? `${rev.name} averages ${fmtCol(s.mean, rev)} across ${p.rowCount.toLocaleString()} records`
        : `${rev.name} totals ${fmtCol(s.sum, rev)} across ${p.rowCount.toLocaleString()} records`,
      body: `Mean ${fmtCol(s.mean, rev)} per record, median ${fmtCol(s.median, rev)}. ${s.skew > 1 ? "The distribution is right-skewed, so the mean is pulled up by a small number of large records — the median is the better typical value." : "Mean and median are close, so the distribution is reasonably symmetric."}`,
      evidence: [
        { label: `Sum of ${rev.name}`, value: fmtCol(s.sum, rev) },
        { label: "Mean", value: fmtCol(s.mean, rev) },
        { label: "Median", value: fmtCol(s.median, rev) },
        { label: "Max single record", value: fmtCol(s.max, rev) },
        { label: "Skewness", value: s.skew.toFixed(2) },
      ],
      method: `Descriptive statistics over ${s.count.toLocaleString()} non-null values of "${rev.name}".`,
      viz: rev.histogram && rev.histogram.length ? { type: "histogram", title: `Distribution of ${rev.name}`, bins: rev.histogram, col: rev.name, money: isMoney(rev) } : null,
    }));
  }

  /* --- trends --- */
  if (rev && dateCol) {
    const ts = timeSeries(rows, dateCol.name, rev.name, grain);
    const trim = completePeriods(ts);
    if (trim.series.length >= 4) {
      const full = trim.series;
      const partialNote = trim.trimmedStart || trim.trimmedEnd
        ? ` ${trim.trimmedStart + trim.trimmedEnd} partial ${grain}${trim.trimmedStart + trim.trimmedEnd > 1 ? "s" : ""} at the edge of the file ${trim.trimmedStart + trim.trimmedEnd > 1 ? "were" : "was"} excluded from the comparison.`
        : "";
      const reg = linreg(full.map(t => t.value));
      const first = full[0], last = full[full.length - 1];
      const change = pct(last.value, first.value);
      const dir = reg.slope > 0 ? "rising" : "falling";
      const half = Math.floor(full.length / 2);
      const h1 = full.slice(0, half).reduce((a, b) => a + b.value, 0);
      const h2 = full.slice(half).reduce((a, b) => a + b.value, 0);
      out.push(mk({
        category: "Trends", priority: Math.abs(change) > 20 ? "High" : "Medium",
        confidence: reg.r2 > 0.5 ? "High" : reg.r2 > 0.25 ? "Moderate" : "Low",
        title: `${rev.name} is ${dir} — ${change > 0 ? "+" : ""}${change.toFixed(1)}% from the first to the latest complete ${grain}`,
        body: `Fitting a linear trend across ${full.length} ${grain}s gives a slope of ${fmtCol(reg.slope, rev)} per ${grain} (R² ${reg.r2.toFixed(2)}). Second half of the period totals ${fmtCol(h2, rev)} against ${fmtCol(h1, rev)} in the first half.${reg.r2 < 0.3 ? " The low R² means period-to-period noise dominates the trend — read the direction, not the slope." : ""}${partialNote}`,
        evidence: [
          { label: `First ${grain} (${first.period})`, value: fmtCol(first.value, rev) },
          { label: `Latest complete ${grain} (${last.period})`, value: fmtCol(last.value, rev) },
          { label: "Change", value: `${change > 0 ? "+" : ""}${change.toFixed(1)}%` },
          { label: "Trend slope", value: `${fmtCol(reg.slope, rev)} / ${grain}` },
          { label: "R²", value: reg.r2.toFixed(3) },
        ],
        method: `Aggregated "${rev.name}" by ${grain} on "${dateCol.name}", then fitted least-squares regression on the period index. Periods at either end holding under 30% of a typical period's record count are treated as partial and excluded.`,
        viz: { type: "line", title: `${rev.name} by ${grain}`, points: ts, col: rev.name, money: isMoney(rev) },
      }));

      // anomalies in the series
      const vals = full.map(t => t.value);
      const st = numStats(vals);
      const spikes = full.filter(t => Math.abs((t.value - st.mean) / (st.std || 1)) > 2);
      if (spikes.length) out.push(mk({
        category: "Anomalies", priority: "Medium", confidence: "High",
        title: `${spikes.length} ${grain}${spikes.length > 1 ? "s" : ""} deviate more than 2σ from the mean`,
        body: `Mean ${grain}ly ${rev.name} is ${fmtCol(st.mean, rev)} with σ ${fmtCol(st.std, rev)}. ${spikes.map(s => `${s.period} at ${fmtCol(s.value, rev)} (${((s.value - st.mean) / st.std).toFixed(1)}σ)`).join("; ")}. These periods are worth a separate explanation before they are read as trend.`,
        evidence: spikes.slice(0, 5).map(s => ({ label: s.period, value: `${fmtCol(s.value, rev)} · ${((s.value - st.mean) / st.std).toFixed(1)}σ · ${s.n.toLocaleString()} rows` })),
        method: `Z-score of each ${grain}'s total against the mean and standard deviation of all complete periods.`,        viz: { type: "line", title: `${rev.name} by ${grain}`, points: ts, col: rev.name, money: isMoney(rev), marks: spikes.map(s => s.period) },
      }));

      // seasonality
      if (grain === "month" && full.length >= 18) {
        const byMonth = new Map();
        full.forEach(t => { const m = +t.period.slice(5, 7); byMonth.set(m, [...(byMonth.get(m) || []), t.value]); });
        const avg = [...byMonth.entries()].map(([m, a]) => ({ m, v: a.reduce((x, y) => x + y, 0) / a.length })).sort((a, b) => b.v - a.v);
        const mean = avg.reduce((a, b) => a + b.v, 0) / avg.length;
        const MN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
        const spread = (avg[0].v - avg[avg.length - 1].v) / mean * 100;
        if (spread > 25) out.push(mk({
          category: "Trends", priority: "Medium", confidence: "Moderate",
          title: `Seasonal pattern: ${MN[avg[0].m - 1]} runs ${((avg[0].v / mean - 1) * 100).toFixed(0)}% above the monthly average`,
          body: `Averaging each calendar month across the available history, the strongest month is ${MN[avg[0].m - 1]} (${fmtCol(avg[0].v, rev)}) and the weakest is ${MN[avg[avg.length - 1].m - 1]} (${fmtCol(avg[avg.length - 1].v, rev)}) — a spread of ${spread.toFixed(0)}% of the monthly mean. With fewer than three full years this is a pattern, not a confirmed seasonal cycle.`,
          evidence: avg.slice(0, 4).map(a => ({ label: MN[a.m - 1], value: `${fmtCol(a.v, rev)} (${((a.v / mean - 1) * 100).toFixed(0)}% vs avg)` })),
          method: "Grouped monthly totals by calendar month and compared each month's average with the overall monthly mean.",
          viz: { type: "bar", title: "Average by calendar month", items: avg.sort((a, b) => a.m - b.m).map(a => ({ key: MN[a.m - 1], value: a.v })), money: isMoney(rev) },
        }));
      }
    }
  }

  /* --- concentration / opportunity / problem by dimension --- */
  if (rev) for (const d of dims.slice(0, 6)) {
    const g = groupBy(rows, d.name, rev.name, "sum");
    if (g.length < 2) continue;
    const real = material(g, p.rowCount);
    const con = concentration(g);
    if (real.length >= 2 && con && con.k >= 5 && con.topShare >= con.baseline * 1.4 && con.normalized >= 0.15) {
      const top = real[0];
      covered.add(d.name);
      out.push(mk({
        category: "Opportunities", priority: con.normalized > 0.35 ? "High" : "Medium", confidence: "High",
        title: `${rev.name} is concentrated: top ${con.topN} of ${con.k} ${d.name} values hold ${con.topShare.toFixed(0)}% of the total`,
        body: `"${top.key}" alone accounts for ${top.share.toFixed(1)}% (${fmtCol(top.value, rev)}). An even split across ${con.k} values would put ${con.baseline.toFixed(0)}% in the top ${con.topN}, so this is ${(con.topShare / con.baseline).toFixed(1)}× the even-share baseline (normalised Herfindahl ${con.normalized.toFixed(2)}). Performance is tied to a small number of ${d.name} values — an opportunity if the leaders can be replicated, a risk if any of them falters.`,
        evidence: g.slice(0, 5).map(x => ({ label: x.key === BLANK ? `${BLANK} — unattributed` : x.key, value: `${fmtCol(x.value, rev)} · ${x.share.toFixed(1)}% · ${x.n.toLocaleString()} rows` })),
        method: `GROUP BY "${d.name}", SUM("${rev.name}"); shares compared against an even-split baseline and a normalised Herfindahl index. Missing-value and sub-2% groups are excluded from the named leader.`,
        viz: { type: "bar", title: `${rev.name} by ${d.name}`, items: g.slice(0, 10), money: isMoney(rev) },
      }));
    }

    // margin mismatch: high revenue share, low profit share
    if (profitCol) {
      const gp = groupBy(rows, d.name, profitCol.name, "sum");
      const pmap = new Map(gp.map(x => [x.key, x]));
      const mismatch = real.slice(0, Math.min(8, real.length)).map(x => {
        const pp = pmap.get(x.key);
        return pp ? { key: x.key, revShare: x.share, profShare: pp.share, rev: x.value, prof: pp.value, margin: x.value ? (pp.value / x.value) * 100 : 0, gap: x.share - pp.share } : null;
      }).filter(Boolean).sort((a, b) => b.gap - a.gap);
      const worst = mismatch[0];
      if (worst && worst.gap > 3) {
        const avgMargin = (profitCol.stats.sum / rev.stats.sum) * 100;
        out.push(mk({
          category: "Problems", priority: worst.gap > 7 ? "High" : "Medium", confidence: "High",
          title: `"${worst.key}" takes ${worst.revShare.toFixed(1)}% of ${rev.name} but only ${worst.profShare.toFixed(1)}% of ${profitCol.name}`,
          body: `Its margin is ${worst.margin.toFixed(1)}% against a dataset-wide ${avgMargin.toFixed(1)}%. Revenue from this ${d.name} value is not converting into proportional profit. Pricing, discounting and unit cost are the three places that gap usually comes from — the dataset can confirm which if those fields are present.`,
          evidence: [
            { label: `${worst.key} — ${rev.name}`, value: fmtCol(worst.rev, rev) },
            { label: `${worst.key} — ${profitCol.name}`, value: fmtCol(worst.prof, profitCol) },
            { label: "Its margin", value: `${worst.margin.toFixed(1)}%` },
            { label: "Dataset margin", value: `${avgMargin.toFixed(1)}%` },
            { label: "Share gap", value: `${worst.gap.toFixed(1)} pts` },
          ],
          method: `Grouped both "${rev.name}" and "${profitCol.name}" by "${d.name}", compared each group's share of each total, ranked by the share gap.`,
          recommendation: `Review pricing and discount policy for ${d.name} = "${worst.key}" before adding more volume to it.`,
          viz: { type: "grouped", title: `Revenue share vs profit share by ${d.name}`, items: mismatch.slice(0, 8).map(m => ({ key: m.key, a: m.revShare, b: m.profShare })), aLabel: `${rev.name} share %`, bLabel: `${profitCol.name} share %` },
        }));
      }
      const losers = gp.filter(x => x.value < 0 && x.key !== BLANK);
      if (losers.length) out.push(mk({
        category: "Problems", priority: "High", confidence: "High",
        title: `${losers.length} ${d.name} value${losers.length > 1 ? "s" : ""} are loss-making`,
        body: `Summing "${profitCol.name}" by "${d.name}" returns negative totals for ${losers.slice(0, 4).map(l => `"${l.key}" (${fmtCol(l.value, profitCol)})`).join(", ")}${losers.length > 4 ? ` and ${losers.length - 4} more` : ""}. Combined drag is ${fmtCol(losers.reduce((a, b) => a + b.value, 0), profitCol)}.`,
        evidence: losers.slice(0, 6).map(l => ({ label: l.key, value: fmtCol(l.value, profitCol) })),
        method: `GROUP BY "${d.name}", SUM("${profitCol.name}"), filtered to negative totals.`,
        recommendation: "Decide per value: fix the economics, reprice, or exit.",
        viz: { type: "bar", title: `${profitCol.name} by ${d.name}`, items: gp, money: isMoney(profitCol), diverging: true },
      }));
    }

    // declining segment
    if (dateCol && g.length >= 3) {
      const ts = completePeriods(timeSeries(rows, dateCol.name, rev.name, grain)).series;
      if (ts.length >= 6) {
        const cut = ts[Math.floor(ts.length / 2)].period;
        const decl = real.slice(0, 10).map(x => {
          const a = rows.filter(r => String(r[d.name]) === x.key);
          const t = timeSeries(a, dateCol.name, rev.name, grain);
          const early = t.filter(p => p.period < cut).reduce((s, p) => s + p.value, 0);
          const late = t.filter(p => p.period >= cut).reduce((s, p) => s + p.value, 0);
          return { key: x.key, early, late, change: pct(late, early), series: t };
        }).filter(x => x.change !== null && x.early > rev.stats.sum * 0.01).sort((a, b) => a.change - b.change);
        const w = decl[0];
        if (w && w.change < -12) out.push(mk({
          category: "Problems", priority: w.change < -30 ? "Critical" : "High", confidence: "Moderate",
          title: `${d.name} "${w.key}" declined ${Math.abs(w.change).toFixed(1)}% between the two halves of the period`,
          body: `Splitting the timeline at ${cut}: ${fmtCol(w.early, rev)} before against ${fmtCol(w.late, rev)} after. Against a dataset-wide change of ${(() => { const e = ts.filter(p => p.period < cut).reduce((s, p) => s + p.value, 0); const l = ts.filter(p => p.period >= cut).reduce((s, p) => s + p.value, 0); const c = pct(l, e); return `${c > 0 ? "+" : ""}${c.toFixed(1)}%`; })()}, this is specific to "${w.key}" rather than a general slowdown.`,
          evidence: [
            { label: `Before ${cut}`, value: fmtCol(w.early, rev) },
            { label: `From ${cut}`, value: fmtCol(w.late, rev) },
            { label: "Change", value: `${w.change.toFixed(1)}%` },
            ...decl.slice(1, 4).map(x => ({ label: `${x.key} (for contrast)`, value: `${x.change > 0 ? "+" : ""}${x.change.toFixed(1)}%` })),
          ],
          method: `Filtered rows to each ${d.name} value, aggregated "${rev.name}" by ${grain}, split the series at its midpoint and compared half-totals.`,
          recommendation: `Investigate what changed for "${w.key}" at ${cut} — this is a correlation in time, not a demonstrated cause.`,
          viz: { type: "line", title: `${rev.name} — ${w.key}`, points: w.series, col: rev.name, money: isMoney(rev) },
        }));
      }
    }
  }

  /* --- role-agnostic generators: any metric × dimension table --- */
  const lead = rev;
  if (lead && lead.stats) {
    const s = lead.stats;

    // (c) dispersion on the leading metric
    if (s.median > 0 && s.max / s.median >= 3) out.push(mk({
      category: "Performance", priority: s.max / s.median >= 8 ? "Medium" : "Low", confidence: "High",
      title: `${lead.name} varies ${(s.max / s.median).toFixed(1)}× between the typical record and the largest`,
      body: `Median ${fmtCol(s.median, lead)}, p95 ${fmtCol(s.p95, lead)}, maximum ${fmtCol(s.max, lead)}, minimum ${fmtCol(s.min, lead)}. The middle half of records sits between ${fmtCol(s.q1, lead)} and ${fmtCol(s.q3, lead)}. Spread this wide means an average is a poor summary — the extremes deserve separate treatment.`,
      evidence: [
        { label: "Minimum", value: fmtCol(s.min, lead) }, { label: "Q1", value: fmtCol(s.q1, lead) },
        { label: "Median", value: fmtCol(s.median, lead) }, { label: "Q3", value: fmtCol(s.q3, lead) },
        { label: "p95", value: fmtCol(s.p95, lead) }, { label: "Maximum", value: fmtCol(s.max, lead) },
      ],
      method: `Percentiles and IQR on ${s.count.toLocaleString()} values of "${lead.name}".`,
      viz: lead.histogram && lead.histogram.length ? { type: "histogram", title: `Distribution of ${lead.name}`, bins: lead.histogram, col: lead.name, money: isMoney(lead) } : null,
    }));

    // (a) ranking and (b) group differences across every usable dimension
    const ranks = [], diffs = [];
    for (const d of dims.slice(0, 4)) {
      if (covered.has(d.name)) continue;
      const g = groupBy(rows, d.name, lead.name, "sum");
      const real = material(g, p.rowCount);
      if (real.length >= 2) {
        const top = real[0], bot = real[real.length - 1];
        if (bot.value > 0 && top.value / bot.value >= 1.4) ranks.push({ d, g, top, bot, effect: top.value / bot.value });
      }
      const minN = Math.max(5, rows.length / (d.cardinality * 2));
      const avg = groupBy(rows, d.name, lead.name, "avg").filter(x => x.key !== BLANK && x.n >= minN);
      if (avg.length >= 2) {
        const hi = avg[0], lo = avg[avg.length - 1];
        if (lo.value > 0 && hi.value / lo.value >= 1.3) diffs.push({ d, avg, hi, lo, effect: hi.value / lo.value });
      }
    }
    ranks.sort((a, b) => b.effect - a.effect).slice(0, 2).forEach(({ d, g, top, bot, effect }) => out.push(mk({
      category: "Performance", priority: effect >= 3 ? "Medium" : "Low", confidence: "High",
      title: `${d.name} "${top.key}" leads ${lead.name} at ${top.share.toFixed(1)}% of the total — ${effect.toFixed(1)}× the weakest, "${bot.key}"`,
      body: `Across ${g.length} values of "${d.name}", "${top.key}" accounts for ${fmtCol(top.value, lead)} against ${fmtCol(bot.value, lead)} for "${bot.key}". The ranking is a sum, so a leader can be leading on volume of records rather than on per-record size — "${top.key}" covers ${top.n.toLocaleString()} rows against ${bot.n.toLocaleString()}.`,
      evidence: g.slice(0, 6).map(x => ({ label: x.key === BLANK ? `${BLANK} — unattributed` : x.key, value: `${fmtCol(x.value, lead)} · ${x.share.toFixed(1)}% · ${x.n.toLocaleString()} rows` })),
      method: `GROUP BY "${d.name}", SUM("${lead.name}"); missing-value and sub-2% groups excluded from the named leader and laggard.`,
      viz: { type: "bar", title: `${lead.name} by ${d.name}`, items: g.slice(0, 10), money: isMoney(lead) },
    })));
    diffs.sort((a, b) => b.effect - a.effect).slice(0, 2).forEach(({ d, avg, hi, lo, effect }) => out.push(mk({
      category: "Opportunities", priority: effect >= 2 ? "Medium" : "Low", confidence: avg.length > 2 ? "Moderate" : "Low",
      title: `${d.name} "${hi.key}" averages ${((effect - 1) * 100).toFixed(0)}% more ${lead.name} per record than "${lo.key}"`,
      body: `Mean ${lead.name} is ${fmtCol(hi.value, lead)} for "${hi.key}" (${hi.n.toLocaleString()} rows) against ${fmtCol(lo.value, lead)} for "${lo.key}" (${lo.n.toLocaleString()} rows). This is a per-record difference, so it holds independently of how many records each group has — unlike a ranking by total.`,
      evidence: avg.slice(0, 6).map(x => ({ label: x.key, value: `${fmtCol(x.value, lead)} avg · ${x.n.toLocaleString()} rows` })),
      method: `GROUP BY "${d.name}", AVG("${lead.name}"), groups under ${Math.round(Math.max(3, rows.length * 0.01))} rows excluded. No significance test is applied — treat small groups with care.`,
      viz: { type: "bar", title: `Average ${lead.name} by ${d.name}`, items: avg.slice(0, 10), money: isMoney(lead) },
    })));

    // (e) top contributors when the table is keyed by an entity rather than dimensions
    if (!dims.length) {
      const key = p.columns.find(c => c.type === "id" && c.unique > 4 && c.type !== "date" && !c.isInteger)
        || p.ids.find(c => c.unique > 4);
      if (key) {
        const g = groupBy(rows, key.name, lead.name, "sum");
        const total = g.reduce((a, b) => a + b.value, 0);
        const topN = Math.max(1, Math.ceil(g.length * 0.2));
        const share = total ? (g.slice(0, topN).reduce((a, b) => a + b.value, 0) / total) * 100 : 0;
        out.push(mk({
          category: "Opportunities", priority: share > 60 ? "Medium" : "Low", confidence: "High",
          title: `Top ${topN} of ${g.length} ${key.name} values hold ${share.toFixed(1)}% of ${lead.name}`,
          body: `"${g[0].key}" alone accounts for ${g[0].share.toFixed(1)}% (${fmtCol(g[0].value, lead)}). An even split would give the top ${topN} about ${((topN / g.length) * 100).toFixed(0)}%, so this set is ${(share / ((topN / g.length) * 100)).toFixed(1)}× the even-share baseline.`,
          evidence: g.slice(0, 6).map(x => ({ label: x.key, value: `${fmtCol(x.value, lead)} · ${x.share.toFixed(1)}%` })),
          method: `GROUP BY "${key.name}", SUM("${lead.name}"); top-quintile share compared against an even-split baseline.`,
          viz: { type: "bar", title: `Top ${key.name} by ${lead.name}`, items: g.slice(0, 10), money: isMoney(lead) },
        }));
      }
    }
  }

  /* --- correlations --- */
  if (p.metrics.length >= 2) {
    const { strong } = correlations(rows, p.metrics.slice(0, 10), 0.35);
    // A share, a rate or a unit conversion of another column correlates at ~1.00
    // and says nothing. Detect it by testing whether the ratio between the two
    // columns is effectively constant.
    const isDerived = (a, b) => {
      const ratios = [];
      for (const r of rows) {
        const x = num(r, a), y = num(r, b);
        if (x === null || y === null || y === 0) continue;
        ratios.push(x / y);
        if (ratios.length >= 400) break;
      }
      if (ratios.length < 8) return false;
      const m = ratios.reduce((s2, v) => s2 + v, 0) / ratios.length;
      if (m === 0) return false;
      const sd = Math.sqrt(ratios.reduce((s2, v) => s2 + (v - m) ** 2, 0) / ratios.length);
      return Math.abs(sd / m) < 0.02;
    };
    const notTrivial = strong.filter(s => {
      const a = s.a.toLowerCase(), b = s.b.toLowerCase();
      if (a.includes(b) || b.includes(a)) return false;
      if (Math.abs(s.r) >= 0.99) return false;
      return !isDerived(s.a, s.b);
    });
    if (notTrivial.length) {
      const s = notTrivial[0];
      out.push(mk({
        category: "Performance", priority: "Low", confidence: Math.abs(s.r) > 0.7 ? "High" : "Moderate",
        title: `"${s.a}" and "${s.b}" move together (r = ${s.r.toFixed(2)})`,
        body: `Pearson correlation of ${s.r.toFixed(3)} across ${s.n.toLocaleString()} paired rows — ${Math.abs(s.r) > 0.7 ? "a strong" : "a moderate"} ${s.r > 0 ? "positive" : "negative"} linear relationship, explaining about ${(s.r * s.r * 100).toFixed(0)}% of the variance in one from the other. Correlation does not imply causation; both may be driven by a third factor such as volume or period.`,
        evidence: notTrivial.slice(0, 5).map(x => ({ label: `${x.a} ↔ ${x.b}`, value: `r = ${x.r.toFixed(3)} (n=${x.n.toLocaleString()})` })),
        method: "Pearson correlation computed pairwise over rows where both values are present.",
        viz: { type: "scatter", title: `${s.a} vs ${s.b}`, x: s.a, y: s.b, r: s.r },
      }));
    }
  }

  /* --- customer insights --- */
  // An identity column, not free text: "customer_note" matches the keyword but is a
  // caption. And the insight only earns its place if the distribution is uneven or
  // there is real repeat activity — a top decile holding ~10% of revenue says nothing.
  const custCol = p.columns.find(c => kw.customer.test(c.name) && !kw.freeText.test(c.name)
    && (c.type === "id" || c.type === "categorical") && c.unique > 5);
  if (custCol && rev) {
    const g = groupBy(rows, custCol.name, rev.name, "sum");
    const totalRev = g.reduce((a, b) => a + b.value, 0);
    const topN = Math.max(1, Math.ceil(g.length * 0.1));
    const topShare = g.slice(0, topN).reduce((a, b) => a + b.value, 0) / totalRev * 100;
    const repeat = g.filter(x => x.n > 1).length;
    const repeatPct = (repeat / g.length) * 100;
    if (topShare >= 20 || repeatPct >= 20) out.push(mk({
      category: "Customer Insights", priority: topShare > 45 ? "High" : "Medium", confidence: "High",
      title: topShare >= 20
        ? `Top 10% of ${custCol.name} values generate ${topShare.toFixed(1)}% of ${rev.name}`
        : `${repeatPct.toFixed(0)}% of ${custCol.name} values appear more than once; ${rev.name} is spread evenly across them`,
      body: `${g.length.toLocaleString()} distinct values of "${custCol.name}" appear in the data. ${repeat.toLocaleString()} (${(repeat / g.length * 100).toFixed(0)}%) appear in more than one row, i.e. repeat activity. Average value per ${custCol.name} is ${fmtCol(totalRev / g.length, rev)}; the top one is ${fmtCol(g[0].value, rev)}.`,
      evidence: [
        { label: `Distinct ${custCol.name}`, value: g.length.toLocaleString() },
        { label: "Top 10% share", value: `${topShare.toFixed(1)}%` },
        { label: "Repeat rate", value: `${repeatPct.toFixed(1)}%` },
        { label: "Average value", value: fmtCol(totalRev / g.length, rev) },
        { label: "Largest single value", value: `${g[0].key} — ${fmtCol(g[0].value, rev)}` },
      ],
      method: `GROUP BY "${custCol.name}", SUM("${rev.name}"); decile share and repeat counts derived from group sizes.`,
      recommendation: topShare > 45 ? `Revenue is dependent on a small group. Treat retention of the top ${topN.toLocaleString()} ${custCol.name} values as a defensive priority.` : null,
      viz: { type: "bar", title: `Top ${custCol.name} by ${rev.name}`, items: g.slice(0, 10), money: isMoney(rev) },
    }));
  }

  /* --- marketing insights --- */
  const spend = p.metrics.find(c => c.role === "marketing" || c.role === "cost");
  const chanCol = p.dimensions.find(c => c.role === "channel");
  if (spend && rev && chanCol) {
    const g = groupBy(rows, chanCol.name, rev.name, "sum");
    const sp = new Map(groupBy(rows, chanCol.name, spend.name, "sum").map(x => [x.key, x.value]));
    const roi = material(g, p.rowCount).map(x => ({ key: x.key, rev: x.value, spend: sp.get(x.key) || 0, ratio: (sp.get(x.key) || 0) > 0 ? x.value / sp.get(x.key) : null }))
      .filter(x => x.ratio !== null).sort((a, b) => b.ratio - a.ratio);
    const best = roi[0], worst = roi[roi.length - 1];
    const spread = best && worst && worst.ratio > 0 ? best.ratio / worst.ratio : 1;
    // A 1.47× vs 1.42× "gap" is noise, not a finding worth a recommendation.
    if (roi.length >= 2 && spread >= 1.25) out.push(mk({
      category: "Marketing Insights", priority: spread >= 1.8 ? "High" : "Medium", confidence: "Moderate",
      title: `${chanCol.name} "${worst.key}" returns ${worst.ratio.toFixed(1)}× spend against ${best.ratio.toFixed(1)}× for "${best.key}"`,
      body: `Dividing summed "${rev.name}" by summed "${spend.name}" per ${chanCol.name} — a ${spread.toFixed(1)}× spread between best and worst. This is an attribution-free ratio: it assumes spend recorded on a row is responsible for that row's revenue, which is rarely exactly true. Use it to rank channels, not to set exact budgets.`,
      evidence: roi.map(x => ({ label: x.key, value: `${fmtN(x.rev, { money: true })} rev / ${fmtN(x.spend, { money: true })} spend = ${x.ratio.toFixed(2)}×` })),
      method: `GROUP BY "${chanCol.name}" with SUM("${rev.name}") and SUM("${spend.name}"); ratio computed per group. Missing-value and sub-2% groups are excluded, and the finding is suppressed below a 1.25× spread.`,
      recommendation: `Test shifting budget from "${worst.key}" toward "${best.key}" on a small share of spend before committing.`,
      viz: { type: "bar", title: `Return per unit ${spend.name}`, items: roi.map(x => ({ key: x.key, value: x.ratio })) },
    }));
  }

  /* --- discount / pricing --- */
  const discCol = p.metrics.find(c => c.role === "discount");
  if (discCol && rev && dateCol) {
    const dts = completePeriods(timeSeries(rows, dateCol.name, discCol.name, grain, "avg")).series;
    if (dts.length >= 4) {
      const reg = linreg(dts.map(t => t.value));
      const first = dts[0].value, last = dts[dts.length - 1].value;
      if (Math.abs(last - first) > 0.005 && reg.slope > 0) out.push(mk({
        category: "Financial Insights", priority: "High", confidence: "High",
        title: `Average ${discCol.name} rose from ${(first * (first < 1 ? 100 : 1)).toFixed(1)}${first < 1 ? "%" : ""} to ${(last * (last < 1 ? 100 : 1)).toFixed(1)}${last < 1 ? "%" : ""} over the period`,
        body: `Mean "${discCol.name}" per ${grain} trends upward (slope ${reg.slope.toFixed(4)} per ${grain}, R² ${reg.r2.toFixed(2)}). Rising discount with rising revenue usually means volume is being bought rather than earned — check whether margin held.`,
        evidence: [
          { label: `First ${grain}`, value: (first * (first < 1 ? 100 : 1)).toFixed(2) + (first < 1 ? "%" : "") },
          { label: `Latest complete ${grain}`, value: (last * (last < 1 ? 100 : 1)).toFixed(2) + (last < 1 ? "%" : "") },
          { label: "Trend R²", value: reg.r2.toFixed(3) },
        ],
        method: `Average of "${discCol.name}" per ${grain}, least-squares trend on complete periods.`,
        recommendation: "Tie discount approval to a margin floor rather than a revenue target.",
        viz: { type: "line", title: `Average ${discCol.name} by ${grain}`, points: dts, col: discCol.name },
      }));
    }
  }

  /* --- operations --- */
  const opsCol = p.metrics.find(c => kw.ops.test(c.name));
  if (opsCol && opsCol.stats) {
    const s = opsCol.stats;
    if (s.outlierPct > 1) out.push(mk({
      category: "Operational Insights", priority: s.outlierPct > 5 ? "High" : "Medium", confidence: "High",
      title: `"${opsCol.name}" has a long tail: p95 is ${(s.p95 / (s.median || 1)).toFixed(1)}× the median`,
      body: `Median ${fmtN(s.median)}, p95 ${fmtN(s.p95)}, max ${fmtN(s.max)}. ${s.outlierCount.toLocaleString()} values (${s.outlierPct.toFixed(1)}%) sit beyond the 1.5×IQR fence. In operational metrics the tail is usually where the cost and the complaints are.`,
      evidence: [
        { label: "Median", value: fmtN(s.median) }, { label: "p95", value: fmtN(s.p95) },
        { label: "Max", value: fmtN(s.max) }, { label: "Beyond IQR fence", value: `${s.outlierCount.toLocaleString()} rows` },
      ],
      method: `Percentiles and IQR fences on ${s.count.toLocaleString()} values of "${opsCol.name}".`,
      viz: opsCol.histogram ? { type: "histogram", title: `Distribution of ${opsCol.name}`, bins: opsCol.histogram, col: opsCol.name } : null,
    }));
  }

  /* --- prediction --- */
  if (rev && dateCol) {
    const hist = completePeriods(timeSeries(rows, dateCol.name, rev.name, grain)).series;
    const f = forecast(hist, grain, 3);
    if (f.ok) {
      const nextP = f.points[0];
      const lastActual = hist[hist.length - 1];
      out.push(mk({
        category: "Predictions", priority: "Medium", confidence: f.confidence,
        title: `Forecast estimate: ${fmtCol(nextP.value, rev)} for ${nextP.period}`,
        body: `${f.model}, fitted on ${hist.length} complete ${grain}s. Range ${fmtCol(nextP.lo, rev)} – ${fmtCol(nextP.hi, rev)}. Last complete ${grain} (${lastActual.period}) was ${fmtCol(lastActual.value, rev)}. This is a forecast estimate, not a guaranteed outcome.`,
        evidence: [
          ...f.points.map(pt => ({ label: pt.period, value: `${fmtCol(pt.value, rev)}  (${fmtCol(pt.lo, rev)} – ${fmtCol(pt.hi, rev)})` })),
          { label: "Model", value: f.model }, { label: "Trend R²", value: f.r2.toFixed(3) },
        ],
        method: `Least-squares trend on ${grain}ly totals${f.model.includes("seasonal") ? " with a multiplicative seasonal index" : ""}. Interval = ±1.96×residual σ, widened with horizon.`,
        limitations: f.limitations, assumptions: f.assumptions,
        viz: { type: "line", title: `${rev.name} — actual and forecast`, points: [...hist, ...f.points], col: rev.name, money: isMoney(rev), forecastFrom: f.points[0].period },
      }));
    } else {
      const ts = timeSeries(rows, dateCol.name, rev.name, grain);
      out.push(mk({
        category: "Predictions", priority: "Low", confidence: "—",
        title: "Forecasting not reliable on this dataset",
        body: f.reason + " No forecast is shown rather than one that cannot be trusted.",
        evidence: [{ label: "Periods available", value: String(ts.length) }, { label: "Grain", value: grain }],
        method: "Precondition check before fitting any model: minimum 6 complete periods.",
      }));
    }
  } else if (rev) {
    out.push(mk({
      category: "Predictions", priority: "Low", confidence: "—",
      title: "No forecast is possible on this dataset",
      body: `Forecasting needs a date or timestamp column to order records in time, and no usable one was detected${p.dateCols.length ? ` (the date-like columns present — ${p.dateCols.map(c => `"${c.name}"`).join(", ")} — look like attributes rather than event dates)` : ""}. Every other analysis on this page is cross-sectional: it compares groups, not periods.`,
      evidence: [
        { label: "Date columns detected", value: String(p.dateCols.length) },
        { label: "Metrics available", value: String(p.metrics.length) },
        { label: "Dimensions available", value: String(p.dimensions.length) },
      ],
      method: "Precondition check: a forecast requires a time index. None was found, so none is offered.",
    }));
  }

  /* --- quality-driven insight --- */
  if (p.quality.issues.length) {
    const high = p.quality.issues.filter(i => i.severity !== "low");
    if (high.length) {
      const kinds = [...new Set(high.map(i => i.kind.toLowerCase()))];
      out.push(mk({
        category: "Problems", priority: p.quality.score < 70 ? "High" : "Medium", confidence: "High",
        title: `Data quality scores ${p.quality.score}/100 — ${high.length} issue${high.length > 1 ? "s" : ""} ${high.length > 1 ? "affect" : "affects"} how far these numbers can be trusted`,
        body: high.slice(0, 3).map(i => i.detail).join(" "),
        evidence: high.slice(0, 5).map(i => ({ label: `${i.kind} — ${i.column}`, value: i.severity })),
        method: "Per-column completeness, duplicate detection, IQR outlier fences and label-consistency checks.",
        recommendation: `Resolve the ${kinds.join(" and ")} flagged above before these figures are used for reporting.`,
      }));
    }
  }

  const PR = { Critical: 0, High: 1, Medium: 2, Low: 3, "—": 4 };
  return out.sort((a, b) => PR[a.priority] - PR[b.priority]);
}

/* ------------------------- executive summary (computed) ---------------------- */

export function execSummary(p, rows, insights) {
  const pick = (cat) => insights.find(i => i.category === cat);
  const rev = leadMetricOf(p);
  const blocks = [];
  const trend = pick("Trends");
  if (trend) blocks.push({ label: "Overall performance", text: trend.title + ". " + trend.body.split(". ")[0] + "." });
  else if (rev) {
    const spread = insights.find(i => i.title.includes("varies"));
    const rank = insights.find(i => i.title.includes("leads"));
    blocks.push({
      label: "Overall performance",
      text: `${rev.name} ${rev.additive === false ? `averages ${fmtCol(rev.stats.mean, rev)} per record` : `totals ${fmtCol(rev.stats.sum, rev)}`} across ${p.rowCount.toLocaleString()} records${rev.additive === false ? "" : `, averaging ${fmtCol(rev.stats.mean, rev)} each`} (median ${fmtCol(rev.stats.median, rev)}).`
        + (spread ? ` ${spread.title}.` : "")
        + (rank ? ` ${rank.title}.` : " No date column was detected, so the analysis compares groups rather than periods."),
    });
  }
  const opp = pick("Opportunities");
  if (opp) blocks.push({ label: "Key opportunity", text: opp.title + "." });
  // Only a genuinely high-priority problem earns the "critical risk" framing.
  const prob = insights.find(i => i.category === "Problems" && (i.priority === "Critical" || i.priority === "High"));
  if (prob) blocks.push({ label: "Critical risk", text: prob.title + "." });
  else {
    const watch = insights.find(i => i.category === "Problems");
    if (watch) blocks.push({ label: "Worth watching", text: watch.title + "." });
  }
  const rec = insights.find(i => i.recommendation && (i.priority === "Critical" || i.priority === "High"))
    || insights.find(i => i.recommendation);
  if (rec) blocks.push({ label: "Recommended action", text: rec.recommendation });
  const pred = pick("Predictions");
  if (pred) blocks.push({ label: "Forecast", text: pred.title + ". " + (pred.confidence === "Low" ? "Confidence is low — read it as a direction, not a number." : `Confidence: ${pred.confidence.toLowerCase()}.`) });
  return blocks;
}

export function suggestQuestions(p) {
  const q = [];
  const rev = leadMetricOf(p);
  const prof = p.metrics.find(c => c.role === "profit" && c.additive !== false);
  const pool = p.additiveMetrics && p.additiveMetrics.length ? p.additiveMetrics : p.metrics;
  const second = prof || pool.find(c => c !== rev);
  const timed = !!p.primaryDate;
  const dims = p.dimensions.filter(d => d.cardinality >= 2 && d.cardinality <= 40);
  const d0 = dims[0], d1 = dims[1];
  if (rev) q.push(timed ? `What is total ${rev.name} and how is it trending?` : `What is total ${rev.name} and how does it break down?`);
  if (rev && d0) q.push(`Which ${d0.name} performs best on ${rev.name}?`);
  if (prof && d0) q.push(`Where is ${prof.name} leaking relative to ${rev.name}?`);
  else if (second && d0) q.push(`How do ${d0.name} values compare on ${rev.name} and ${second.name}?`);
  if (timed && rev) q.push(`Why did ${rev.name} change in the most recent period?`);
  if (d1 && rev) q.push(`Compare ${d1.name} values on ${rev.name} and ${second ? second.name : "record counts"}.`);
  if (timed && rev) q.push(`Forecast ${rev.name} for the next three periods.`);
  if (rev && !timed) q.push(`Which records are outliers on ${rev.name}, and what do they have in common?`);
  q.push("What are the biggest problems in this dataset?");
  // A scenario question needs two distinct metrics to be meaningful.
  if (rev && second) q.push(`What happens to ${second.name} if ${rev.name} rises 10%?`);
  return q.slice(0, 8);
}

/* ------------------------------- agent toolbox ------------------------------- */

export function compactProfile(p) {
  return {
    rows: p.rowCount, columns: p.colCount,
    quality: { score: p.quality.score, missingPct: +p.missingPct.toFixed(2), duplicateRows: p.duplicateRows },
    primaryDateColumn: p.primaryDate ? { name: p.primaryDate.name, from: p.primaryDate.min.toISOString().slice(0, 10), to: p.primaryDate.max.toISOString().slice(0, 10), grain: pickGrain(p.primaryDate.spanDays) } : null,
    metrics: p.metrics.map(c => ({ name: c.name, role: c.role, sum: +c.stats.sum.toFixed(2), mean: +c.stats.mean.toFixed(2), median: +c.stats.median.toFixed(2), min: +c.stats.min.toFixed(2), max: +c.stats.max.toFixed(2), missingPct: +c.missingPct.toFixed(1) })),
    dimensions: p.dimensions.map(c => ({ name: c.name, role: c.role, distinct: c.cardinality, examples: (c.top || []).slice(0, 6).map(t => t.value) })),
    identifiers: p.ids.map(c => ({ name: c.name, distinct: c.unique })),
    otherColumns: p.columns.filter(c => !p.metrics.includes(c) && !p.dimensions.includes(c) && !p.ids.includes(c) && c.type !== "date").map(c => ({ name: c.name, type: c.type })),
  };
}

// Builds the tool set handed to the LLM. Every tool is deterministic JS over
// the real rows; the model never computes numbers itself.
export function makeTools(state) {
  const { profile, rows } = state;
  const log = state.toolLog;
  const record = (name, input, result, viz) => {
    const entry = { n: log.length + 1, tool: name, input, viz: viz || null, summary: result.summary || null };
    log.push(entry);
    return JSON.stringify(result);
  };
  const colOf = n => profile.columns.find(c => c.name === n);
  const need = (n, kinds) => {
    const c = colOf(n);
    if (!c) return `Column "${n}" does not exist. Available: ${profile.columnNames.join(", ")}`;
    if (kinds && !kinds.includes(c.type)) return `Column "${n}" is of type ${c.type}, not ${kinds.join("/")}.`;
    return null;
  };

  const T = [
    {
      name: "dataset_profile",
      description: "Full schema and statistics for the loaded dataset: row count, every column with type, role, missing %, and for numeric columns sum/mean/median/min/max. Call this first if you are unsure which columns exist.",
      input_schema: { type: "object", properties: {} },
      run: async () => record("dataset_profile", {}, { profile: compactProfile(profile) }),
    },
    {
      name: "column_detail",
      description: "Detailed statistics for one column: percentiles, standard deviation, outlier fences and counts for numeric columns; full frequency table for categorical columns.",
      input_schema: { type: "object", properties: { column: { type: "string" } }, required: ["column"] },
      run: async ({ column }) => {
        const err = need(column); if (err) return err;
        const c = colOf(column);
        return record("column_detail", { column }, {
          name: c.name, type: c.type, role: c.role, missing: c.missing, missingPct: +c.missingPct.toFixed(2),
          distinct: c.unique, stats: c.stats || null, topValues: c.top || null,
          range: c.type === "date" ? { from: c.min.toISOString().slice(0, 10), to: c.max.toISOString().slice(0, 10), spanDays: Math.round(c.spanDays) } : null,
        });
      },
    },
    {
      name: "group_by_analysis",
      description: "Aggregate a metric by one dimension. Returns every group with its value, share of total and row count, sorted descending. Use for rankings, comparisons, 'which X is best/worst', contribution analysis.",
      input_schema: {
        type: "object", properties: {
          dimension: { type: "string", description: "categorical column to group by" },
          metric: { type: "string", description: "numeric column to aggregate; omit to count rows" },
          agg: { type: "string", enum: ["sum", "avg", "count", "median", "min", "max"] },
          limit: { type: "number", description: "max groups returned, default 15" },
        }, required: ["dimension"],
      },
      run: async ({ dimension, metric, agg = "sum", limit = 15 }) => {
        let err = need(dimension); if (err) return err;
        if (metric) { err = need(metric, ["numeric", "boolean"]); if (err) return err; }
        const g = groupBy(rows, dimension, metric, agg, 0);
        const shown = g.slice(0, Math.min(limit, 30));
        const mc = metric ? colOf(metric) : null;
        return record("group_by_analysis", { dimension, metric, agg }, {
          dimension, metric: metric || "row count", agg, groups: g.length,
          total: +g.reduce((a, b) => a + b.value, 0).toFixed(2),
          rows: shown.map(x => ({ key: x.key, value: +x.value.toFixed(2), sharePct: +x.share.toFixed(2), n: x.n })),
          summary: `${metric || "rows"} by ${dimension}: ${shown.slice(0, 3).map(x => `${x.key} ${fmtCol(x.value, mc)}`).join(", ")}`,
        }, { type: "bar", title: `${metric || "Rows"} by ${dimension}${agg !== "sum" ? ` (${agg})` : ""}`, items: shown.slice(0, 12), money: mc ? isMoney(mc) : false, diverging: shown.some(x => x.value < 0) });
      },
    },
    {
      name: "time_series_analysis",
      description: "Aggregate a metric over time at a chosen grain, with period-over-period changes and a fitted trend. Use for 'trend', 'over time', 'growth', 'which period', 'why did X change'.",
      input_schema: {
        type: "object", properties: {
          metric: { type: "string" }, agg: { type: "string", enum: ["sum", "avg", "count"] },
          grain: { type: "string", enum: ["day", "week", "month", "quarter", "year"] },
          filter_dimension: { type: "string", description: "optional: restrict to one value of a dimension" },
          filter_value: { type: "string" },
        }, required: ["metric"],
      },
      run: async ({ metric, agg = "sum", grain, filter_dimension, filter_value }) => {
        if (!profile.primaryDate) return "This dataset has no usable date column, so no time-series analysis is possible.";
        let err = need(metric, ["numeric", "boolean"]); if (err) return err;
        const g = grain || pickGrain(profile.primaryDate.spanDays);
        const filt = filter_dimension && filter_value ? (r => String(r[filter_dimension]) === String(filter_value)) : null;
        const ts = timeSeries(rows, profile.primaryDate.name, metric, g, agg, filt);
        if (ts.length < 2) return "Not enough periods at this grain to analyse.";
        const reg = linreg(ts.map(p2 => p2.value));
        const mc = colOf(metric);
        const pts = ts.map((p2, i) => ({ period: p2.period, value: +p2.value.toFixed(2), rows: p2.n, changePct: i ? +(pct(p2.value, ts[i - 1].value) || 0).toFixed(2) : null }));
        return record("time_series_analysis", { metric, grain: g, agg, filter_dimension, filter_value }, {
          metric, grain: g, agg, dateColumn: profile.primaryDate.name,
          filter: filt ? `${filter_dimension} = ${filter_value}` : null,
          periods: pts,
          trend: { slopePerPeriod: +reg.slope.toFixed(3), r2: +reg.r2.toFixed(3) },
          note: "The final period may be incomplete depending on when the data was extracted.",
          summary: `${metric} by ${g}: ${pts[0].period} ${fmtCol(pts[0].value, mc)} → ${pts[pts.length - 1].period} ${fmtCol(pts[pts.length - 1].value, mc)}`,
        }, { type: "line", title: `${metric} by ${g}${filt ? ` — ${filter_value}` : ""}`, points: ts, col: metric, money: mc ? isMoney(mc) : false });
      },
    },
    {
      name: "compare_periods",
      description: "Compare two time windows on a metric, and break the difference down by a dimension to show which groups drove the change. Use for 'why did X fall', 'compare this quarter with last', contribution-to-change questions.",
      input_schema: {
        type: "object", properties: {
          metric: { type: "string" },
          period_a: { type: "string", description: "period key, e.g. 2026-05 or 2026-Q1 or 2026" },
          period_b: { type: "string", description: "the period to compare against" },
          grain: { type: "string", enum: ["day", "week", "month", "quarter", "year"] },
          breakdown_dimension: { type: "string" },
        }, required: ["metric"],
      },
      run: async ({ metric, period_a, period_b, grain, breakdown_dimension }) => {
        if (!profile.primaryDate) return "No date column, so periods cannot be compared.";
        let err = need(metric, ["numeric"]); if (err) return err;
        const g = grain || pickGrain(profile.primaryDate.spanDays);
        const ts = timeSeries(rows, profile.primaryDate.name, metric, g);
        if (ts.length < 2) return "Not enough periods to compare.";
        const A = period_a || ts[ts.length - 1].period, B = period_b || ts[ts.length - 2].period;
        const key = GRAINS[g];
        const inP = pp => (r => { const d = dateOf(r, profile.primaryDate.name); return d && key(d) === pp; });
        const sumOf = pp => rows.filter(inP(pp)).reduce((a, r) => a + (num(r, metric) || 0), 0);
        const va = sumOf(A), vb = sumOf(B);
        const res = { metric, grain: g, periodA: A, valueA: +va.toFixed(2), periodB: B, valueB: +vb.toFixed(2), absoluteChange: +(va - vb).toFixed(2), percentChange: pct(va, vb) === null ? null : +pct(va, vb).toFixed(2) };
        const mc = colOf(metric);
        let viz = { type: "bar", title: `${metric}: ${B} vs ${A}`, items: [{ key: B, value: vb }, { key: A, value: va }], money: isMoney(mc) };
        const dim = breakdown_dimension || (profile.dimensions[0] && profile.dimensions[0].name);
        if (dim && !need(dim)) {
          const ga = groupBy(rows.filter(inP(A)), dim, metric, "sum");
          const gb = new Map(groupBy(rows.filter(inP(B)), dim, metric, "sum").map(x => [x.key, x.value]));
          const contrib = ga.map(x => ({ key: x.key, a: +x.value.toFixed(2), b: +(gb.get(x.key) || 0).toFixed(2), delta: +(x.value - (gb.get(x.key) || 0)).toFixed(2) }));
          for (const [k, v] of gb) if (!contrib.find(c => c.key === k)) contrib.push({ key: k, a: 0, b: +v.toFixed(2), delta: -v });
          contrib.sort((x, y) => x.delta - y.delta);
          res.breakdown = { dimension: dim, contributors: contrib.slice(0, 12) };
          viz = { type: "bar", title: `Change in ${metric} by ${dim} (${B} → ${A})`, items: contrib.map(c => ({ key: c.key, value: c.delta })), money: isMoney(mc), diverging: true };
        }
        res.summary = `${metric} ${B} ${fmtCol(vb, mc)} → ${A} ${fmtCol(va, mc)} (${res.percentChange > 0 ? "+" : ""}${res.percentChange}%)`;
        return record("compare_periods", { metric, A, B, dim }, res, viz);
      },
    },
    {
      name: "filter_aggregate",
      description: "Aggregate a metric over rows matching up to three equality/range filters. Use for specific slice questions ('revenue for Enterprise in EMEA', 'average order value where discount > 0.2').",
      input_schema: {
        type: "object", properties: {
          metric: { type: "string" }, agg: { type: "string", enum: ["sum", "avg", "count", "median", "min", "max"] },
          filters: {
            type: "array", description: "list of {column, op, value}; op one of eq, neq, gt, gte, lt, lte, contains",
            items: { type: "object", properties: { column: { type: "string" }, op: { type: "string" }, value: { type: "string" } }, required: ["column", "op", "value"] },
          },
        }, required: ["metric"],
      },
      run: async ({ metric, agg = "sum", filters = [] }) => {
        let err = metric === "*" ? null : need(metric); if (err) return err;
        for (const f of filters) { const e = need(f.column); if (e) return e; }
        const test = r => filters.every(f => {
          const raw = r[f.column], n1 = toNum(raw), n2 = toNum(f.value);
          switch (f.op) {
            case "eq": return String(raw).toLowerCase() === String(f.value).toLowerCase();
            case "neq": return String(raw).toLowerCase() !== String(f.value).toLowerCase();
            case "contains": return String(raw).toLowerCase().includes(String(f.value).toLowerCase());
            case "gt": return n1 !== null && n2 !== null && n1 > n2;
            case "gte": return n1 !== null && n2 !== null && n1 >= n2;
            case "lt": return n1 !== null && n2 !== null && n1 < n2;
            case "lte": return n1 !== null && n2 !== null && n1 <= n2;
            default: return true;
          }
        });
        const sub = rows.filter(test);
        if (!sub.length) return JSON.stringify({ matchedRows: 0, note: "No rows match these filters. Check the filter values against the dimension's example values in dataset_profile." });
        const vals = metric === "*" ? [] : sub.map(r => num(r, metric)).filter(v => v !== null);
        const st = vals.length ? numStats(vals) : null;
        const mc = metric === "*" ? null : colOf(metric);
        const value = !st ? sub.length : agg === "avg" ? st.mean : agg === "count" ? st.count : agg === "median" ? st.median : agg === "min" ? st.min : agg === "max" ? st.max : st.sum;
        return record("filter_aggregate", { metric, agg, filters }, {
          matchedRows: sub.length, pctOfDataset: +((sub.length / rows.length) * 100).toFixed(2),
          metric, agg, value: +value.toFixed(2),
          alsoAvailable: st ? { sum: +st.sum.toFixed(2), mean: +st.mean.toFixed(2), median: +st.median.toFixed(2), min: +st.min.toFixed(2), max: +st.max.toFixed(2), n: st.count } : null,
          summary: `${agg}(${metric}) over ${sub.length.toLocaleString()} matching rows = ${fmtCol(value, mc)}`,
        });
      },
    },
    {
      name: "correlation_analysis",
      description: "Pearson correlations between numeric columns. Optionally restrict to two named columns. Returns r and n. Never state causation from this.",
      input_schema: { type: "object", properties: { column_a: { type: "string" }, column_b: { type: "string" } } },
      run: async ({ column_a, column_b }) => {
        if (column_a && column_b) {
          for (const c of [column_a, column_b]) { const e = need(c, ["numeric"]); if (e) return e; }
          const xs = [], ys = [];
          for (const r of rows) { const a = num(r, column_a), b = num(r, column_b); if (a === null || b === null) continue; xs.push(a); ys.push(b); }
          const r = pearson(xs, ys);
          return record("correlation_analysis", { column_a, column_b }, { pair: [column_a, column_b], r: r === null ? null : +r.toFixed(4), n: xs.length, r2: r === null ? null : +(r * r).toFixed(4), caveat: "Correlation does not imply causation." },
            { type: "scatter", title: `${column_a} vs ${column_b}`, x: column_a, y: column_b, r });
        }
        const { pairs } = correlations(rows, profile.metrics.slice(0, 10), 0);
        return record("correlation_analysis", {}, {
          pairs: pairs.slice(0, 15).map(p2 => ({ a: p2.a, b: p2.b, r: +p2.r.toFixed(4), n: p2.n })),
          caveat: "Correlation does not imply causation.",
          summary: pairs.length ? `strongest: ${pairs[0].a} ↔ ${pairs[0].b} r=${pairs[0].r.toFixed(2)}` : "no pairs",
        });
      },
    },
    {
      name: "outlier_detection",
      description: "Find rows where a numeric column falls outside 1.5×IQR fences or beyond a z-score threshold. Returns the fences, counts and up to 10 example rows.",
      input_schema: { type: "object", properties: { column: { type: "string" }, method: { type: "string", enum: ["iqr", "zscore"] } }, required: ["column"] },
      run: async ({ column, method = "iqr" }) => {
        const err = need(column, ["numeric"]); if (err) return err;
        const c = colOf(column), s = c.stats;
        const flag = method === "zscore" ? (v => Math.abs((v - s.mean) / (s.std || 1)) > 3) : (v => v < s.fenceLow || v > s.fenceHigh);
        const hits = rows.map((r, i) => ({ i, v: num(r, column), r })).filter(x => x.v !== null && flag(x.v));
        const keys = [profile.primaryDate && profile.primaryDate.name, ...profile.dimensions.slice(0, 3).map(d => d.name)].filter(Boolean);
        return record("outlier_detection", { column, method }, {
          column, method, fences: method === "iqr" ? { low: +s.fenceLow.toFixed(2), high: +s.fenceHigh.toFixed(2), q1: +s.q1.toFixed(2), q3: +s.q3.toFixed(2) } : { mean: +s.mean.toFixed(2), std: +s.std.toFixed(2), threshold: "|z| > 3" },
          count: hits.length, pctOfRows: +((hits.length / rows.length) * 100).toFixed(2),
          examples: hits.sort((a, b) => Math.abs(b.v - s.median) - Math.abs(a.v - s.median)).slice(0, 10)
            .map(x => ({ value: x.v, ...Object.fromEntries(keys.map(k => [k, x.r[k]])) })),
          note: "Outliers are reported, not removed.",
          summary: `${hits.length.toLocaleString()} outliers in ${column} (${method})`,
        }, c.histogram ? { type: "histogram", title: `Distribution of ${column}`, bins: c.histogram, col: column, money: isMoney(c) } : null);
      },
    },
    {
      name: "forecast_metric",
      description: "Forecast a metric forward using a linear trend with a seasonal index where history allows. Returns point estimates with intervals, the model used, assumptions and limitations. Refuses when history is too short.",
      input_schema: { type: "object", properties: { metric: { type: "string" }, horizon: { type: "number" }, grain: { type: "string", enum: ["day", "week", "month", "quarter", "year"] } }, required: ["metric"] },
      run: async ({ metric, horizon = 3, grain }) => {
        if (!profile.primaryDate) return "No date column, so no time-based forecast is possible.";
        const err = need(metric, ["numeric"]); if (err) return err;
        const g = grain || pickGrain(profile.primaryDate.spanDays);
        const ts = timeSeries(rows, profile.primaryDate.name, metric, g);
        const hist = completePeriods(ts).series;
        const f = forecast(hist, g, Math.min(12, Math.max(1, horizon)));
        const mc = colOf(metric);
        if (!f.ok) return record("forecast_metric", { metric, g }, { ok: false, reason: f.reason, periodsAvailable: hist.length });
        return record("forecast_metric", { metric, grain: g, horizon }, {
          ok: true, metric, grain: g, model: f.model, trendR2: +f.r2.toFixed(3), confidence: f.confidence,
          historyPeriods: hist.length, lastActual: { period: hist[hist.length - 1].period, value: +hist[hist.length - 1].value.toFixed(2) },
          forecast: f.points.map(pt => ({ period: pt.period, estimate: +pt.value.toFixed(2), low: +pt.lo.toFixed(2), high: +pt.hi.toFixed(2) })),
          assumptions: f.assumptions, limitations: f.limitations, intervalNote: f.intervalNote,
          summary: `${metric} forecast ${f.points[0].period}: ${fmtCol(f.points[0].value, mc)}`,
        }, { type: "line", title: `${metric} — actual and forecast`, points: [...hist, ...f.points], col: metric, money: isMoney(mc), forecastFrom: f.points[0].period });
      },
    },
    {
      name: "segmentation",
      description: "Cross-tabulate a metric across two dimensions to find the strongest and weakest combinations. Use for 'which segment', 'where should we invest', two-way comparisons.",
      input_schema: { type: "object", properties: { dimension_a: { type: "string" }, dimension_b: { type: "string" }, metric: { type: "string" }, agg: { type: "string", enum: ["sum", "avg", "count"] } }, required: ["dimension_a", "dimension_b", "metric"] },
      run: async ({ dimension_a, dimension_b, metric, agg = "sum" }) => {
        for (const c of [dimension_a, dimension_b]) { const e = need(c); if (e) return e; }
        const e2 = need(metric, ["numeric"]); if (e2) return e2;
        const m = new Map();
        for (const r of rows) {
          const v = num(r, metric); if (v === null) continue;
          const k = `${r[dimension_a] || "(blank)"}\u0001${r[dimension_b] || "(blank)"}`;
          const e = m.get(k) || { sum: 0, n: 0 }; e.sum += v; e.n++; m.set(k, e);
        }
        const cells = [...m.entries()].map(([k, e]) => { const [a, b] = k.split("\u0001"); return { a, b, value: +(agg === "avg" ? e.sum / e.n : agg === "count" ? e.n : e.sum).toFixed(2), n: e.n }; })
          .sort((x, y) => y.value - x.value);
        const mc = colOf(metric);
        return record("segmentation", { dimension_a, dimension_b, metric, agg }, {
          dimensions: [dimension_a, dimension_b], metric, agg, cells: cells.length,
          strongest: cells.slice(0, 8), weakest: cells.slice(-5).reverse(),
          summary: `${agg}(${metric}) by ${dimension_a}×${dimension_b}: best ${cells[0].a}/${cells[0].b} ${fmtCol(cells[0].value, mc)}`,
        }, { type: "heat", title: `${metric} by ${dimension_a} × ${dimension_b}`, cells, aName: dimension_a, bName: dimension_b, money: isMoney(mc) });
      },
    },
    {
      name: "scenario_model",
      description: "Arithmetic what-if on the current dataset: scale one metric by a percentage and report the effect on it and on any dependent metric supplied. Clearly an arithmetic projection, not a behavioural model.",
      input_schema: { type: "object", properties: { metric: { type: "string" }, change_pct: { type: "number" }, dependent_metric: { type: "string" }, dimension_filter: { type: "string" }, filter_value: { type: "string" } }, required: ["metric", "change_pct"] },
      run: async ({ metric, change_pct, dependent_metric, dimension_filter, filter_value }) => {
        const err = need(metric, ["numeric"]); if (err) return err;
        const sub = dimension_filter && filter_value ? rows.filter(r => String(r[dimension_filter]) === String(filter_value)) : rows;
        const base = sub.reduce((a, r) => a + (num(r, metric) || 0), 0);
        const after = base * (1 + change_pct / 100);
        const out = { metric, scope: dimension_filter ? `${dimension_filter} = ${filter_value}` : "whole dataset", baseline: +base.toFixed(2), changePct: change_pct, projected: +after.toFixed(2), absoluteEffect: +(after - base).toFixed(2), method: "Proportional arithmetic scaling of the observed total.", caveat: "This assumes the change scales linearly and nothing else responds — it is an arithmetic projection, not a demonstrated outcome." };
        if (dependent_metric && !need(dependent_metric, ["numeric"])) {
          const dep = sub.reduce((a, r) => a + (num(r, dependent_metric) || 0), 0);
          const ratio = base ? dep / base : 0;
          out.dependent = { metric: dependent_metric, observedRatioToMetric: +ratio.toFixed(4), baseline: +dep.toFixed(2), projectedIfRatioHolds: +(after * ratio).toFixed(2), caveat: "Holds only if the observed ratio is stable at the new volume, which fixed costs and discounting usually break." };
        }
        const mc = colOf(metric);
        out.summary = `${metric} ${change_pct > 0 ? "+" : ""}${change_pct}%: ${fmtCol(base, mc)} → ${fmtCol(after, mc)}`;
        return record("scenario_model", { metric, change_pct }, out,
          { type: "bar", title: `${metric}: baseline vs ${change_pct > 0 ? "+" : ""}${change_pct}% scenario`, items: [{ key: "Baseline", value: base }, { key: "Scenario", value: after }], money: isMoney(mc) });
      },
    },
    {
      name: "sample_rows",
      description: "Return up to 8 raw rows, optionally matching a filter, so you can see the actual shape of records. Use sparingly — aggregate tools are better for answering questions.",
      input_schema: { type: "object", properties: { column: { type: "string" }, value: { type: "string" }, n: { type: "number" } } },
      run: async ({ column, value, n = 5 }) => {
        let sub = rows;
        if (column && value) { const e = need(column); if (e) return e; sub = rows.filter(r => String(r[column]).toLowerCase().includes(String(value).toLowerCase())); }
        return record("sample_rows", { column, value }, { matched: sub.length, rows: sub.slice(0, Math.min(8, n)) });
      },
    },
  ];
  return T;
}

export function systemPrompt(profile) {
  const cp = compactProfile(profile);
  return `You are a senior business/data analyst working inside an analytics product. A user has uploaded a dataset and you answer questions about it.

DATASET (schema and pre-computed statistics — this is real, derived from the actual file):
${JSON.stringify(cp)}

HARD RULES
1. Never state a number that did not come back from a tool call or from the schema above. If you need a figure, call a tool.
2. Never reference a column that is not in the schema.
3. Never claim you ran an analysis you did not run.
4. Correlation is not causation. When you explain "why", say plainly that you are identifying the largest contributors to a change, which is arithmetic attribution, not proven cause.
5. If the dataset cannot answer the question, say "I can't reliably answer this from the available dataset" and explain precisely which column or field is missing.
6. Label anything forward-looking as a forecast estimate with its confidence and limitations. Never present it as certain.
7. Separate observed facts, calculated metrics, inference, and recommendation. Keep recommendations concrete and tied to the evidence you actually have.
8. Prefer several small tool calls over guessing. Use compare_periods for "why did X change" questions, group_by_analysis for rankings, segmentation for two-dimension questions, scenario_model for what-ifs.

OUTPUT FORMAT
After your tool calls, reply with ONLY a JSON object, no prose outside it, no markdown fences:
{
 "answer": "2-4 sentences answering directly, with the key numbers inline.",
 "findings": [{"label":"short label","value":"the figure","note":"optional one-line context"}],
 "impact": "why this matters for the business, 1-2 sentences. Omit if not meaningful.",
 "recommendation": "one concrete action, or omit.",
 "confidence": "High | Moderate | Low",
 "limitations": ["short caveat", "..."],
 "charts": [1]
}
"charts" lists the 1-based indices of the tool calls whose chart you want shown (they are numbered in the order you called them). Include at most 2, omit if none help. Keep "findings" to at most 6 entries. Write plainly and specifically — no filler, no restating the question.`;
}
