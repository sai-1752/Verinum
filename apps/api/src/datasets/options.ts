import { z } from "zod";

/** User-controlled processing choices. Changing any of them creates a new dataset version. */
export const ProcessOptions = z.object({
  /** which extracted table to analyse (spreadsheets with several sheets, PDFs/HTML with several tables) */
  tableIndex: z.number().int().min(0).max(500).optional(),
  removeDuplicates: z.boolean().default(false),
  normalizeLabels: z.boolean().default(false),
  /** confirmed day/month order for ambiguous date columns */
  dateOrders: z.record(z.enum(["dmy", "mdy"])).default({}),
  excludeColumns: z.array(z.string().max(200)).max(500).default([]),
}).strict();

export type ProcessOptions = z.infer<typeof ProcessOptions>;
export const defaultOptions = (): ProcessOptions => ProcessOptions.parse({});
