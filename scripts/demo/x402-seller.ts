// A tiny x402 seller for the devnet walkthrough (scripts/demo/devnet-paths.ts): one HTTP resource that answers 402 with
// Solana `exact` requirements (x402 v1 body, and the same as a v2 PAYMENT-REQUIRED header) and serves once the payment
// it is handed has been settled by a facilitator. It holds no key: the buyer signs the USDC transfer to `payTo`, the
// facilitator co-signs as fee payer and submits it, and the seller only relays { paymentPayload, paymentRequirements }
// to the facilitator's /verify and /settle. The same logic as the seller the offline suite fakes in
// test/tools-solana.test.ts (402 unpaid, the answer with X-PAYMENT-RESPONSE once paid), against a real facilitator.

export type SellerOptions = {
  /** Base URL of an x402 facilitator that speaks { x402Version, paymentPayload, paymentRequirements } (the router's own /facilitator). */
  facilitatorUrl: string;
  /** The seller's wallet (base58): the payment goes to its USDC associated token account. */
  payTo: string;
  /** The account the facilitator signs fees with, as its /supported names it. */
  feePayer: string;
  /** CAIP-2 network and the USDC mint the price is in. */
  network: string;
  asset: string;
  /** Price per call in USDC base units. */
  priceUnits: bigint;
  port?: number;
  hostname?: string;
};

export type Seller = { url: string; port: number; stop(): void; served: { path: string; payer: string; transaction: string }[]; refused: { path: string; reason: string }[] };

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64");

export function serveX402Seller(o: SellerOptions): Seller {
  const served: Seller["served"] = [];
  const refused: Seller["refused"] = [];
  const hostname = o.hostname ?? "127.0.0.1";
  const requirement = (resource: string) => ({
    scheme: "exact", network: o.network, maxAmountRequired: o.priceUnits.toString(), resource, description: "Stand-in weather lookup (devnet walkthrough)", mimeType: "application/json",
    payTo: o.payTo, maxTimeoutSeconds: 60, asset: o.asset, extra: { feePayer: o.feePayer, decimals: 6 },
  });
  const facilitator = async (path: "/verify" | "/settle", payload: unknown, req: unknown) => {
    const res = await fetch(`${o.facilitatorUrl}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ x402Version: (payload as { x402Version?: number }).x402Version ?? 1, paymentPayload: payload, paymentRequirements: req }), signal: AbortSignal.timeout(90_000) });
    return (await res.json().catch(() => ({}))) as Record<string, unknown>;
  };
  const unavailable = (field: "invalidReason" | "errorReason"): Record<string, unknown> => ({ isValid: false, success: false, [field]: "facilitator_unavailable" });
  const server = Bun.serve({
    hostname,
    port: o.port ?? 0,
    idleTimeout: 120,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname !== "/weather") return new Response("not found", { status: 404 });
      const resource = `${url.origin}${url.pathname}`;
      const req = requirement(resource);
      const header = request.headers.get("x-payment") ?? request.headers.get("payment-signature");
      const unpaid = (error: string) => {
        const v2 = { x402Version: 2, error, resource: { url: resource, description: req.description, mimeType: req.mimeType }, accepts: [{ scheme: req.scheme, network: req.network, amount: req.maxAmountRequired, asset: req.asset, payTo: req.payTo, maxTimeoutSeconds: req.maxTimeoutSeconds, extra: req.extra }] };
        return Response.json({ x402Version: 1, error, accepts: [req] }, { status: 402, headers: { "payment-required": b64(v2) } });
      };
      if (!header) return unpaid(`Payment of ${o.priceUnits} USDC base units required.`);
      let payload: unknown;
      try { payload = JSON.parse(Buffer.from(header, "base64").toString("utf8")); } catch { refused.push({ path: url.pathname, reason: "malformed_payment" }); return unpaid("The payment header is not base64 JSON."); }
      const verified = await facilitator("/verify", payload, req).catch(() => unavailable("invalidReason"));
      if (verified.isValid !== true) { refused.push({ path: url.pathname, reason: String(verified.invalidReason ?? "invalid_payment") }); return unpaid(`Payment refused: ${String(verified.invalidReason ?? "invalid_payment")}.`); }
      const settled = await facilitator("/settle", payload, req).catch(() => unavailable("errorReason"));
      if (settled.success !== true) { refused.push({ path: url.pathname, reason: String(settled.errorReason ?? "settle_failed") }); return unpaid(`Payment not settled: ${String(settled.errorReason ?? "settle_failed")}.`); }
      const transaction = String(settled.transaction);
      served.push({ path: url.pathname, payer: String(settled.payer ?? ""), transaction });
      const city = (url.searchParams.get("city") ?? "oslo").slice(0, 40);
      const settlement = b64({ success: true, transaction, network: o.network, payer: settled.payer ?? "" });
      return Response.json({ city, temp_c: 21, conditions: "clear", source: "devnet walkthrough stand-in, not real weather" }, { headers: { "x-payment-response": settlement, "payment-response": settlement } });
    },
  });
  return { url: `http://${hostname}:${server.port}/weather`, port: server.port ?? 0, stop: () => server.stop(true), served, refused };
}
