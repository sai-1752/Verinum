import { useMemo, useState } from "react";
import {
  Area, Bar, BarChart, CartesianGrid, Cell, ComposedChart, Line, LabelList, ReferenceDot, ReferenceLine, ResponsiveContainer,
  Scatter, ScatterChart, Tooltip, XAxis, YAxis,
} from "recharts";
import type {
  BarChart as BarSpec, ChartSpec, FunnelChart, HeatmapChart, HistogramChart, LineChart as LineSpec, ScatterChart as ScatterSpec, TableChart,
} from "@verinum/core";
import { fmtChart, formatNumber, type Unit } from "../../lib/format";

const PALETTE = ["var(--c1)", "var(--c2)", "var(--c3)", "var(--c4)", "var(--c5)", "var(--c6)", "var(--c7)", "var(--c8)"];
const AXIS = { fontSize: 11, fill: "rgb(var(--ink-3))" } as const;
const GRID = "var(--grid)";

const trunc = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function TooltipBox({ title, rows, flag }: { title?: string; rows: { label: string; value: string; color?: string; note?: string }[]; flag?: string }) {
  return (
    <div className="max-w-[16rem] rounded-md border border-line-2 bg-panel px-2.5 py-2 text-xs shadow-lg">
      {title && <p className="mb-1 font-medium text-ink">{title}</p>}
      {rows.map((r, i) => (
        <p key={i} className="flex items-baseline justify-between gap-4 text-ink-2">
          <span className="flex items-center gap-1.5">{r.color && <span className="inline-block h-2 w-2 rounded-sm" style={{ background: r.color }} />}{r.label}</span>
          <span className="num font-medium text-ink">{r.value}</span>
        </p>
      ))}
      {rows.map((r, i) => r.note && <p key={`n${i}`} className="mt-1 text-ink-3">{r.note}</p>)}
      {flag && <p className="mt-1 font-medium text-down">{flag}</p>}
    </div>
  );
}

/* ------------------------------------- bar ------------------------------------- */

