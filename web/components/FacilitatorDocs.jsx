import { NotAtLaunch } from "./LaunchSurfaceDocs";
import { Code } from "./UI";
import { MAINNET, USDC_MINT } from "../lib/solana.js";

export const supportedExample = `GET /facilitator/supported
{ "kinds": [
    { "x402Version": 2, "scheme": "exact", "network": "${MAINNET}", "extra": { "feePayer": "<relay address>" } },
    { "x402Version": 2, "scheme": "tab",   "network": "${MAINNET}", "extra": { "program": "<trellis_tab program id>", "feePayer": "<relay address>", "maxCapUnits": "…" } } ],
  "fee_bps": 0, "fee_waiver_until": "…", "networks": ["${MAINNET}"] }`;

/** The hosted x402 facilitator (docs/Trellis_Backend.md §5.2), open to any seller. */
export default function FacilitatorDocs() {
  return <section id="facilitator" className="docs-section">
    <h2>x402 facilitator</h2><NotAtLaunch />
    <p>Trellis runs an x402 facilitator for Solana: <code>GET /facilitator/supported</code>, <code>POST /facilitator/verify</code> and <code>POST /facilitator/settle</code>, for the schemes <code>exact</code> and <code>tab</code> on <code>{MAINNET}</code>, asset USDC (<code>{USDC_MINT}</code>). It is non-custodial: it never holds funds, and settlement goes from the payer (or the payer's tab escrow) straight to the payee. The facilitator's relay key pays the Solana network fee as fee payer and takes nothing out of the settled amount. It signs only above its balance floor and within budgets per payer, per seller, per source address and in total (over any minute and any 24 hours); past a limit <code>settle</code> answers <code>429 rate_limited</code>, and a payer whose sponsored payment failed after it was sent is not sponsored again for 30 days (<code>403 payer_not_sponsored</code>). A settlement is simulated before the relay signs, and one that would fail is not sent.</p>
    <p>On Trellis&rsquo;s own per-call path the rule differs, and is stated under <a className="inline-link" href="#per-call-cost">Payments</a>: a per-call payment has a minimum size (0.03 USDC by default) and the router passes the network fee of that payment on to its payer at cost, as its own line (<code>network_fee</code> on the receipt, quoted as <code>network_fee_max_usdc</code>). That is cost recovery, not a markup; <code>GET /api/v1/status</code> shows lamports paid beside USDC recovered.</p>
    <Code label="What it supports">{supportedExample}</Code>
    <p><code>verify</code> takes a payment payload and the seller's payment requirements and answers <code>{"{ isValid, invalidReason?, payer }"}</code>; <code>settle</code> submits the transfer and answers <code>{"{ success, transaction, network, payer }"}</code>. A (payer, nonce) pair settles once: a replay returns the earlier result. The facilitator charges no fee; <code>fee_bps</code> and <code>fee_waiver_until</code> say which applies now.</p>
    <p>The facilitator is open to any seller, not only Trellis; the <code>tab</code> scheme is published as a draft extension to x402. Sellers listed in the <a className="inline-link" href="#paid-tools">tool market</a> through it appear in search without a canary.</p>
  </section>;
}
