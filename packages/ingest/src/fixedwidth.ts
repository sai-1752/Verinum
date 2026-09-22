import type { RawCell } from "@verinum/core";

/**
 * Fixed-width detection: a column boundary is a character position that is a space in every
 * sampled line. Accepts only when ≥2 columns emerge and most lines are long enough to reach them.
 */
export function detectFixedWidth(text: string): { grid: RawCell[][]; columns: number } | null {
  const lines = text.split(/\r?\n/).map((l) => l.replace(/\t/g, "    ").replace(/\s+$/, "")).filter((l) => l.trim() !== "");
  if (lines.length < 3) return null;
  const sample = lines.slice(0, 200);
  const width = Math.max(...sample.map((l) => l.length));
  if (width < 6 || width > 2000) return null;
  const gap: boolean[] = Array.from({ length: width }, (_, i) => sample.every((l) => i >= l.length || l[i] === " "));
  const bounds: [number, number][] = [];
  let i = 0;
  while (i < width) {
    while (i < width && gap[i]) i++;
    if (i >= width) break;
    const s = i;
    while (i < width && !gap[i]) i++;
    bounds.push([s, i]);
  }
  if (bounds.length < 2 || bounds.length > 200) return null;
  // reject prose: real fixed-width files have short, consistent fields and many populated cells
  const cells = lines.slice(0, 200).map((l) => bounds.map(([a, b]) => l.slice(a, b).trim()));
  const filled = cells.flat().filter((c) => c !== "").length / (cells.length * bounds.length);
  const avgLen = cells.flat().reduce((a, c) => a + c.length, 0) / Math.max(1, cells.flat().filter((c) => c !== "").length);
  if (filled < 0.6 || avgLen > 40) return null;
  const grid = lines.map((l) => bounds.map(([a, b], idx) => (idx === bounds.length - 1 ? l.slice(a) : l.slice(a, b)).trim()));
  return { grid, columns: bounds.length };
}