function Bars({ spec, height }: { spec: BarSpec; height: number }) {
  const horizontal = spec.horizontal ?? spec.categories.length > 6;
  const data = spec.categories.map((c, i) => ({ name: c, value: spec.values[i]!, note: spec.annotations?.[i], i }));
  const fmt = (v: number) => fmtChart(v, spec.unit, spec.currency);
  const labelW = Math.min(150, Math.max(60, Math.max(...spec.categories.map((c) => c.length)) * 6.4));
  const h = horizontal ? Math.max(height, data.length * 30 + 30) : height;
  const hl = new Set(spec.highlight ?? []);
  const negatives = spec.values.some((v) => v < 0);
  const fill = (i: number, v: number) => (v < 0 ? "var(--c4)" : hl.size && !hl.has(i) ? "var(--c5)" : "var(--c1)");
  return (
    <ResponsiveContainer width="100%" height={h}>
      <BarChart data={data} layout={horizontal ? "vertical" : "horizontal"} margin={{ top: 8, right: horizontal ? 64 : 8, bottom: 4, left: 0 }} barCategoryGap={horizontal ? 6 : "18%"}>
        <CartesianGrid stroke={GRID} horizontal={!horizontal} vertical={horizontal} />
        {horizontal ? (
          <>
            <XAxis type="number" tickFormatter={fmt} tick={AXIS} axisLine={false} tickLine={false} domain={negatives ? ["auto", "auto"] : [0, "auto"]} />
            <YAxis type="category" dataKey="name" width={labelW} tick={AXIS} axisLine={false} tickLine={false} tickFormatter={(s: string) => trunc(s, 22)} interval={0} />
          </>
        ) : (
          <>
            <XAxis dataKey="name" tick={AXIS} axisLine={{ stroke: GRID }} tickLine={false} tickFormatter={(s: string) => trunc(s, 12)} interval={0} height={28} />
            <YAxis tickFormatter={fmt} tick={AXIS} axisLine={false} tickLine={false} width={52} />
          </>
        )}
        {negatives && (horizontal ? <ReferenceLine x={0} stroke="rgb(var(--ink-3))" /> : <ReferenceLine y={0} stroke="rgb(var(--ink-3))" />)}
        <Tooltip cursor={{ fill: "rgb(var(--sunk))", opacity: 0.6 }}
          content={({ active, payload }) => {
            if (!active || !payload?.length) return null;
            const p = payload[0]!.payload as (typeof data)[number];
            return <TooltipBox title={p.name} rows={[{ label: "Value", value: fmt(p.value) }]} />;
          }} />
        <Bar dataKey="value" radius={horizontal ? [0, 3, 3, 0] : [3, 3, 0, 0]} maxBarSize={28} isAnimationActive={false}>
          {data.map((d) => <Cell key={d.i} fill={fill(d.i, d.value)} />)}
          {horizontal && data.length <= 16 && <LabelList dataKey="value" position="right" formatter={(v: number) => fmt(v)} style={{ fontSize: 11, fill: "rgb(var(--ink-2))" }} />}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

/* ------------------------------------- line ------------------------------------- */

function Lines({ spec, height }: { spec: LineSpec; height: number }) {
  const fmt = (v: number) => fmtChart(v, spec.unit, spec.currency);
  const data = useMemo(() => spec.x.map((x, i) => {
    const row: Record<string, unknown> = { x, i };
    spec.series.forEach((s, k) => {
      row[`s${k}`] = s.values[i] ?? null;
      if (s.lo && s.hi && s.lo[i] != null && s.hi[i] != null) row[`b${k}`] = [s.lo[i], s.hi[i]];
    });
    return row;
  }), [spec]);
  const many = spec.x.length > 12;
  return (
    <ResponsiveContainer width="100%" height={height}>
      <ComposedChart data={data} margin={{ top: 10, right: 12, bottom: 4, left: 0 }}>
        <CartesianGrid stroke={GRID} vertical={false} />
        <XAxis dataKey="x" tick={AXIS} axisLine={{ stroke: GRID }} tickLine={false} minTickGap={many ? 28 : 8} height={28} />
        <YAxis tickFormatter={fmt} tick={AXIS} axisLine={false} tickLine={false} width={56} domain={spec.unit === "percent" ? ["auto", "auto"] : ["auto", "auto"]} />
        <Tooltip content={({ active, payload, label }) => {
          if (!active || !payload?.length) return null;
          const p = payload[0]!.payload as Record<string, unknown>;
          const rows = spec.series.flatMap((s, k) => (p[`s${k}`] != null ? [{ label: s.name, value: fmt(p[`s${k}`] as number), color: PALETTE[k % PALETTE.length] }] : []));
          const b = spec.series.flatMap((s, k) => (p[`b${k}`] ? [{ label: "Likely range", value: `${fmt((p[`b${k}`] as number[])[0]!)} – ${fmt((p[`b${k}`] as number[])[1]!)}`, color: PALETTE[k % PALETTE.length] }] : []));
          const m = spec.markers?.find((x) => x.index === p.i);
          return <TooltipBox title={String(label)} rows={[...rows, ...b]} flag={m?.label} />;
        }} />
        {spec.series.map((s, k) => s.lo && s.hi ? <Area key={`b${k}`} dataKey={`b${k}`} stroke="none" fill={PALETTE[k % PALETTE.length]} fillOpacity={0.14} isAnimationActive={false} connectNulls={false} legendType="none" /> : null)}
        {spec.series.map((s, k) => (
          <Line key={k} dataKey={`s${k}`} name={s.name} stroke={PALETTE[k % PALETTE.length]} strokeWidth={2} strokeDasharray={s.style === "forecast" ? "5 4" : undefined}
            dot={spec.x.length <= 24 ? { r: 2.5, strokeWidth: 0, fill: PALETTE[k % PALETTE.length] } : false} activeDot={{ r: 4 }} connectNulls={false} isAnimationActive={false} />
        ))}
        {spec.markers?.map((m) => {
          const k = 0; const y = spec.series[k]?.values[m.index];
          return y != null ? <ReferenceDot key={m.index} x={spec.x[m.index]} y={y} r={6} fill="none" stroke="var(--c4)" strokeWidth={2} ifOverflow="extendDomain" /> : null;
        })}
      </ComposedChart>
    </ResponsiveContainer>
  );
}

/* ---------------------------------- histogram ---------------------------------- */

function Histogram({ spec, height }: { spec: HistogramChart; height: number }) {
  const data = spec.bins.map((b) => ({ name: `${fmtChart(b.x0, spec.unit, spec.currency)} – ${fmtChart(b.x1, spec.unit, spec.currency)}`, x0: b.x0, n: b.n }));
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 8, right: 8, bottom: 4, left: 0 }} barCategoryGap={1}>
        <CartesianGrid stroke={GRID} vertical={false} />
        <XAxis dataKey="x0" tickFormatter={(v: number) => fmtChart(v, spec.unit, spec.currency)} tick={AXIS} axisLine={{ stroke: GRID }} tickLine={false} minTickGap={24} height={28} />
        <YAxis tickFormatter={(v: number) => formatNumber(v)} tick={AXIS} axisLine={false} tickLine={false} width={44} />
        <Tooltip cursor={{ fill: "rgb(var(--sunk))", opacity: 0.6 }} content={({ active, payload }) => {
          if (!active || !payload?.length) return null;
          const p = payload[0]!.payload as (typeof data)[number];
          return <TooltipBox title={p.name} rows={[{ label: "Rows", value: formatNumber(p.n) }]} />;
        }} />
        <Bar dataKey="n" fill="var(--c1)" isAnimationActive={false} radius={[2, 2, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}

/* ----------------------------------- scatter ----------------------------------- */

function Scatterplot({ spec, height }: { spec: ScatterSpec; height: number }) {
  const xs = spec.points.map((p) => p.x);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  const fx = (v: number) => fmtChart(v, spec.xUnit ?? "number", spec.currency);
  const fy = (v: number) => fmtChart(v, spec.unit, spec.currency);
  return (
    <ResponsiveContainer width="100%" height={height}>
      <ScatterChart margin={{ top: 10, right: 12, bottom: 22, left: 0 }}>
        <CartesianGrid stroke={GRID} />
        <XAxis type="number" dataKey="x" name={spec.xLabel} tickFormatter={fx} tick={AXIS} axisLine={{ stroke: GRID }} tickLine={false} domain={["auto", "auto"]} label={{ value: spec.xLabel, position: "insideBottom", offset: -12, style: AXIS }} />
        <YAxis type="number" dataKey="y" name={spec.yLabel} tickFormatter={fy} tick={AXIS} axisLine={false} tickLine={false} width={56} domain={["auto", "auto"]} />
        <Tooltip cursor={{ strokeDasharray: "3 3" }} content={({ active, payload }) => {
          if (!active || !payload?.length) return null;
          const p = payload[0]!.payload as { x: number; y: number };
          return <TooltipBox rows={[{ label: spec.xLabel, value: fx(p.x) }, { label: spec.yLabel, value: fy(p.y) }]} />;
        }} />
        <Scatter data={spec.points} fill="var(--c1)" fillOpacity={0.55} isAnimationActive={false} />
        {spec.fit && Number.isFinite(x0) && x1 > x0 && (
          <ReferenceLine segment={[{ x: x0, y: spec.fit.slope * x0 + spec.fit.intercept }, { x: x1, y: spec.fit.slope * x1 + spec.fit.intercept }]} stroke="var(--c4)" strokeWidth={2} ifOverflow="extendDomain" />
        )}
      </ScatterChart>
    </ResponsiveContainer>
  );
}

/* ----------------------------------- heatmap ----------------------------------- */

function Heatmap({ spec }: { spec: HeatmapChart }) {
  const flat = spec.values.flat().filter((v): v is number => v !== null);
  const lo = Math.min(...flat), hi = Math.max(...flat);
  const fmt = (v: number) => fmtChart(v, spec.unit, spec.currency);
  const alpha = (v: number) => (hi === lo ? 0.25 : 0.06 + 0.5 * ((v - lo) / (hi - lo)));
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-separate border-spacing-0.5 text-xs" aria-label={spec.title}>
        <thead>
          <tr><th className="p-1" />{spec.columns.map((c) => <th key={c} scope="col" className="p-1 text-center font-medium text-ink-3">{trunc(c, 14)}</th>)}</tr>
        </thead>
        <tbody>
          {spec.rows.map((r, ri) => (
            <tr key={r}>
              <th scope="row" className="whitespace-nowrap p-1 pr-2 text-right font-medium text-ink-3">{trunc(r, 18)}</th>
              {spec.columns.map((c, ci) => {
                const v = spec.values[ri]?.[ci] ?? null;
                return (
                  <td key={c} title={v === null ? `${r} · ${c}: no data` : `${r} · ${c}: ${fmt(v)}`} className="num rounded-sm px-1.5 py-2 text-center text-ink"
                    style={{ background: v === null ? "rgb(var(--sunk))" : `rgb(var(--thread) / ${alpha(v).toFixed(2)})` }}>
                    {v === null ? <span className="text-ink-3">—</span> : fmt(v)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ------------------------------------ funnel ------------------------------------ */

function Funnel({ spec }: { spec: FunnelChart }) {
  return (
    <ol className="space-y-1.5">
      {spec.stages.map((s) => (
        <li key={s.label} className="grid grid-cols-[8rem_1fr_auto] items-center gap-3 text-sm">
          <span className="truncate text-ink-2" title={s.label}>{s.label}</span>
          <div className="h-6 rounded-sm bg-sunk"><div className="h-full rounded-sm bg-thread/80" style={{ width: `${Math.max(2, s.pctOfFirst)}%` }} /></div>
          <span className="num w-28 text-right text-ink">{formatNumber(s.value)} <span className="text-ink-3">({s.pctOfFirst.toFixed(0)}%)</span></span>
        </li>
      ))}
    </ol>
  );
}

/* ------------------------------------ table ------------------------------------ */

export function SpecTable({ columns, rows, unit, currency }: { columns: TableChart["columns"]; rows: TableChart["rows"]; unit?: string; currency?: string | null }) {
  void unit;
  return (
    <div className="max-h-80 overflow-auto rounded-md border border-line">
      <table className="w-full">
        <thead className="thead sticky top-0 bg-panel"><tr>{columns.map((c) => <th key={c.key} className={c.align === "right" || c.unit ? "!text-right" : ""}>{c.label}</th>)}</tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="trow">
              {columns.map((c) => {
                const v = r[c.key];
                const right = c.align === "right" || !!c.unit;
                return <td key={c.key} className={`${right ? "num text-right" : ""}`}>{v === null || v === undefined ? "—" : typeof v === "number" ? fmtChart(v, c.unit ?? "number", currency) : String(v)}</td>;
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ---------------------------- legend + data view + wrapper ---------------------------- */

function Legend({ spec }: { spec: LineSpec }) {
  if (spec.series.length < 2) return null;
  return (
    <ul className="mb-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-2">
      {spec.series.map((s, k) => (
        <li key={k} className="flex items-center gap-1.5">
          <svg width="18" height="8" aria-hidden><line x1="0" y1="4" x2="18" y2="4" stroke={PALETTE[k % PALETTE.length]} strokeWidth="2" strokeDasharray={s.style === "forecast" ? "4 3" : undefined} /></svg>
          {s.name}{s.lo && s.hi ? " (shaded: likely range)" : ""}
        </li>
      ))}
    </ul>
  );
}

function dataTable(spec: ChartSpec): { columns: TableChart["columns"]; rows: TableChart["rows"] } | null {
  const u = (spec as { unit: Unit }).unit;
  if (spec.kind === "bar") return { columns: [{ key: "c", label: "Category" }, { key: "v", label: "Value", unit: u }, ...(spec.annotations ? [{ key: "a", label: "Note" }] : [])], rows: spec.categories.map((c, i) => ({ c, v: spec.values[i]!, a: spec.annotations?.[i] ?? null })) };
  if (spec.kind === "line") return { columns: [{ key: "x", label: "Period" }, ...spec.series.flatMap((s, k) => [{ key: `s${k}`, label: s.name, unit: u }, ...(s.lo ? [{ key: `l${k}`, label: `${s.name} low`, unit: u }, { key: `h${k}`, label: `${s.name} high`, unit: u }] : [])])], rows: spec.x.map((x, i) => Object.fromEntries([["x", x], ...spec.series.flatMap((s, k) => [[`s${k}`, s.values[i] ?? null], [`l${k}`, s.lo?.[i] ?? null], [`h${k}`, s.hi?.[i] ?? null]])])) };
  if (spec.kind === "histogram") return { columns: [{ key: "r", label: "Range" }, { key: "n", label: "Rows", unit: "count" }], rows: spec.bins.map((b) => ({ r: `${fmtChart(b.x0, u, spec.currency)} – ${fmtChart(b.x1, u, spec.currency)}`, n: b.n })) };
  return null;
}

export function ChartView({ spec, height = 280, hideHeader, className }: { spec: ChartSpec; height?: number; hideHeader?: boolean; className?: string }) {
  const [showData, setShowData] = useState(false);
  const alt = useMemo(() => dataTable(spec), [spec]);
  const label = `${spec.title}${spec.subtitle ? `. ${spec.subtitle}` : ""}`;
  return (
    <figure className={className}>
      {!hideHeader && (
        <figcaption className="mb-2">
          <p className="font-serif text-[1.05rem] leading-snug text-ink">{spec.title}</p>
          {spec.subtitle && <p className="text-xs text-ink-3">{spec.subtitle}</p>}
        </figcaption>
      )}
      {spec.kind === "line" && <Legend spec={spec} />}
      <div role="img" aria-label={label}>
        {spec.kind === "bar" && <Bars spec={spec} height={height} />}
        {spec.kind === "line" && <Lines spec={spec} height={height} />}
        {spec.kind === "histogram" && <Histogram spec={spec} height={height} />}
        {spec.kind === "scatter" && <Scatterplot spec={spec} height={height} />}
        {spec.kind === "heatmap" && <Heatmap spec={spec} />}
        {spec.kind === "funnel" && <Funnel spec={spec} />}
      </div>
      {spec.kind === "table" && <SpecTable columns={spec.columns} rows={spec.rows} currency={spec.currency} />}
      {spec.note && <p className="mt-1.5 text-xs text-ink-3">{spec.note}</p>}
      {alt && (
        <div className="mt-1">
          <button className="text-xs text-ink-3 underline underline-offset-2 hover:text-ink" onClick={() => setShowData((s) => !s)} aria-expanded={showData}>{showData ? "Hide data" : "Show data"}</button>
          {showData && <div className="mt-2"><SpecTable columns={alt.columns} rows={alt.rows} currency={spec.currency} /></div>}
        </div>
      )}
    </figure>
  );
}
