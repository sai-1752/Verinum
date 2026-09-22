export type AnalyticsErrorCode =
  | "unknown_column" | "wrong_type" | "no_date_column" | "insufficient_data" | "invalid_argument"
  | "not_available" | "no_matching_rows" | "too_many_groups";

/** Errors that are safe to show to users and to feed back to the LLM (no internals). */
export class AnalyticsError extends Error {
  readonly code: AnalyticsErrorCode;
  readonly hint?: string;
  constructor(code: AnalyticsErrorCode, message: string, hint?: string) {
    super(message);
    this.name = "AnalyticsError";
    this.code = code;
    this.hint = hint;
  }
}
