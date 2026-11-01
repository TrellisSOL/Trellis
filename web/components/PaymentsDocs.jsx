import { NotAtLaunch } from "./LaunchSurfaceDocs";
import { Code } from "./UI";
import { MAINNET, USDC_MINT } from "../lib/solana.js";

export const depositExample = `curl -s https://trellis.example/api/v1/credits/deposit-tx \\
  -H "Authorization: Bearer $TRELLIS_API_KEY" -H "content-type: application/json" \\
  -d '{"amount":"25","payer":"<your wallet address>"}'
# data.transaction: an unsigned Solana transaction (base64) for your wallet to sign and send.
# data.key_hash, data.accounts.vault, data.expires_at_block_height: what the transaction commits to.
# data.refund_to: the USDC account this deposit is paid from. If the key is ever closed, what is left of it goes back there.`;

export const closeExample = `curl -s https://trellis.example/api/v1/credits/close \\
  -H "Authorization: Bearer $TRELLIS_API_KEY" -H "content-type: application/json" \\
  -d '{"payer":"<the wallet that will pay the fee>"}'
# 201 {"data":{"id":"close_…","status":"queued","payable_at":"…","payer":"…","signed_by_key":true,
#              "transaction":"<base64, already signed by the key>","expires_at_block_height":…,
#              "refunds":[{"depositor":"<a wallet that paid in>","refund_to":"<the USDC account it paid from>",
#                          "deposited_units":"25000000","refunded_units":"0"}]}}
# The payer wallet adds its signature as fee payer and sends data.transaction before the blockhash expires.
# There is no destination to send: a request that carries refund_to is answered 400 refund_destination_fixed.`;

export const closeSdkExample = `import { Trellis, keypairSigner, sendTransaction } from "@trellis/sdk";
const client = new Trellis({ apiKey: process.env.TRELLIS_API_KEY });        // the key being closed
const payer = keypairSigner(walletSecretKey);                                // any wallet: it only pays the fee
const { closure, signed } = await client.credits.closeWith(payer);           // the key's signature is already in place
console.log(closure.refunds);                                                // who is paid back, and to which account
if (signed) await sendTransaction(signed, { rpcUrl });                       // null: already registered on chain`;

export const cancelExample = `curl -s https://trellis.example/api/v1/credits/close/cancel \\
  -H "Authorization: Bearer $TRELLIS_API_KEY" -H "content-type: application/json" \\
  -d '{"payer":"<the wallet that will pay the fee>"}'
# 200 {"data":{"transaction":"<base64, already signed by the key>","payer":"…","signed_by_key":true,"expires_at_block_height":…}}
# 400 nothing_to_cancel: no closure of this key is on chain.   409 refund_in_progress: a payment has already been sent.`;

export const refundDestinationExample = `curl -s https://trellis.example/api/v1/credits/refund-destination-tx \\
  -H "Authorization: Bearer $TRELLIS_API_KEY" -H "content-type: application/json" \\
  -d '{"depositor":"<the wallet that paid in>","refund_to":"<the wallet that should receive its share>"}'
# 200 {"data":{"transaction":"<base64, unsigned>","depositor":"…","refund_to":"…","current_refund_to":"…","expires_at_block_height":…}}
# Only the depositor's wallet can sign it. 404: that wallet never deposited to this key.`;

export const releaseExample = `curl -s https://trellis.example/api/v1/credits/close/release \\
  -H "Authorization: Bearer $OWNER_OR_ADMIN_KEY" -H "content-type: application/json" \\
  -d '{"key":"<hash of the disabled key, as GET /api/v1/keys lists it>"}'
# 200 {"data":[{"id":"close_…","status":"registered","released":true,"payable_at":"…"}]}`;

export const walletAuthExample = `trellis:wallet-auth:v2
POST
trellis.example
/api/v1/chat/completions
1790000000
<sha256 hex of what the route binds>`;

