/**
 * A deliberately small JSON-Schema subset validator (types, enum, bounds, items, required).
 * Tool arguments come from an LLM, so they are validated and coerced before any computation.
 */
export type JsonSchema = {
  type?: "string" | "number" | "integer" | "boolean" | "array" | "object";
  description?: string;
  enum?: readonly (string | number)[];
  minimum?: number;
  maximum?: number;
  maxLength?: number;
  items?: JsonSchema;
  maxItems?: number;
  properties?: Record<string, JsonSchema>;
  required?: readonly string[];
  default?: unknown;
};

export interface SchemaResult { ok: boolean; value?: Record<string, unknown>; error?: string }

function coerce(v: unknown, s: JsonSchema, path: string): { v?: unknown; error?: string } {
  if (v === null || v === undefined) return { v: undefined };
  switch (s.type) {
    case "string": {
      if (typeof v === "number" || typeof v === "boolean") v = String(v);
      if (typeof v !== "string") return { error: `${path} must be a string` };
      if (s.maxLength && v.length > s.maxLength) return { error: `${path} is too long` };
      if (s.enum && !s.enum.includes(v)) {
        const hit = s.enum.find((e) => String(e).toLowerCase() === (v as string).toLowerCase());
        if (hit === undefined) return { error: `${path} must be one of: ${s.enum.join(", ")}` };
        return { v: hit };
      }
      return { v };
    }
    case "number":
    case "integer": {
      if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) v = Number(v);
      if (typeof v !== "number" || !Number.isFinite(v)) return { error: `${path} must be a number` };
      if (s.type === "integer" && !Number.isInteger(v)) v = Math.round(v);
      if (s.minimum !== undefined && (v as number) < s.minimum) return { error: `${path} must be at least ${s.minimum}` };
      if (s.maximum !== undefined && (v as number) > s.maximum) return { error: `${path} must be at most ${s.maximum}` };
      return { v };
    }
    case "boolean": {
      if (v === "true") v = true; else if (v === "false") v = false;
      if (typeof v !== "boolean") return { error: `${path} must be true or false` };
      return { v };
    }
    case "array": {
      if (!Array.isArray(v)) v = [v];
      const arr = v as unknown[];
      if (s.maxItems && arr.length > s.maxItems) return { error: `${path} has too many items (max ${s.maxItems})` };
      const out: unknown[] = [];
      for (let i = 0; i < arr.length; i++) {
        const r = s.items ? coerce(arr[i], s.items, `${path}[${i}]`) : { v: arr[i] };
        if (r.error) return r;
        out.push(r.v);
      }
      return { v: out };
    }
    case "object": {
      if (typeof v !== "object" || Array.isArray(v)) return { error: `${path} must be an object` };
      const r = validate(v as Record<string, unknown>, s, path);
      return r.ok ? { v: r.value } : { error: r.error };
    }
    default:
      return { v };
  }
}

export function validate(input: unknown, schema: JsonSchema, path = "arguments"): SchemaResult {
  const obj = input === null || input === undefined ? {} : input;
  if (typeof obj !== "object" || Array.isArray(obj)) return { ok: false, error: `${path} must be an object` };
  const src = obj as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, s] of Object.entries(schema.properties ?? {})) {
    const raw = src[k];
    if (raw === undefined || raw === null || raw === "") {
      if (schema.required?.includes(k)) return { ok: false, error: `${path}.${k} is required` };
      if (s.default !== undefined) out[k] = s.default;
      continue;
    }
    const r = coerce(raw, s, `${path}.${k}`);
    if (r.error) return { ok: false, error: r.error };
    if (r.v !== undefined) out[k] = r.v;
  }
  return { ok: true, value: out };
}
