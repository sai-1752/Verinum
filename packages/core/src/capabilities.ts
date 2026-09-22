/**
 * Capability gating. What the platform may compute — and therefore what the AI may be offered —
 * is decided from the profile. Each unavailable capability carries a user-facing reason (spec §12,
 * §30): "Forecasting isn't available because …" is shown in the UI and fed to the model so it can
 * decline honestly instead of improvising.
 */
import type { BusinessMeaning, Capabilities, ColumnProfile, DatasetProfile } from "./types";

const MIN_COMPLETE_FOR_SERIES = 4;
export const MIN_COMPLETE_FOR_FORECAST = 6;

/** Minimum complete periods for a seasonality claim, per grain (two full cycles, min). */
export const SEASONALITY_MIN_PERIODS: Record<string, number> = { day: 56, week: 104, month: 24, quarter: 8 };

function pickMeaning(cols: ColumnProfile[], meaning: BusinessMeaning, o: { numeric?: boolean; additive?: boolean } = {}): ColumnProfile | null {
  const pool = cols.filter((c) =>
    c.meaning === meaning && c.count > 0 && c.analyzable
    && (!o.numeric || c.type === "numeric")
    && (!o.additive || c.additive === true));
  if (!pool.length) return null;
  return [...pool].sort((a, b) => b.meaningConfidence - a.meaningConfidence || a.index - b.index)[0]!;
}

function pickEntity(cols: ColumnProfile[], meaning: BusinessMeaning, preferBounded: boolean): ColumnProfile | null {
  const pool = cols.filter((c) => c.meaning === meaning && c.groupable && c.role !== "text" && c.count > 0);
  if (!pool.length) return null;
  return [...pool].sort((a, b) => {
    if (preferBounded && a.chartDimension !== b.chartDimension) return a.chartDimension ? -1 : 1;
    return b.meaningConfidence - a.meaningConfidence || a.index - b.index;
  })[0]!;
}

export function pickLeadMetric(cols: ColumnProfile[]): ColumnProfile | null {
  const measures = cols.filter((c) => c.type === "numeric" && c.role === "measure" && c.analyzable && c.count > 0);
  const additive = measures.filter((c) => c.additive === true);
  const byConf = (a: ColumnProfile, b: ColumnProfile) => b.meaningConfidence - a.meaningConfidence || a.index - b.index;
  const revenue = additive.filter((c) => c.meaning === "revenue").sort(byConf)[0];
  if (revenue) return revenue;
  const unknown = additive.filter((c) => !c.meaning).sort((a, b) => (b.stats?.sum ?? 0) - (a.stats?.sum ?? 0) || a.index - b.index)[0];
  if (unknown) return unknown;
  for (const m of ["profit", "quantity", "marketing", "cost"] as const) {
    const hit = additive.filter((c) => c.meaning === m).sort(byConf)[0];
    if (hit) return hit;
  }
  return additive.sort((a, b) => a.index - b.index)[0] ?? measures.sort((a, b) => a.index - b.index)[0] ?? null;
}

