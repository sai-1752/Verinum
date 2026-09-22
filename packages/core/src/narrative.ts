/**
 * Shared prose builders. Anything with a number in it is assembled from a FactSet so the
 * grounding validator can trace it — never a template that hard-codes or embeds a raw value.
 */
import type { FactSet } from "./facts";
import type { ForecastResult } from "./analytics/forecast";
import { seasonLength } from "./time";

export interface ForecastNarrative {
  assumptions: string[];
  limitations: string[];
  intervalNote: string;
}

export function forecastNarrative(f: ForecastResult, fs: FactSet): ForecastNarrative {
  const grain = f.grain;
  const season = seasonLength(grain);
  const seasonal = f.model?.name === "seasonal_linear";
  const assumptions = [
    `Assumes the historical ${grain}ly pattern continues unchanged.`,
    seasonal && season
      ? `Seasonality is estimated from ${fs.num("Full seasonal cycles in history", Math.floor(f.historyPeriods / season), "count").display} full cycles, so seasonal factors are approximate.`
      : "No seasonal component is used (history too short, or a seasonal model did not clearly beat the simpler one in testing).",
    "No external drivers (pricing changes, campaigns, supply shocks) are modelled.",
  ];
  if (f.filledGaps) assumptions.push(`${fs.num("Periods filled with zero", f.filledGaps, "count").display} ${grain}${f.filledGaps > 1 ? "s" : ""} with no rows were treated as zero.`);
  const limitations: string[] = [];
  const mape = f.backtest?.mape ?? null;
  limitations.push(
    mape === null || !f.backtest
      ? "The model could not be backtested, so accuracy is unknown."
      : `Tested on the last ${fs.num("Backtest periods", f.backtest.folds, "count").display} periods, the chosen model's average error was ${fs.num("Backtest error (MAPE)", mape, "percent").display}.`,
  );
  limitations.push(
    f.trendR2 !== null && f.trendR2 < 0.4
      ? `The trend explains little of the variation (R² ${fs.num("Trend R²", f.trendR2, "number", { decimals: 2 }).display}), so treat the level as indicative only.`
      : `Based on ${fs.num("Periods of history", f.historyPeriods, "count").display} periods of history.`,
  );
  limitations.push("This is a forecast estimate, not a guaranteed outcome.");
  return {
    assumptions, limitations,
    intervalNote: "The shaded band is an approximate error range taken from backtest errors and widened with the horizon; it is an approximation, not a guarantee.",
  };
}
