import { ANALYSIS_TOOLS } from "./analysis";
import { BASIC_TOOLS } from "./basic";
import { TEMPORAL_TOOLS } from "./temporal";
import { ToolRegistry, DEFAULT_POLICY, type InternalErrorHook, type ToolPolicy } from "./registry";

export * from "./registry";
export * from "./schema";
export { normalizePeriodKey, resolveColumn } from "./helpers";
export { pickMetric } from "./basic";

export const ALL_TOOLS = [...BASIC_TOOLS, ...TEMPORAL_TOOLS, ...ANALYSIS_TOOLS];

export function createToolRegistry(policy: Partial<ToolPolicy> = {}, onInternalError?: InternalErrorHook): ToolRegistry {
  return new ToolRegistry(ALL_TOOLS, { ...DEFAULT_POLICY, ...policy }, onInternalError);
}