export function buildCapabilities(p: DatasetProfile): Capabilities {
  const cols = p.columns;
  const unavailable: Record<string, string> = {};

  const measures = cols.filter((c) => c.type === "numeric" && c.role === "measure" && c.analyzable && c.count > 0);
  const additiveMeasures = measures.filter((c) => c.additive === true);
  const lead = pickLeadMetric(cols);
  const dimensions = cols.filter((c) => c.chartDimension && (c.role === "dimension" || c.role === "boolean")).map((c) => c.name);
  const groupable = cols.filter((c) => c.groupable && c.role !== "text").map((c) => c.name);

  const cal = p.calendar;
  const eventDate = p.primaryDate;
  const complete = cal?.completePeriods ?? 0;
  const timeSeries = !!eventDate && !!cal && complete >= MIN_COMPLETE_FOR_SERIES;
  const forecast = timeSeries && complete >= MIN_COMPLETE_FOR_FORECAST;
  const seasonMin = cal ? SEASONALITY_MIN_PERIODS[cal.grain] : undefined;
  const seasonality = timeSeries && !!seasonMin && complete >= seasonMin;

  const revenue = pickMeaning(cols, "revenue", { numeric: true, additive: true });
  const profit = pickMeaning(cols, "profit", { numeric: true, additive: true });
  const cost = pickMeaning(cols, "cost", { numeric: true, additive: true });
  const marketing = pickMeaning(cols, "marketing", { numeric: true, additive: true });
  const discount = pickMeaning(cols, "discount", { numeric: true });
  const quantity = pickMeaning(cols, "quantity", { numeric: true, additive: true });
  const price = pickMeaning(cols, "price", { numeric: true });
  const customer = pickEntity(cols, "customer", false);
  const product = pickEntity(cols, "product", false);
  const region = pickEntity(cols, "region", true);
  const channel = pickEntity(cols, "channel", true);
  const segment = pickEntity(cols, "segment", true);
  const stage = pickEntity(cols, "stage", true);

  const margin = !!revenue && !!profit && revenue.name !== profit.name;
  const cohort = !!customer && timeSeries && complete >= 3;
  const correlation = measures.length >= 2;
  const outliers = measures.length >= 1;

  if (p.rowCount === 0) unavailable.all = "The dataset has no rows.";
  if (!measures.length) unavailable.measures = "No numeric measure was found, so totals, averages and rankings by value aren't available; counts still are.";
  if (!eventDate) {
    const why = "the dataset doesn't contain a suitable date or time field";
    unavailable.timeSeries = `Trends over time aren't available because ${why}.`;
    unavailable.forecast = `Forecasting isn't available because ${why}.`;
    unavailable.seasonality = `Seasonality isn't available because ${why}.`;
  } else if (!timeSeries) {
    const why = `only ${complete} complete ${cal?.grain ?? "period"}${complete === 1 ? "" : "s"} of "${eventDate}" are available (at least ${MIN_COMPLETE_FOR_SERIES} are needed)`;
    unavailable.timeSeries = `Trends over time aren't available because ${why}.`;
    unavailable.forecast = `Forecasting isn't available because ${why}.`;
    unavailable.seasonality = `Seasonality isn't available because ${why}.`;
  } else {
    if (!forecast) unavailable.forecast = `Forecasting isn't available because only ${complete} complete ${cal!.grain}s of history exist; at least ${MIN_COMPLETE_FOR_FORECAST} are needed.`;
    if (!seasonality) unavailable.seasonality = seasonMin
      ? `Seasonality isn't available because ${complete} complete ${cal!.grain}s are too few to tell seasonal patterns from noise; at least ${seasonMin} (two full cycles) are needed.`
      : `Seasonality isn't defined at ${cal!.grain} granularity.`;
  }
  if (!margin) unavailable.margin = !revenue
    ? "Margin analysis isn't available because no revenue column was identified."
    : "Margin analysis isn't available because no profit amount column was identified (a margin percentage column can be averaged but not derived from).";
  if (!customer) unavailable.customers = "Customer analysis isn't available because no customer column was identified.";
  if (!cohort) unavailable.cohort = !customer
    ? "Cohort analysis isn't available because no customer column was identified."
    : "Cohort analysis isn't available because there isn't enough dated history (at least 3 complete periods).";
  if (!stage) unavailable.funnel = "Funnel analysis isn't available because no stage or status column was identified.";
  if (!correlation) unavailable.correlation = "Correlation analysis needs at least two numeric measures.";
  if (!outliers) unavailable.outliers = "Outlier detection needs at least one numeric measure.";

  return {
    hasData: p.rowCount > 0,
    measures: measures.map((c) => c.name),
    additiveMeasures: additiveMeasures.map((c) => c.name),
    leadMetric: lead?.name ?? null,
    dimensions, groupable,
    eventDate, grain: cal?.grain ?? null,
    timeSeries, seasonality, forecast,
    revenue: revenue?.name ?? null, profit: profit?.name ?? null, cost: cost?.name ?? null,
    marketing: marketing?.name ?? null, discount: discount?.name ?? null,
    quantity: quantity?.name ?? null, price: price?.name ?? null,
    margin,
    customer: customer?.name ?? null, product: product?.name ?? null, region: region?.name ?? null,
    channel: channel?.name ?? null, segment: segment?.name ?? null, stage: stage?.name ?? null,
    cohort, correlation, outliers, unavailable,
  };
}
