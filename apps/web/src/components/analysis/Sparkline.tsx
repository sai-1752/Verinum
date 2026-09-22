export function Sparkline({ values, labels, width = 96, height = 28, label }: { values: number[]; labels?: string[]; width?: number; height?: number; label?: string }) {
  if (values.length < 2) return null;
  const lo = Math.min(...values), hi = Math.max(...values);
  const span = hi - lo || 1;
  const pad = 2;
  const pts = values.map((v, i) => [pad + (i / (values.length - 1)) * (width - pad * 2), pad + (1 - (v - lo) / span) * (height - pad * 2)] as const);
  const d = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
  const last = pts[pts.length - 1]!;
  const desc = label ?? `Trend across ${values.length} periods${labels ? `, ${labels[0]} to ${labels[labels.length - 1]}` : ""}`;
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={desc} className="overflow-visible">
      <path d={d} fill="none" stroke="var(--c1)" strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={last[0]} cy={last[1]} r="2.4" fill="var(--c1)" />
    </svg>
  );
}
