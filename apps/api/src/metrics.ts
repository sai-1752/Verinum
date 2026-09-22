/** Minimal Prometheus-text metrics (counters, gauges and fixed-bucket histograms). */
type Labels = Record<string, string | number>;
const key = (l: Labels) => Object.entries(l).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}="${String(v).replace(/[\\"\n]/g, "_")}"`).join(",");

export class Metrics {
  private counters = new Map<string, { help: string; values: Map<string, number> }>();
  private gauges = new Map<string, { help: string; fn: () => number }>();
  private hists = new Map<string, { help: string; buckets: number[]; values: Map<string, { counts: number[]; sum: number; n: number }> }>();

  inc(name: string, labels: Labels = {}, by = 1, help = name) {
    const c = this.counters.get(name) ?? { help, values: new Map() };
    this.counters.set(name, c);
    const k = key(labels);
    c.values.set(k, (c.values.get(k) ?? 0) + by);
  }
  gauge(name: string, fn: () => number, help = name) { this.gauges.set(name, { help, fn }); }
  observe(name: string, seconds: number, labels: Labels = {}, help = name, buckets = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60]) {
    const h = this.hists.get(name) ?? { help, buckets, values: new Map() };
    this.hists.set(name, h);
    const k = key(labels);
    const v = h.values.get(k) ?? { counts: new Array(h.buckets.length).fill(0), sum: 0, n: 0 };
    h.values.set(k, v);
    h.buckets.forEach((b, i) => { if (seconds <= b) v.counts[i]++; });
    v.sum += seconds; v.n++;
  }
  render(): string {
    const out: string[] = [];
    for (const [n, c] of this.counters) {
      out.push(`# HELP ${n} ${c.help}`, `# TYPE ${n} counter`);
      for (const [k, v] of c.values) out.push(`${n}${k ? `{${k}}` : ""} ${v}`);
    }
    for (const [n, g] of this.gauges) out.push(`# HELP ${n} ${g.help}`, `# TYPE ${n} gauge`, `${n} ${g.fn()}`);
    for (const [n, h] of this.hists) {
      out.push(`# HELP ${n} ${h.help}`, `# TYPE ${n} histogram`);
      for (const [k, v] of h.values) {
        const l = k ? `${k},` : "";
        h.buckets.forEach((b, i) => out.push(`${n}_bucket{${l}le="${b}"} ${v.counts[i]}`));
        out.push(`${n}_bucket{${l}le="+Inf"} ${v.n}`, `${n}_sum${k ? `{${k}}` : ""} ${v.sum}`, `${n}_count${k ? `{${k}}` : ""} ${v.n}`);
      }
    }
    return `${out.join("\n")}\n`;
  }
}
