/**
 * Concentration of a total across groups. Ported guard (safeguard 6): an evenly split total
 * must never be called "concentrated", and "top 3 of 3 hold 100%" is not a finding.
 */
export interface Concentration {
  /** number of groups */
  k: number;
  topN: number;
  /** % of the total held by the top N groups */
  topShare: number;
  hhi: number;
  /** Herfindahl normalised to 0 (perfectly even) … 1 (one group holds everything) */
  normalized: number;
  /** % the top N would hold under an even split */
  baseline: number;
  /** topShare ÷ baseline */
  multiple: number;
}

/** `values` must be sorted descending. */
export function concentration(values: number[], topNWanted = 3): Concentration | null {
  const k = values.length;
  if (k < 2) return null;
  const pos = values.map((v) => Math.max(0, v));
  const total = pos.reduce((a, b) => a + b, 0);
  if (!total) return null;
  const hhi = pos.reduce((a, b) => a + (b / total) ** 2, 0);
  const even = 1 / k;
  const topN = Math.min(topNWanted, k - 1);
  const topShare = (pos.slice(0, topN).reduce((a, b) => a + b, 0) / total) * 100;
  const baseline = (topN / k) * 100;
  return { k, topN, topShare, hhi, normalized: (hhi - even) / (1 - even), baseline, multiple: topShare / baseline };
}

/** The three-part gate from the prototype: enough groups, well above baseline, and uneven by HHI. */
export function isMeaningfullyConcentrated(c: Concentration | null): c is Concentration {
  return !!c && c.k >= 5 && c.multiple >= 1.4 && c.normalized >= 0.15;
}

/** How many of the largest groups it takes to reach `target`% of the total. */
export function groupsToReach(values: number[], target = 80): number {
  const pos = values.map((v) => Math.max(0, v));
  const total = pos.reduce((a, b) => a + b, 0);
  if (!total) return 0;
  let acc = 0;
  for (let i = 0; i < pos.length; i++) { acc += pos[i]!; if ((acc / total) * 100 >= target) return i + 1; }
  return pos.length;
}
