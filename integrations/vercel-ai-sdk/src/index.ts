// SPDX-License-Identifier: Apache-2.0
// Trellis provider for the Vercel AI SDK. Trellis speaks the OpenAI chat, completion and embeddings API, so this
// is the SDK's own OpenAI-compatible provider with Trellis's defaults: the router URL, the key read from
// TRELLIS_API_KEY when a request is made (not at import), the attested lane as an option, and the signed
// receipt of every call surfaced as provider metadata.
import { createOpenAICompatible, type MetadataExtractor, type OpenAICompatibleProvider } from "@ai-sdk/openai-compatible";
import { type FetchFunction, loadApiKey, loadOptionalSetting, withoutTrailingSlash } from "@ai-sdk/provider-utils";

/** The public Trellis router. Point `baseURL` elsewhere to use a self-hosted router. */
export const TRELLIS_BASE_URL = "https://trellis.example/api/v1";

/** Any id from GET /api/v1/models, e.g. "meta-llama/llama-3.3-70b-instruct" or "z-ai/glm-5.3". */
export type TrellisModelId = string & {};

export interface TrellisProviderSettings {
  /** Trellis API key (sk-tr-v1-...). Defaults to the TRELLIS_API_KEY environment variable, read per request. */
  apiKey?: string;
  /** Router base URL including /api/v1. Defaults to TRELLIS_BASE_URL, then the public router. */
  baseURL?: string;
  /**
   * "attested" sends every call only to providers whose enclave the router has verified, and makes the router
   * refuse (sending nothing, charging nothing) when none can answer. Sent as the X-Trellis-Lane header.
   */
  lane?: "public" | "attested";
  /** Extra headers for every request. */
  headers?: Record<string, string>;
  /** Custom fetch, for tests or middleware. */
  fetch?: FetchFunction;
}

/** What `providerMetadata.trellis` carries on a response: the receipt id to verify later, and the billed cost. */
export type TrellisMetadata = { receiptId?: string; receiptKeyId?: string; costUsd?: number };

const pick = (body: unknown): TrellisMetadata => {
  const b = (body ?? {}) as { receipt?: { id?: unknown; key_id?: unknown }; usage?: { cost?: unknown } };
  const out: TrellisMetadata = {};
  if (typeof b.receipt?.id === "string") out.receiptId = b.receipt.id;
  if (typeof b.receipt?.key_id === "string") out.receiptKeyId = b.receipt.key_id;
  if (typeof b.usage?.cost === "number") out.costUsd = b.usage.cost;
  return out;
};

const asMetadata = (m: TrellisMetadata) => (Object.keys(m).length ? { trellis: { ...m } } : undefined);

/** Lifts `receipt` and `usage.cost` from Trellis responses (and from the stream chunks that carry them). */
export const trellisMetadata: MetadataExtractor = {
  extractMetadata: async ({ parsedBody }) => asMetadata(pick(parsedBody)),
  createStreamExtractor: () => {
    let seen: TrellisMetadata = {};
    return {
      processChunk: (chunk) => {
        seen = { ...seen, ...pick(chunk) };
      },
      buildMetadata: () => asMetadata(seen),
    };
  },
};

export type TrellisProvider = OpenAICompatibleProvider<TrellisModelId, TrellisModelId, TrellisModelId, TrellisModelId>;

/** Create an Trellis provider. `trellis("<model id>")` returns a chat model. */
export function createTrellis(options: TrellisProviderSettings = {}): TrellisProvider {
  const baseURL = withoutTrailingSlash(loadOptionalSetting({ settingValue: options.baseURL, environmentVariableName: "TRELLIS_BASE_URL" })) ?? TRELLIS_BASE_URL;
  const send = options.fetch ?? globalThis.fetch;
  // The key is resolved when a request is sent, so the default `trellis` export works however late the
  // environment is loaded, and a missing key fails the call with a clear message instead of the import.
  const withKey: FetchFunction = (input, init) => {
    const headers = new Headers(init?.headers);
    if (!headers.has("authorization")) {
      const key = loadApiKey({ apiKey: options.apiKey, environmentVariableName: "TRELLIS_API_KEY", description: "Trellis" });
      headers.set("authorization", `Bearer ${key}`);
    }
    return send(input, { ...init, headers });
  };
  return createOpenAICompatible<TrellisModelId, TrellisModelId, TrellisModelId, TrellisModelId>({
    name: "trellis",
    baseURL,
    headers: { ...(options.lane && options.lane !== "public" ? { "X-Trellis-Lane": options.lane } : {}), ...options.headers },
    fetch: withKey,
    includeUsage: true,
    supportsStructuredOutputs: true,
    metadataExtractor: trellisMetadata,
  });
}

/** The default provider: the public router, key from TRELLIS_API_KEY. */
export const trellis = createTrellis();
