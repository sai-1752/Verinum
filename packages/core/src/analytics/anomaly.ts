import { linreg, mad } from "../stats";
import type { SeriesPoint } from "./periods";

export interface SeriesAnomaly {
  point: SeriesPoint;
  /** robust z-score of the detrended value (MAD based) */
  z: number;
  direction: "spike" | "drop";
  expected: number;
  deviationPct: number | null;
}

/**
 * Detects unusual periods in an evenly-spaced complete series. The value is compared with the
 * linear trend (so growth is not flagged) using median/MAD, which is not distorted by the very
 * anomalies it is looking for. The prototype used a plain 2σ rule, which flags ~5% of any series.
 */
export function detectSeriesAnomalies(points: SeriesPoint[], threshold = 3.2): SeriesAnomaly[] {
  const n = points.length;
  if (n < 8) return [];
  const ys = points.map((p) => p.value);
  const reg = linreg(ys);
  const resid = ys.map((y, i) => y - reg.fit[i]!);
  const { med, mad: m } = mad(resid);
  const scale = m > 0 ? 1.4826 * m : 0;
  if (!scale) return [];
  const out: SeriesAnomaly[] = [];
  resid.forEach((r, i) => {
    const z = (r - med) / scale;
    if (Math.abs(z) >= threshold) {
      const expected = reg.fit[i]! + med;
      out.push({
        point: points[i]!, z, direction: z > 0 ? "spike" : "drop", expected,
        deviationPct: Math.abs(expected) > 1e-12 ? ((ys[i]! - expected) / Math.abs(expected)) * 100 : null,
      });
    }
  });
  return out.sort((a, b) => Math.abs(b.z) - Math.abs(a.z));
}
