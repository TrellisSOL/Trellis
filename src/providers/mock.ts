import { Hono } from "hono";
import { randomBytes } from "node:crypto";

// A configurable OpenAI-compatible provider used by tests, the local demo and canary development.
// It speaks the provider spec (/models with pricing/quantization/features), chat/completions
// (JSON + SSE), legacy completions, embeddings, rerank, logprobs, and a TEE-style attestation endpoint.
// Behaviours can be switched at runtime through POST /_control.

export type MockBehaviour = "ok" | "empty200" | "error500" | "rate429" | "slow" | "hang" | "reject400" | "midstream_error" | "no_usage" | "auth401" | "truncate_after_usage";
export type MockModel = {
  id: string; slug?: string; prompt: string; completion: string; request?: string; ctx?: number; quant?: string; features?: string[]; params?: string[]; creator?: string; output?: string[]; hf?: string;
  /** max_output_length this model declares (default 8192); null declares none. */
  maxOut?: number | null;
  /** Extra prices: cache write / cache read / reasoning, as USD per token. */
  cacheWrite?: string; cacheRead?: string; reasoning?: string;
  /** Input modalities declared (default text only) and the per-item token ceilings declared for non-text inputs. */
  input?: string[]; itemTokens?: { image?: number; audio?: number; video?: number; file?: number };
};
export type MockConfig = {
  name: string;
  models: MockModel[];
  behaviour?: MockBehaviour;
  quantNoise?: number; // perturbs logprobs to imitate lower precision
  delayMs?: number;
  tee?: "dev" | null;
  /** What a development attestation reports about the in-enclave classifier (absent = says nothing). */
  classifier?: boolean;
  wrongAnswers?: boolean; // degrade the canary benchmark
  /** Test hook: the reply for a prompt, or undefined to fall back to the built-in answers. Not settable through /_control. */
  reply?: (prompt: string, body: any) => string | undefined;
  /** Test hook: token counts to report instead of the measured ones. */
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  /** Test hook: awaited before a stream sends content part `part` (0-based), so a test can hold a stream half-way. */
  holdStream?: (part: number) => Promise<void> | void;
  /**
   * How /rerank answers: "jina" (default: results with relevance_score, usage.total_tokens, honours top_n and
   * return_documents), "cohere" (results without documents, usage as meta.billed_units.search_units) or "invalid"
   * (an index and a score that make no sense, to test that the router refuses them).
   */
  rerankShape?: "jina" | "cohere" | "invalid";
  /**
   * Test hook for a misbehaving upstream (security review R3-02). `overGenerate`: characters of completion text sent
   * whatever `max_tokens` says (the output cap is ignored). `usage`: the usage object reported for a call, whatever was
   * really processed (over-reporting); return undefined to report the measured usage. Not settable through /_control.
   */
  adversarial?: {
    overGenerate?: number; usage?: (path: string, body: any) => Record<string, unknown> | undefined;
    /**
     * Security review R5-01. `pad`: bytes added to the answer OUTSIDE its content (as `logprobs` with many alternatives
     * do), so the body is large while the usage stays inside the cap that was sent. `embeddingDims`: the size of each
     * embedding vector (default 3).
     */
    pad?: number; embeddingDims?: number;
  };
};

/**
 * What a call would be billed by this provider's own meter (test oracle, security review R5-01): written for every
 * call that got past the error gate, whether or not anyone was still listening. `completion` grows as a stream sends.
 * `reported` is the usage object the call reported (undefined when it reported none).
 */
export type MockMeter = { path: string; body: any; stream: boolean; prompt: number; completion: number; reported?: Record<string, unknown> };

const WORDS = "the quick brown fox jumps over the lazy dog and keeps running far away".split(" ");
const ANSWERS: Record<string, string> = {
  "17 * 23": "391",
  "capital of australia": "Canberra",
  "'router' backwards": "retuor",
  "2 to the power of 10": "1024",
  "closest to the sun": "Mercury",
  "hexagon": "6",
  "symbol for gold": "Au",
  "144 divided by 12": "12",
};

function answerFor(prompt: string, cfg: MockConfig) {
  const lower = prompt.toLowerCase();
  for (const [k, v] of Object.entries(ANSWERS)) if (lower.includes(k.toLowerCase())) return cfg.wrongAnswers ? "I am not sure" : v;
  if (lower.includes("next ten words")) return WORDS.slice(0, 10).join(" ");
  return `Hello from ${cfg.name}. You said: ${prompt.slice(0, 200)}`;
}

