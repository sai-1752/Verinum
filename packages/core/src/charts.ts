/** Renderer-agnostic chart descriptions. The web app draws them; nothing here depends on a chart library. */
import type { Unit } from "./format";

interface Base { title: string; subtitle?: string; unit: Unit; currency?: string | null; note?: string }

export interface BarChart extends Base {
  kind: "bar";
  categories: string[];
  values: number[];
  /** secondary label per bar, e.g. "31.2% margin" */
  annotations?: string[];
  horizontal?: boolean;
  /** indices to emphasise */
  highlight?: number[];
}

export interface LineSeries {
  name: string;
  values: (number | null)[];
  style?: "actual" | "forecast";
  lo?: (number | null)[];
  hi?: (number | null)[];
}
export interface LineChart extends Base {
  kind: "line";
  x: string[];
  series: LineSeries[];
  /** x indices to flag (anomalies) */
  markers?: { index: number; label: string }[];
}

export interface ScatterChart extends Base {
  kind: "scatter";
  xLabel: string;
  yLabel: string;
  xUnit?: Unit;
  points: { x: number; y: number }[];
  fit?: { slope: number; intercept: number };
}

export interface HistogramChart extends Base {
  kind: "histogram";
  bins: { x0: number; x1: number; n: number }[];
}

export interface HeatmapChart extends Base {
  kind: "heatmap";
  rows: string[];
  columns: string[];
  /** rows × columns, null = not observable */
  values: (number | null)[][];
}

export interface FunnelChart extends Base {
  kind: "funnel";
  stages: { label: string; value: number; pctOfFirst: number; pctOfPrevious: number | null }[];
}

export interface TableChart extends Base {
  kind: "table";
  columns: { key: string; label: string; unit?: Unit; align?: "left" | "right" }[];
  rows: Record<string, string | number | null>[];
}

export type ChartSpec = BarChart | LineChart | ScatterChart | HistogramChart | HeatmapChart | FunnelChart | TableChart;
