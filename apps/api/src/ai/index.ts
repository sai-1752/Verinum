import type { LlmProvider } from "@verinum/core";
import type { Config } from "../config";
import { AnthropicProvider } from "./anthropic";
import { OpenAiProvider } from "./openai";

export function createProvider(cfg: Config, fetchFn: typeof fetch = fetch): LlmProvider | null {
  const http = { fetch: fetchFn, timeoutMs: cfg.AI_TIMEOUT_MS };
  if (cfg.AI_PROVIDER === "anthropic" && cfg.ANTHROPIC_API_KEY) return new AnthropicProvider({ ...http, apiKey: cfg.ANTHROPIC_API_KEY, model: cfg.ANTHROPIC_MODEL, baseUrl: cfg.ANTHROPIC_BASE_URL });
  if (cfg.AI_PROVIDER === "openai" && cfg.OPENAI_API_KEY) return new OpenAiProvider({ ...http, apiKey: cfg.OPENAI_API_KEY, model: cfg.OPENAI_MODEL, baseUrl: cfg.OPENAI_BASE_URL });
  return null;
}

export { AnthropicProvider, OpenAiProvider };
export { ProviderError } from "./types";
