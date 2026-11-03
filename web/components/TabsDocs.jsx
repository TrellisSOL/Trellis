import { NotAtLaunch } from "./LaunchSurfaceDocs";
import { Code } from "./UI";

export const tabProgram = `open_tab(payer, payee, mint=USDC, cap, expiry, session_key)  // moves cap into the Tab PDA escrow; expiry at most 30 days out
voucher (off-chain) = Ed25519_sign(session_key,
    "trellis:tab:voucher:v1" || program_id || tab || created_at || cumulative_used || seq)   // 110 bytes
post_voucher(tab, voucher) // payee: records its highest voucher without closing; needs only the tab and the voucher
close(tab, voucher)       // payee: verifies the voucher via the Ed25519 program; pays cumulative_used, refunds the rest
reclaim(tab)              // anyone: after expiry + 24h with no close, pays the payee its highest posted voucher and the payer the rest
top_up(tab, amount)       // payer: before expiry, within the per-tab cap`;

export const voucherLayout = `offset  length  field
0       22      "trellis:tab:voucher:v1"   (ASCII)
22      32      tab program id
54      32      tab address
86      8       Tab.created_at             (i64, little-endian, unix seconds)
94      8       cumulative_used            (u64, little-endian, USDC base units)
102     8       seq                        (u64, little-endian)
X-Trellis-Tab: <tab address>
X-Trellis-Tab-Voucher: <base64 of the 110 bytes>.<base64 of the 64-byte signature>`;

export const tabSdk = `import { Trellis, signTransaction, sendTransaction } from "@trellis/sdk";
const client = new Trellis({ apiKey: process.env.TRELLIS_API_KEY });
// The session key signs vouchers; the wallet signs open_tab once. Expiry is at most 30 days out.
const sessionKey = await client.tabs.generateSessionKey();
const open = await client.tabs.open({ payer: wallet.publicKey, payee, cap: 20_000_000n, expiry: Math.floor(Date.now() / 1000) + 86_400, sessionKey: sessionKey.publicKey, recentBlockhash });
await sendTransaction(await signTransaction(open.transaction, wallet), { rpcUrl });
// Once it has landed: the session reads the tab's created_at from the chain, because vouchers are signed for it.
const session = await client.tabs.resume({ tab: open.tab, sessionKey, rpcUrl });
// Every call then carries a voucher for the cumulative amount used; the router stops serving if more than
// max(0.25 x last request cost, $0.05) is unvouched, and says how much to vouch for (402 voucher_required).
const voucher = await session.voucher(12_300n);
const reply = await client.chat.completions.create({ model, messages }, { headers: voucher.headers });`;

/** Tabs (docs/Trellis_Backend.md §5.2): authorize a ceiling, pay exactly what was used, get the rest back. */
export default function TabsDocs() {
  return <section id="tabs" className="docs-section">
    <h2>Pay by tab</h2><NotAtLaunch />
    <p>A tab is the x402 <code>tab</code> scheme: you authorize a ceiling once, the router serves against it, and you pay exactly what you used. <code>open_tab</code> moves the cap into a <code>trellis_tab</code> escrow for a payee until an expiry. Each request then carries a voucher, an ed25519 signature by your <em>session key</em> for the cumulative amount used and a sequence number; nothing goes on chain per call. When the tab closes, the payee posts the highest voucher: it is paid <code>cumulative_used</code> and the rest of the cap comes back to you. If the payee never closes, <code>reclaim</code> after the expiry plus 24 hours refunds everything not covered by the highest voucher the payee posted; it needs nobody's signature. A tab's expiry is at most 30 days from the moment it is opened.</p>
    <Code label="trellis_tab">{tabProgram}</Code>
    <h3 id="tab-vouchers">What a voucher signs</h3>
    <p>A voucher is the session key's signature over 110 bytes. They start with a fixed domain string, so a voucher is never some other message the key signed. They name the tab program, whose id differs on each cluster, so a devnet voucher is nothing on mainnet. And they carry the tab's <code>created_at</code>, the time the program recorded when <code>open_tab</code> landed: a tab address can be opened again after it is closed (same payer, payee and tab id), and a voucher signed for the earlier opening is worth nothing against the new escrow, even with the same session key. Read <code>created_at</code> from the Tab account once the tab is open; the SDKs do (<code>tabs.resume</code>, <code>fetchTabAccount</code>). The program, the router and the facilitator accept only this form: the earlier 48-byte message (tab, cumulative amount and sequence number alone) is refused. The router answers <code>402 voucher_wrong_program</code> or <code>402 voucher_wrong_tab_opening</code> when a voucher was signed for something else.</p>
    <Code label="Voucher bytes and headers">{voucherLayout}</Code>
    <p>A tab can be bound to an on-chain rulebook of the payer's own (a <code>trellis_rules</code> account) when it is opened: <code>open_tab</code> and <code>top_up</code> then also take the rulebook, the rules program's config and the rules program, and the escrowed amount is counted against the rulebook's daily limit. <code>close</code> and <code>reclaim</code> take none of them: the rulebook's limits apply when money is committed, not at settlement, so a rulebook changed or killed after service does not reduce what was vouched. A killed or expired rulebook refuses a new tab or top-up, and the router refuses a call above the rulebook's per-call maximum.</p>
    <p>A close does not depend on the payer's accounts. If the payer's USDC account is missing, closed or frozen, the payee is still paid and the payer's share stays in escrow until <code>reclaim</code> delivers it. The payee can post its highest voucher at any time with <code>post_voucher</code>, which needs no token account and no rulebook; a later <code>reclaim</code> pays it that amount. Settlement works from what the escrow holds: anything sent to it by a third party goes back to the payer.</p>
    <p>The payee's exposure is bounded: it stops serving when unvouched usage exceeds <code>max(0.25 × last request cost, $0.05)</code>. The facilitator verifies and settles tabs non-custodially (payer escrow to payee). Current pricing: no facilitator fee; <code>fee_bps</code> in <code>GET /facilitator/supported</code> says what applies.</p>
    <h3>The session key</h3>
    <p>Vouchers are signed by a session key, not by your wallet, so a request does not need a wallet prompt. The <a className="inline-link" href="/tabs/">tabs page</a> makes one in your browser with WebCrypto, keeps the private half non-extractable in this browser's IndexedDB and shows the public key to give to an SDK; the SDKs can also make their own. Opening a tab, topping it up and reclaiming it are wallet transactions made from an SDK or a script, not from this site.</p>
    <Code label="Open a tab from the SDK">{tabSdk}</Code>
  </section>;
}