function logprobsFor(text: string, noise: number) {
  const toks = text.split(/(?=\s)/).slice(0, 12);
  return {
    content: toks.map((tok, i) => {
      const base = -0.05 - i * 0.02;
      const jitter = noise ? Math.sin(i * 7.3 + tok.length) * noise : 0;
      return {
        token: tok,
        logprob: base + jitter,
        top_logprobs: [
          { token: tok, logprob: base + jitter },
          { token: " alt" + i, logprob: -3 - i * 0.1 - jitter },
          { token: " other" + i, logprob: -4.5 - i * 0.05 + jitter / 2 },
        ],
      };
    }),
  };
}

export function createMockProvider(initial: MockConfig) {
  const cfg: MockConfig = { behaviour: "ok", quantNoise: 0, delayMs: 0, tee: null, ...initial };
  const stats = { requests: 0, lastBody: null as any, lastAuth: null as string | null, calls: [] as { path: string; body: any }[], meter: [] as MockMeter[], inFlight: 0 };
  const meter = (m: MockMeter) => { stats.meter.push(m); if (stats.meter.length > 400) stats.meter.shift(); return m; };
  const note = (path: string, body: any) => {
    stats.calls.push({ path, body });
    if (stats.calls.length > 200) stats.calls.shift();
  };
  const app = new Hono();

  app.post("/_control", async (c) => {
    Object.assign(cfg, await c.req.json());
    return c.json({ ok: true, cfg });
  });
  app.get("/_stats", (c) => c.json(stats));

  app.get("/models", (c) =>
    c.json({
      data: cfg.models.map((m) => ({
        id: m.id,
        name: m.slug ?? m.id,
        created: 1_780_000_000,
        trellis: m.slug ? { slug: m.slug } : undefined,
        hugging_face_id: m.hf,
        input_modalities: m.input ?? ["text"],
        output_modalities: m.output ?? ["text"],
        quantization: m.quant ?? "bf16",
        context_length: m.ctx ?? 131072,
        ...(m.maxOut === null ? {} : { max_output_length: m.maxOut ?? 8192 }),
        ...(m.itemTokens ? { input_token_limits: m.itemTokens } : {}),
        pricing: { prompt: m.prompt, completion: m.completion, request: m.request ?? "0", image: "0", ...(m.cacheWrite ? { input_cache_write: m.cacheWrite } : {}), ...(m.cacheRead ? { input_cache_read: m.cacheRead } : {}), ...(m.reasoning ? { internal_reasoning: m.reasoning } : {}) },
        supported_sampling_parameters: m.params ?? ["temperature", "top_p", "stop", "seed", "max_tokens", "logprobs", "top_logprobs"],
        supported_features: m.features ?? ["tools", "json_mode"],
      })),
    }),
  );

  app.get("/attestation", (c) => {
    if (cfg.tee !== "dev") return c.json({ error: "no tee" }, 404);
    return c.json({ kind: "dev", nonce: c.req.query("nonce"), measurement: "mock-measurement-v1", ...(cfg.classifier != null ? { classifier: { enabled: cfg.classifier } } : {}) });
  });

  const gate = async () => {
    stats.requests++;
    const b = cfg.behaviour;
    if (cfg.delayMs) await new Promise((r) => setTimeout(r, cfg.delayMs));
    if (b === "error500") return new Response(JSON.stringify({ error: { message: "upstream exploded" } }), { status: 500 });
    if (b === "rate429") return new Response(JSON.stringify({ error: { message: "slow down" } }), { status: 429 });
    if (b === "reject400") return new Response(JSON.stringify({ error: { message: "bad parameter foo" } }), { status: 400 });
    if (b === "auth401") return new Response(JSON.stringify({ error: { message: "bad key" } }), { status: 401 });
    if (b === "hang") await new Promise((r) => setTimeout(r, 600_000));
    return null;
  };

  app.post("/chat/completions", async (c) => {
    const body = await c.req.json();
    stats.lastBody = body;
    note("/chat/completions", body);
    stats.lastAuth = c.req.header("authorization") ?? null;
    stats.inFlight++;
    const early = await gate().finally(() => stats.inFlight--);
    if (early) return early;
    const last = [...(body.messages ?? [])].reverse().find((m: any) => m.role === "user");
    const prompt = typeof last?.content === "string" ? last.content : (last?.content ?? []).map((p: any) => p.text ?? "").join(" ");
    const empty = cfg.behaviour === "empty200";
    const wantsTool = Array.isArray(body.tools) && body.tools.length && body.tool_choice !== "none";
    const text = empty ? "" : cfg.adversarial?.overGenerate ? "y".repeat(cfg.adversarial.overGenerate) : (cfg.reply?.(prompt, body) ?? answerFor(prompt, cfg)).slice(0, Math.max(1, (body.max_tokens ?? 4096) * 4));
    // `n` choices: generated and metered n times, the prompt too (a provider that fans the request out bills it each time).
    const n = !body.stream && Number.isInteger(body.n) && body.n > 1 ? (body.n as number) : 1;
    const promptTokens = Math.ceil(JSON.stringify(body.messages ?? []).length / 4) * n;
    const completionTokens = (empty ? 0 : Math.max(1, Math.ceil(text.length / 4))) * n;
    const reportedIn = cfg.usage?.prompt_tokens ?? promptTokens;
    const reportedOut = cfg.usage?.completion_tokens ?? completionTokens;
    // "empty200" stands for a broken host: empty content and no usage figures (the router treats that as a failed
    // attempt). With the `usage` hook set it is an empty answer the host completed AND metered, which the router
    // delivers and charges (security review R4-02).
    const unmetered = cfg.behaviour === "no_usage" || (empty && !cfg.usage);
    const usage = unmetered ? undefined : (cfg.adversarial?.usage?.("/chat/completions", body) ?? { prompt_tokens: reportedIn, completion_tokens: reportedOut, total_tokens: reportedIn + reportedOut });
    const id = "cmpl-" + randomBytes(6).toString("hex");
    const toolCalls = wantsTool && !empty ? [{ id: "call_1", type: "function", function: { name: body.tools[0].function?.name ?? "fn", arguments: '{"ok":true}' } }] : undefined;
    // A broken host's empty, unmetered 200 bills nothing; everything else that got this far is on the meter.
    const metered = empty && unmetered ? null : meter({ path: "/chat/completions", body, stream: !!body.stream, prompt: promptTokens, completion: body.stream ? 0 : completionTokens, reported: body.stream ? undefined : (usage as Record<string, unknown> | undefined) });
    if (!body.stream) {
      const pad = cfg.adversarial?.pad ? { pad: "p".repeat(cfg.adversarial.pad) } : null;
      const choice = (index: number) => ({ index, message: { role: "assistant", content: toolCalls ? null : empty ? "" : text, ...(toolCalls ? { tool_calls: toolCalls } : {}) }, finish_reason: toolCalls ? "tool_calls" : "stop", ...(pad ? { logprobs: pad } : body.logprobs ? { logprobs: logprobsFor(text, cfg.quantNoise ?? 0) } : {}) });
      return c.json({
        id,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: body.model,
        choices: Array.from({ length: n }, (_x, i) => choice(i)),
        usage,
      });
    }
    const enc = new TextEncoder();
    const stream = new ReadableStream({
      async start(ctl) {
        stats.inFlight++; // until the stream has ended: a test waits on this before it reads the meter
        try {
        const send = (o: unknown) => ctl.enqueue(enc.encode(`data: ${JSON.stringify(o)}\n\n`));
        ctl.enqueue(enc.encode(": keep-alive\n\n"));
        send({ id, object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta: { role: "assistant", content: "" } }] });
        const parts = empty ? [] : text.match(text.length > 6_000 ? /.{1,2000}/gs : /.{1,6}/gs) ?? [];
        for (const [i, p] of parts.entries()) {
          if (cfg.behaviour === "midstream_error" && i === 2) {
            send({ id, error: { message: "provider fell over mid-stream" } });
            ctl.close();
            return;
          }
          // Reports usage for the whole answer, then the connection ends before any finish_reason.
          if (cfg.behaviour === "truncate_after_usage" && i === 2) {
            if (usage) { send({ id, object: "chat.completion.chunk", model: body.model, choices: [], usage }); if (metered) metered.reported = usage as Record<string, unknown>; }
            ctl.close();
            return;
          }
          if (cfg.behaviour === "slow") await new Promise((r) => setTimeout(r, 20));
          await cfg.holdStream?.(i);
          // A provider stops generating (and metering) once its client has closed the connection.
          if (c.req.raw.signal?.aborted) { try { ctl.close(); } catch { /* already closed */ } return; }
          send({ id, object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta: { content: p } }] });
          if (metered) metered.completion += Math.ceil(p.length / 4); // a stream is metered as it sends
        }
        send({ id, object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
        if (usage && body.stream_options?.include_usage) { send({ id, object: "chat.completion.chunk", model: body.model, choices: [], usage }); if (metered) metered.reported = usage as Record<string, unknown>; } // a stream's report is its meter only once it was sent
        ctl.enqueue(enc.encode("data: [DONE]\n\n"));
        ctl.close();
        } finally { stats.inFlight--; }
      },
    });
    return new Response(stream, { headers: { "content-type": "text/event-stream" } });
  });

  app.post("/completions", async (c) => {
    const body = await c.req.json();
    note("/completions", body);
    stats.inFlight++;
    const early = await gate().finally(() => stats.inFlight--);
    if (early) return early;
    const text = cfg.behaviour === "empty200" ? "" : cfg.adversarial?.overGenerate ? "y".repeat(cfg.adversarial.overGenerate) : ` continuation of ${String(body.prompt).slice(0, 40)}`;
    const usage = cfg.behaviour === "no_usage" ? undefined : (cfg.adversarial?.usage?.("/completions", body) ?? { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 });
    if (cfg.behaviour !== "empty200") meter({ path: "/completions", body, stream: false, prompt: 5, completion: cfg.adversarial?.overGenerate ? Math.ceil(text.length / 4) : 5, reported: usage as Record<string, unknown> | undefined });
    return c.json({ id: "cmpl-x", object: "text_completion", model: body.model, choices: [{ index: 0, text, finish_reason: "stop", ...(cfg.adversarial?.pad ? { logprobs: { pad: "p".repeat(cfg.adversarial.pad) } } : {}) }], usage });
  });

  app.post("/embeddings", async (c) => {
    const body = await c.req.json();
    note("/embeddings", body);
    stats.inFlight++;
    const early = await gate().finally(() => stats.inFlight--);
    if (early) return early;
    const inputs = Array.isArray(body.input) ? body.input : [body.input];
    const tokens = inputs.join(" ").length / 4;
    const usage = cfg.behaviour === "no_usage" ? undefined : (cfg.adversarial?.usage?.("/embeddings", body) ?? { prompt_tokens: tokens, total_tokens: tokens });
    const dims = cfg.adversarial?.embeddingDims;
    const data = inputs.map((s: string, i: number) => ({ object: "embedding", index: i, embedding: dims ? Array.from({ length: dims }, (_x, j) => (j % 7) / 7 - 0.123456789012) : [String(s).length / 100, 0.5, -0.25] }));
    meter({ path: "/embeddings", body, stream: false, prompt: Math.ceil(tokens), completion: 0, reported: usage as Record<string, unknown> | undefined });
    return c.json({ object: "list", model: body.model, data, usage });
  });

  // A toy cross-encoder: the share of the query's words found in each document, so scores are deterministic and ordered.
  app.post("/rerank", async (c) => {
    const body = await c.req.json();
    stats.lastBody = body;
    note("/rerank", body);
    stats.lastAuth = c.req.header("authorization") ?? null;
    const early = await gate();
    if (early) return early;
    const words = (s: string) => s.toLowerCase().match(/[a-z0-9]+/g) ?? [];
    const query = new Set(words(String(body.query ?? "")));
    const docs: string[] = (Array.isArray(body.documents) ? body.documents : []).map((d: unknown) => (typeof d === "string" ? d : String((d as { text?: unknown })?.text ?? "")));
    const score = (d: string) => {
      const w = new Set(words(d));
      let hit = 0;
      for (const q of query) if (w.has(q)) hit++;
      return Number((query.size ? hit / query.size : 0).toFixed(6));
    };
    const ranked = docs.map((d, index) => ({ index, relevance_score: score(d) })).sort((a, b) => b.relevance_score - a.relevance_score || a.index - b.index);
    const top = Number.isInteger(body.top_n) && body.top_n > 0 ? ranked.slice(0, body.top_n) : ranked;
    const tokens = docs.reduce((n, d) => n + Math.ceil((String(body.query ?? "").length + d.length) / 4), 0);
    if (cfg.behaviour === "empty200") return c.json({ model: body.model, results: [], usage: { total_tokens: tokens } });
    if (cfg.rerankShape === "invalid") return c.json({ model: body.model, results: [{ index: docs.length + 5, relevance_score: "high" }], usage: { total_tokens: tokens } });
    if (cfg.rerankShape === "cohere")
      return c.json({ id: "rr-" + randomBytes(4).toString("hex"), results: top, meta: { api_version: { version: "2" }, billed_units: { search_units: Math.max(1, Math.ceil(docs.length / 100)) } } });
    return c.json({
      model: body.model,
      results: top.map((r) => ({ ...r, ...(body.return_documents ? { document: { text: docs[r.index] } } : {}) })),
      ...(cfg.behaviour === "no_usage" ? {} : { usage: cfg.adversarial?.usage?.("/rerank", body) ?? { total_tokens: tokens } }),
    });
  });

  return { app, cfg, stats };
}

/** Serve a mock provider on an ephemeral port. */
export function serveMockProvider(cfg: MockConfig, port = 0) {
  const m = createMockProvider(cfg);
  const server = Bun.serve({ port, hostname: "127.0.0.1", fetch: m.app.fetch, idleTimeout: 255 });
  return { ...m, url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}
