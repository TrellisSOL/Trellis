import { estimatePromptTokens } from "../router/pricing.ts";
import type { BoundSettings, ItemLimits } from "../router/estimate.ts";

// `transforms: ["middle-out"]`: when a prompt would not fit the model's context, drop messages
// from the middle of the conversation (keeping the system prompt(s) and the most recent turns),
// then truncate the middle of any single oversized message.

//
// "Fits" is judged on the prompt bound (router/estimate.ts), the same figure the context check and the hold use, so a
// prompt this transform passes is one routing accepts. `o.bytesPerToken` is HOLD_CONTEXT_BYTES_PER_TOKEN.
export function middleOut(body: Record<string, unknown>, contextTokens: number, reserveOutput: number, o: { items?: ItemLimits | null; settings?: Partial<BoundSettings>; bytesPerToken?: number } = {}) {
  const budget = Math.max(256, contextTokens - reserveOutput);
  if (!Array.isArray(body.messages)) return { removed: 0, truncated: 0 };
  let messages = [...(body.messages as any[])];
  let removed = 0;
  let truncated = 0;
  const per = Math.max(1, o.bytesPerToken ?? 1);
  // Non-text parts with no catalog figure are refused later, with a clear error; here they simply do not count.
  const fits = () => Math.ceil(estimatePromptTokens({ ...body, messages }, { items: o.items, settings: o.settings, lenient: true }) / per) <= budget;
  while (!fits()) {
    const removable = messages.map((m, i) => ({ m, i })).filter(({ m, i }) => m?.role !== "system" && i < messages.length - 1);
    if (!removable.length) break;
    const target = removable[Math.floor(removable.length / 2)].i;
    // Keep tool call/result pairs intact: drop a tool result together with its call.
    const next = messages[target + 1];
    const span = messages[target]?.tool_calls && next?.role === "tool" && target + 1 < messages.length - 1 ? 2 : 1;
    messages.splice(target, span);
    removed += span;
  }
  if (!fits()) {
    messages = messages.map((m) => {
      if (typeof m?.content !== "string") return m;
      // One UTF-16 unit is at most three UTF-8 bytes, and the bound counts bytes: a third of the per-message share always fits.
      const maxChars = Math.max(200, Math.floor((budget * per) / 3 / Math.max(1, messages.length)));
      if (m.content.length <= maxChars) return m;
      truncated++;
      const half = Math.floor(maxChars / 2);
      return { ...m, content: m.content.slice(0, half) + "\n…[middle-out truncated]…\n" + m.content.slice(-half) };
    });
  }
  body.messages = messages;
  return { removed, truncated };
}