export const signInExample = `POST /api/v1/auth/wallet/challenge   {"address":"<base58 wallet address>"}
# data: { nonce, message, domain, uri, chain_id, issued_at, expires_at, version: "trellis:wallet:v2" }
# message, to sign exactly as returned (UTF-8 bytes, ed25519, base58 signature):
#   trellis.example wants you to sign in with your Solana account:
#   <address>
#
#   Sign in to Trellis with this wallet. Signing proves you hold the address: it sends no transaction and costs nothing.
#
#   URI: https://trellis.example
#   Version: 1
#   Chain ID: ${MAINNET}
#   Nonce: <nonce>
#   Issued At: <time>
#   Expiration Time: <time, five minutes later>
POST /api/v1/auth/wallet             {"address":"…","nonce":"…","signature":"<base58>","message":"<the same text>"}
# 201 { data: {…}, key: "sk-tr-v1-…" }   the wallet account's API key, shown once`;

/** Payments: prepaid USDC credits on Solana, per-call x402, tabs, blind credits and pay-with-stock, and what each costs. */
export default function PaymentsDocs() {
  return <section id="payments" className="docs-section">
    <h2>Payments</h2>
    <p>Every way to pay settles in USDC on Solana mainnet-beta (CAIP-2 <code>{MAINNET}</code>, mint <code>{USDC_MINT}</code>). Current pricing: zero markup on every method. You pay the price of the inference you use, per token, at the rate of the host that serves it; hosts receive their full price. Two things are not part of that price and are not a markup: a per-call (x402) payment has a minimum size (0.03 USDC by default), and when the router pays the Solana network fee of your per-call payment it passes that fee on at cost, as its own line (<code>network_fee</code> on the receipt, quoted beforehand as <code>network_fee_max_usdc</code>). <a className="inline-link" href="#per-call-cost">Per call</a> has the details.</p>
    <p>Before a call is sent to a provider the router holds an amount on your balance. The hold is a worst-case bound, not an estimate: the request counted from its bytes for every input shape, plus the output cap, which is always sent to the provider. It is several times a typical charge. You are charged what the call used and never more than the hold; if a provider reports more than was held, you pay the hold, and the response and the receipt carry <code>cost_details.over_hold</code>. A request whose input cannot be bounded (for example an image for a model whose catalogue entry declares no per-image limit) is refused with <code>400 unboundable_input</code> and nothing is charged.</p>
    <p>At launch a router takes three of the methods below: prepaid credits, per-call (x402) payments and tabs (an open tab named in the <code>X-Trellis-Tab</code> header with a session-key voucher). Blind tokens, paying with a tokenized stock and bringing your own key are written and carry a “Built, not enabled at launch” line.</p>
    <h3 id="calls-that-end-early">Calls that end early</h3>
    <p>A provider that is working on a call bills it whether or not anyone is still listening, so a call that does not end normally is charged what the provider can bill, and never more than the hold. This is current behaviour and can change.</p>
    <table>
      <thead><tr><th>What happened</th><th>What you are charged</th></tr></thead>
      <tbody>
        <tr><td>The provider answered and reported usage</td><td>The reported usage. An empty answer the provider metered is delivered and charged too.</td></tr>
        <tr><td>The provider answered and reported no usage</td><td>A conservative bound: the prompt at its bound (the figure the hold was computed from) plus the bytes received. The receipt marks the tokens <code>estimated</code>.</td></tr>
        <tr><td>The provider failed without producing tokens: a 5xx, a refused or reset connection, a stream that broke before any content, an empty answer with no usage</td><td>Nothing. The next provider is tried; if all fail the answer is <code>502 providers_unavailable</code>.</td></tr>
        <tr><td>The router’s own time limit ran out while a provider had the request</td><td>The prompt bound at that provider’s input price. No other provider is tried, and the answer is <code>504 provider_timeout</code> with a signed receipt.</td></tr>
        <tr><td>You hung up on a stream</td><td>What was generated: the provider’s reported usage when it arrives within 15 seconds, otherwise the bound over every token the provider sent.</td></tr>
        <tr><td>You left a call that was not streamed</td><td>The call runs to its end and is charged its reported usage.</td></tr>
        <tr><td>An attested-lane answer whose gateway receipt does not show a verified upstream</td><td>The answer is withheld (<code>502 upstream_not_attested</code>). The gateway had already done the work, so the call is charged as usual, and the signed receipt records the verification result.</td></tr>
      </tbody>
    </table>
    <p>Once a day the router compares what each provider is owed with what its calls collected from callers, and with the provider’s invoice where the operator recorded one; a gap raises an alarm for the operator and moves no money. <a className="inline-link" href="#make-good-refunds">Make-good refunds</a>, the rules that return money after the fact, are off by default.</p>
    <h3>Prepaid credits</h3>
    <p>A key's credits live in a <code>trellis_credits</code> account seeded by the key hash (the SHA-256 of the key's public key, shown under Payments). <code>POST /api/v1/credits/deposit-tx</code> with an amount and your wallet address returns one unsigned <code>deposit</code> transaction; your wallet signs it as fee payer and sends it, and the balance is credited once the transaction is finalized, usually seconds. When the key has no owner wallet yet, the same transaction registers your wallet as the key’s owner (the answer names it under <code>owner.registers</code>): the owner can ask for a closure without the key and take any closure of the key back. Send <code>register_owner: false</code> to fund someone else’s key without becoming its owner. A plain USDC transfer to the program or its vault is not a deposit and is not credited; where a router reports <code>solana_pay_transfer</code> in <code>GET /api/v1/credits</code>, the dashboard also shows a Solana Pay code for a wallet app. Deposits are refused above the per-key cap (<code>cap_usdc</code> in <code>GET /api/v1/credits</code>).</p>
    <Code label="Deposit">{depositExample}</Code>
    <p>Credits are spend-only. There is no withdrawal: USDC leaves the vault only as settlement to hosts, as account-closure refunds, and as the sweep of an expired balance to the treasury. Any wallet can top up a key; paying in gives that wallet no control over the key. The smallest deposit is 1 USDC. Under current policy a balance expires 12 months after the last deposit, with a 30-day notice before what is unspent moves to the treasury; expiry is built, not enabled at launch, so a router at launch sends no notice and sweeps nothing. <code>POST /api/v1/credits/close</code> closes the key and returns what is left to the wallets that paid it in; it is paid by the settlement service after a 72-hour delay and a sanctions check of the accounts being paid, not on demand.</p>
    <h3 id="closing">Closing an account</h3>
    <p><strong>Closing gives the money back to the wallets that paid it in.</strong> Each wallet that deposited to the key gets its share of what is left, never more than it put in, in the USDC account it paid from. You do not choose where the refund goes, and neither can anyone else who holds the API key: a key can ask for a closure and take it back, and that is all. A leaked key therefore cannot be used to send your balance to someone else.</p>
    <p>Call <code>POST /api/v1/credits/close</code> with the key as the bearer and <code>{"{"}payer{"}"}</code>, the wallet that will pay the fee. There is no destination field: a request that carries <code>refund_to</code> is refused with <code>400 refund_destination_fixed</code>. The answer lists who will be paid back in <code>refunds</code> (one row per wallet that paid in: <code>depositor</code>, <code>refund_to</code>, <code>deposited_units</code>, <code>refunded_units</code>), so you can read it before anything is sent.</p>
    <p>A closure is authorised by the key itself, and by nothing else: the on-chain <code>close_account</code> instruction must be signed by the key's own ed25519 keypair (the one whose public key hashes to the key hash), so no wallet can close a key, whoever deposited to it. The router signs the transaction as the key from that request (it stores neither the key nor its keypair) and returns it in <code>transaction</code> with <code>signed_by_key: true</code>. <code>payer</code> is any wallet: it adds its signature as fee payer, pays the network fee and a small rent, and sends the transaction before <code>expires_at_block_height</code>. Paying the fee does not make it the destination. Nothing else in the transaction may change, or the key's signature no longer covers it. <code>transaction</code> is <code>null</code> when the closure is already registered on chain. The dashboard does this under Payments with the connected wallet, and shows where the refund goes before the wallet opens; the SDKs have a helper.</p>
    <Code label="Close the account">{closeExample}</Code>
    <Code label="Close from the SDK">{closeSdkExample}</Code>
    <p>From the moment the closure is on chain the key is frozen: any call that would spend answers <code>409</code> with <code>error.type: "credits_closing"</code> and the closure's id in <code>error.metadata.closure</code>, until the refund is paid or the closure is taken back. It is not a transient error, so the SDKs do not retry it; use another key. The refund is what the key had not spent when it is paid, never more than the key's own deposits cover, and it waits for calls still in progress. Refunds are paid within an allowance that refills continuously and is kept apart from the one for host payouts, so a large refund, or many closures at once, can arrive in parts over days (<code>refund_rate_limited</code>). Over any 24 hours the allowance is a share (20% today) of the lowest balance the vault has had in the last 24 hours, never more than an absolute cap (25,000 USDC by default) and never less than 1,000 USDC, with a quarter of it available at once. A pause of deposits or settlements does not stop a closure, its cancellation or its refund.</p>
    <h4 id="closing-cancel">Taking a closure back</h4>
    <p>Until the refund starts being paid you can change your mind. <code>POST /api/v1/credits/close/cancel</code> with <code>{"{"}payer{"}"}</code> returns a <code>cancel_close</code> transaction already signed by the key; the payer wallet signs and sends it as for the closure, and once it lands the key is open again with its balance. With no closure on chain the answer is <code>400 nothing_to_cancel</code>; once a payment has been sent it is <code>409 refund_in_progress</code>. Who can take a closure back: whoever asked for it, or the key&rsquo;s registered owner wallet. The key itself can do it once in 60 days (after that <code>409 cancel_cooldown</code>), so two holders of one key cannot keep cancelling each other; a wallet that merely deposited to the key has no say. Register an owner wallet with <code>POST /api/v1/credits/owner-tx</code> (signed by the key and by the wallet) when you create the key: the owner can close with <code>as_owner</code>, and a closure asked for that way cannot be cancelled with the API key.</p>
    <Code label="Take a closure back">{cancelExample}</Code>
    <h4 id="closing-hold">Disabling a key puts its closure on hold</h4>
    <p>If a key is disabled or revoked (<code>DELETE /api/v1/keys/{"{hash}"}</code>), a closure it started is not paid. This is what you want when a key has leaked: revoking it also stops the closure someone may have asked for with it. The answer to the revocation says so in <code>data.closure_held</code>, and the closure is listed with <code>reason: "key_disabled"</code>. When the closure was your own and you want it to go ahead, an owner or admin of the account releases it with <code>POST /api/v1/credits/close/release</code> and the hash of the key. The refund still goes only to the wallets that paid in.</p>
    <Code label="Release a held closure">{releaseExample}</Code>
    <h4 id="closing-destination">Sending your share to another wallet</h4>
    <p>A wallet that paid in can name another wallet to receive its own share, for example because the first one is being retired. Only that wallet can do it, with its own signature: <code>POST /api/v1/credits/refund-destination-tx</code> with <code>{"{"}depositor, refund_to{"}"}</code> returns an unsigned <code>set_refund_destination</code> transaction for the depositor's wallet to sign and send. The API key is not part of that transaction and cannot make this change. It moves no money; it only says where that wallet's share of a later refund is sent. A wallet that never deposited to the key gets <code>404</code>.</p>
    <Code label="Move your own refund destination">{refundDestinationExample}</Code>
    <p><code>GET /api/v1/credits/close</code> lists the key's closures and their state: <code>queued</code> (prepared, not on chain yet), <code>registered</code> (on chain, waiting), <code>paid</code>, <code>refused</code>, <code>failed</code> or <code>cancelled</code>. Each row has <code>refunds</code> (one payment per wallet that paid in, with its account, the wallet that owns that account, the amount and whether it has been sent), <code>refund_to</code> (the wallets paid so far) and, while it waits, a <code>reason</code>: <code>key_disabled</code> (on hold), <code>refund_rate_limited</code> (paid in parts), <code>refund_destination_unavailable</code> (a wallet's account cannot receive right now), <code>refund_work_capped</code> (many wallets, paid a few per run, largest share first) or <code>depositors_unknown</code>. A refund is split over the wallets that paid in largest remaining share first. A payment line marked <code>reversed</code> was prepared and then not sent because the closure was taken back on chain; its amount is back on the balance.</p>
    <h3>Per call (x402)</h3>
    <p>A request without credits can carry an x402 payment: the <code>exact</code> scheme pays the call's price from your wallet, the <code>tab</code> scheme pays from an open <a className="inline-link" href="#tabs">tab</a>. Both are verified and settled by the <a className="inline-link" href="#facilitator">facilitator</a>.</p>
    <p id="per-call-cost">The quote in the 402 (<code>accepts[0].maxAmountRequired</code>, also <code>price_usdc</code>) is what the payment must carry. With the <code>exact</code> scheme the router pays the Solana network fee of your payment and passes it on at cost: the quote adds the most that fee can be (<code>network_fee_max_usdc</code>, 0.005 USDC at the default settings), and what is kept is the fee of your transaction as you signed it, converted at the router&rsquo;s stated SOL price, with no margin on top. The receipt shows it as its own line (<code>network_fee</code>: lamports, USDC, the SOL price used). No quote is below the minimum payment (0.03 USDC by default); everything but the fee is credited to your wallet, and what the call does not use stays there as change for later calls (spend-only). Sponsored payments are limited per wallet, per source address and in total; past a limit the answer is <code>429 rate_limited</code>, and you can always send the USDC transfer yourself and present its signature with <code>X-Wallet-Auth</code>. A wallet whose sponsored payment failed after it was sent is not sponsored again for 30 days (<code>403 payer_not_sponsored</code>). The network fee is cost recovery, not a markup: <code>GET /api/v1/status</code> reports, under <code>per_call.x402.network_fees</code>, the lamports the router paid beside the USDC it recovered over the last 30 days.</p>
    <p>An <code>exact</code> payment is one transaction you build and sign with the router's fee payer (<code>extra.feePayer</code> in the 402) as its fee payer: one USDC <code>TransferChecked</code> to the <code>payTo</code> token account, sent base64 in <code>X-PAYMENT</code>. The fee payer co-signs only inside fixed bounds, and refuses anything else before it signs: exactly two signatures (the fee payer's and yours); the fee payer named in no instruction; at most one <code>SetComputeUnitLimit</code> (200,000 units or fewer) and one <code>SetComputeUnitPrice</code> (5,000,000 micro-lamports or fewer) with a priority fee of at most 10,000 lamports; and, when <code>payTo</code>'s token account does not exist yet, at most one idempotent creation of it paid for by you, never by the fee payer. The SDKs build payments inside these bounds and refuse options that would leave them.</p>
    <p>A transaction signature alone is not a payment claim. If you paid the transfer yourself and present its signature in <code>X-PAYMENT</code> instead of a signed payload, the request must also carry <code>X-Wallet-Auth</code> (below) from the wallet that paid; a landed transaction is public, so without it the answer is <code>401 payment_not_bound_to_caller</code> and nothing is credited. The same header spends the change an earlier payment left on the wallet's account.</p>
    <h3 id="wallet-sign-in">Wallet sign-in</h3>
    <p>A wallet gets an API key of its own account by signing one message. <code>POST /api/v1/auth/wallet/challenge</code> returns a one-time <code>nonce</code> and the exact <code>message</code> to sign: a Sign-In-With-Solana text that names the router's domain and URI, the wallet's address, the network, the nonce and a five-minute validity. The wallet signs those UTF-8 bytes as returned, and <code>POST /api/v1/auth/wallet</code> exchanges the signature for the key. The router verifies the signature over the message it issued and over nothing else; a client-built text, including the earlier <code>trellis:wallet:v1</code> form that named no site, does not sign in. Before signing, check that <code>domain</code> is the router you are talking to and that the message names your own address: a challenge relayed from another site names that site. The dashboard and the SDKs make that check and refuse otherwise.</p>
    <Code label="Sign in with a wallet">{signInExample}</Code>
    <h3 id="wallet-auth">Wallet-signed requests (X-Wallet-Auth)</h3>
    <p>Some requests are authorised by a wallet's signature instead of a key: spending the change of a per-call payment, presenting a landed payment, a holder's vote, a host operator's signup and its own host record. They carry <code>X-Wallet-Auth: &lt;base58 address&gt;:&lt;unixSeconds&gt;:&lt;base58 signature&gt;</code>, the signature being the wallet's ed25519 signature over six lines joined by line feeds, with no trailing one:</p>
    <Code label="What the wallet signs">{walletAuthExample}</Code>
    <p>The method is in upper case. The host is the router's public host as it is configured (with its port, if it has one), in lower case: the same value the sign-in challenge calls <code>domain</code>. The path is the request's path with its query string, as sent. The last line is the SHA-256 of what the route binds: for the chat routes, the canonical JSON (keys sorted, no whitespace) of the body without <code>stream</code> and <code>stream_options</code>; for other JSON routes, the canonical JSON of the body; for a GET, the empty string; for <code>GET /api/v1/hosts/{"{id}"}</code>, the string <code>GET /api/v1/hosts/{"{id}"}</code>. A signature is valid for five minutes and for one use, and only for that method, that path and that router: the earlier message, <code>trellis:&lt;unixSeconds&gt;:&lt;sha256&gt;</code>, named none of them and is no longer accepted.</p>
    <h3 id="payments-blind-tokens">Blind tokens</h3><NotAtLaunch>The BLIND lane and its tokens are not served on the core launch surface.</NotAtLaunch>
    <p>On the BLIND lane a call is paid with a blind-signed single-use token (RSA blind signatures, Privacy Pass style) of a fixed denomination: the mint signs a blinded message, so the payment cannot be linked to the call. Tokens are bearer instruments of small fixed denominations redeemable only for inference; a call may cost at most the token's value. The <a className="inline-link" href="/tokens/">private tokens page</a> runs the purchase in your browser.</p>
    <h3 id="payments-pay-with">Pay with a tokenized stock</h3><NotAtLaunch>On the core launch surface a request that carries X-Pay-With is answered 404 not_enabled.</NotAtLaunch>
    <p>A call that names a token mint in <code>X-Pay-With</code> is paid by an exact-out swap of that token for the USDC it costs, signed by a Swig session key with a per-day cap and batched until at least $1 or 24 hours; the fill must be within 1% of the oracle value, and a token whose Scaled UI Amount multiplier changed in the last 24 hours falls back to credits. A failed swap falls back to prepaid credits, then to 402. The dashboard keeps the mint preference per key under Payments; the SDKs open the session.</p>
    <h3 id="payments-byok">Bring your own key</h3><NotAtLaunch>Stored provider keys are not served on the core launch surface.</NotAtLaunch>
    <p>A stored upstream provider key (<code>POST /api/v1/byok</code>) is used for calls routed to that provider and billed by the provider, not by Trellis.</p>
  </section>;
}
