// SPDX-License-Identifier: Apache-2.0
// ElizaOS model provider for Trellis. Registers TEXT_SMALL, TEXT_LARGE and TEXT_EMBEDDING against the router's
// OpenAI-compatible API, so an agent picks any of the catalogue's models by id. With TRELLIS_LANE=attested every
// call goes only to providers whose enclave the router has verified, and the router refuses (sending nothing,
// charging nothing) when none can answer: an agent never silently falls back to an unattested host.
// Every answer carries a signed receipt id, logged at debug level so an operator can verify a call later.
import { type GenerateTextParams, type IAgentRuntime, type Plugin, type TextEmbeddingParams, logger, ModelType } from "@elizaos/core";

export const TRELLIS_BASE_URL = "https://trellis.example/api/v1";
const DEFAULTS = {
  TRELLIS_SMALL_MODEL: "meta-llama/llama-3.3-70b-instruct",
  TRELLIS_LARGE_MODEL: "deepseek/deepseek-v3.2",
  TRELLIS_EMBEDDING_MODEL: "qwen/qwen3-embedding-8b",
  TRELLIS_EMBEDDING_DIMENSIONS: "4096",
} as const;

function setting(runtime: IAgentRuntime, key: string, fallback?: string): string | undefined {
  const v = runtime.getSetting(key) ?? process.env[key];
  return v === null || v === undefined || v === "" ? fallback : String(v);
}

function config(runtime: IAgentRuntime) {
  const apiKey = setting(runtime, "TRELLIS_API_KEY");
  if (!apiKey) throw new Error("TRELLIS_API_KEY is not set. Create a key at the Trellis dashboard and add it to the agent's settings.");
  const baseURL = (setting(runtime, "TRELLIS_BASE_URL", TRELLIS_BASE_URL) as string).replace(/\/$/, "");
  const lane = setting(runtime, "TRELLIS_LANE", "public");
  const headers: Record<string, string> = { authorization: `Bearer ${apiKey}`, "content-type": "application/json" };
  if (lane && lane !== "public") headers["x-trellis-lane"] = lane;
  return { baseURL, headers };
}

async function post(runtime: IAgentRuntime, path: string, body: Record<string, unknown>): Promise<any> {
  const { baseURL, headers } = config(runtime);
  const res = await fetch(`${baseURL}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Trellis ${path} answered ${res.status}: ${json?.error?.message ?? res.statusText}`);
  if (json?.receipt?.id) logger.debug(`[trellis] ${body.model} receipt ${json.receipt.id} cost $${json?.usage?.cost ?? "?"}`);
  return json;
}

async function chat(runtime: IAgentRuntime, model: string, p: GenerateTextParams): Promise<string> {
  // `user` is deliberately not forwarded: the router needs no end-user identifier to route or bill a call.
  const json = await post(runtime, "/chat/completions", {
    model,
    messages: [{ role: "user", content: p.prompt }],
    ...(p.maxTokens !== undefined ? { max_tokens: p.maxTokens } : {}),
    ...(p.temperature !== undefined ? { temperature: p.temperature } : {}),
    ...(p.topP !== undefined ? { top_p: p.topP } : {}),
    ...(p.frequencyPenalty !== undefined ? { frequency_penalty: p.frequencyPenalty } : {}),
    ...(p.presencePenalty !== undefined ? { presence_penalty: p.presencePenalty } : {}),
    ...(p.stopSequences?.length ? { stop: p.stopSequences } : {}),
    ...(p.responseFormat && typeof p.responseFormat === "object" ? { response_format: p.responseFormat } : {}),
  });
  return json?.choices?.[0]?.message?.content ?? "";
}

export const trellisPlugin: Plugin = {
  name: "trellis",
  description: "Trellis model provider: any catalogue model by id, a signed receipt per call, and an attested-only lane.",
  config: {
    TRELLIS_API_KEY: process.env.TRELLIS_API_KEY ?? null,
    TRELLIS_BASE_URL: process.env.TRELLIS_BASE_URL ?? null,
    TRELLIS_SMALL_MODEL: process.env.TRELLIS_SMALL_MODEL ?? null,
    TRELLIS_LARGE_MODEL: process.env.TRELLIS_LARGE_MODEL ?? null,
    TRELLIS_EMBEDDING_MODEL: process.env.TRELLIS_EMBEDDING_MODEL ?? null,
    TRELLIS_EMBEDDING_DIMENSIONS: process.env.TRELLIS_EMBEDDING_DIMENSIONS ?? null,
    TRELLIS_LANE: process.env.TRELLIS_LANE ?? null,
  },
  async init(_config, runtime) {
    if (!setting(runtime, "TRELLIS_API_KEY")) logger.warn("[trellis] TRELLIS_API_KEY is not set; model calls will fail until it is.");
  },
  models: {
    [ModelType.TEXT_SMALL]: async (runtime, params) => chat(runtime, setting(runtime, "TRELLIS_SMALL_MODEL", DEFAULTS.TRELLIS_SMALL_MODEL) as string, params),
    [ModelType.TEXT_LARGE]: async (runtime, params) => chat(runtime, setting(runtime, "TRELLIS_LARGE_MODEL", DEFAULTS.TRELLIS_LARGE_MODEL) as string, params),
    [ModelType.TEXT_EMBEDDING]: async (runtime, params: TextEmbeddingParams | string | null) => {
      const dims = Number(setting(runtime, "TRELLIS_EMBEDDING_DIMENSIONS", DEFAULTS.TRELLIS_EMBEDDING_DIMENSIONS));
      // ElizaOS calls with null once at startup to learn the vector size; answer without a network call.
      if (params === null) return Array.from({ length: dims }, (_, i) => (i === 0 ? 0.1 : 0));
      const input = typeof params === "string" ? params : params.text;
      const json = await post(runtime, "/embeddings", { model: setting(runtime, "TRELLIS_EMBEDDING_MODEL", DEFAULTS.TRELLIS_EMBEDDING_MODEL), input });
      const v = json?.data?.[0]?.embedding;
      if (!Array.isArray(v)) throw new Error("Trellis /embeddings returned no vector.");
      return v as number[];
    },
  },
};

export default trellisPlugin;
