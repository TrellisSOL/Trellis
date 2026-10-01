import type { ExternalDoc, TableDoc } from "./types.ts";
import { CREATED, KEPT, UPDATED, rv } from "./tables/common.ts";

// What the hosted x402 facilitator (src/solana/facilitator.ts: `exact` and `tab` schemes on Solana; the router's own
// per-call settlements share the table) keeps. It relays payments between other people's wallets, so it stores public chain facts (addresses, amounts,
// transaction signatures) and seller listings, and no request text.

export const facilitatorTables: Record<string, TableDoc> = {
  facilitator_sellers: {
    category: "operations",
    request: "no",
    purpose: "Sellers who opted in to the facilitator's discovery index: the paid URL, a price hint, an output schema and tags, each listing signed by the seller's payTo key. Shown publicly at /facilitator/discovery.",
    retention: "Kept until the seller replaces it with a later signed listing; listed false hides it from discovery. No job removes rows.",
    columns: {
      id: "Random listing identifier (fsl_ followed by 24 hex characters).",
      pay_to: "Base58 wallet address the seller is paid at, which signed the listing. Public in every 402 response the seller sends.",
      resource: "The seller's paid https URL as signed. The first payTo to list a URL owns that entry.",
      price_hint: "Price the seller states, in USDC base units; the seller's own 402 response stays authoritative.",
      result_schema: { purpose: "JSON schema the seller published for its endpoint's result (x402 outputSchema), as signed.", review: rv(["type:json"], "config", "Seller-written description of a public endpoint's output shape; it is the seller's own listing, never a caller's request.") },
      tags: "Up to ten lowercase words the seller chose for search.",
      listed: "Whether the listing shows in discovery.",
      signature: "The payTo key's ed25519 signature over the listing.",
      signed_at: "issuedAt of the stored signature; only a later signature replaces the listing.",
      created_at: CREATED,
      updated_at: UPDATED,
    },
  },
  facilitator_settlements: {
    category: "chain",
    request: "yes",
    purpose: "One row per facilitator settle that passed verification: the payer's signed USDC transfer submitted straight to the seller's payTo (or to the treasury for a fee float top-up). (payer, nonce) is the durable claim on a payment, so the same one is never settled twice.",
    retention: KEPT,
    notes: ["Payer, payTo, amount, nonce and transaction signature are the same facts the public chain shows for the transfer. Payers are not screened: the facilitator never holds the funds it relays."],
    columns: {
      id: "Random settlement identifier (fst_ followed by 24 hex characters); also the receipt id.",
      kind: "payment, or gas_float for a seller's fee float top-up.",
      scheme: "x402 scheme of the payment: exact (a signed USDC transfer) or tab (a trellis_tab voucher).",
      payer: "Base58 wallet address that signed the payment.",
      pay_to: "Base58 wallet address the USDC went to.",
      value: "USDC base units transferred.",
      nonce: "The payment's nonce: the payer's signature over the transaction (exact) or the voucher (tab), base64.",
      tx_hash: "Submitted transaction signature (base58), once settled.",
      status: "verified (claimed, submission in flight), settled or failed.",
      error: { purpose: "A fixed x402 error reason for a failed submission (settle_transaction_failed, ..._blockhash_expired).", review: rv(["name:content"], "no-request-content", "A fixed code written by the facilitator code, never chain error text, a request or an answer.") },
      seller_id: "Listing the payment belongs to, when the payTo has one.",
      x402_version: "x402 protocol version of the payment, 1 or 2.",
      fee_value: "USDC base units of the facilitator fee transfer, when a fee is charged.",
      fee_tx_hash: "Transaction signature of the fee transfer.",
      gas_debit: "USDC base units recovered for the transaction fee: on a per-call payment to this router, the network fee passed through at cost; on a hosted settlement for another seller, 0 (the relay pays the fee and recovers nothing).",
      fee_lamports: "Lamports the fee payer was charged for this transaction: on a settled per-call payment what gas_debit recovers at cost, on one that failed on chain what was paid for nothing. A number; it names nobody.",
      settled_at: "When the transaction landed and the receipt was signed.",
      receipt_cose: "The signed receipt (base64 COSE_Sign1): network, asset, transaction, amount, payTo and fee. It names no payer.",
      receipt_leaf: "The receipt's leaf hash in the hourly anchoring tree.",
      receipt_key_id: "Receipt signing key id.",
      anchor_index: "Anchor (Merkle root) this receipt was included in, once rooted.",
      leaf_index: "Position of the receipt's leaf in that anchor's tree.",
      created_at: CREATED,
    },
  },
  seller_gas_floats: {
    category: "billing",
    request: "aggregate",
    purpose: "USDC a seller prepaid to the treasury so the facilitator settles its payments below the minimum; each such settle is debited at its measured transaction fee times a buffer.",
    retention: KEPT,
    columns: {
      seller_id: "The listing the float belongs to.",
      balance: "USDC base units left.",
      funded: "USDC base units paid in, in total.",
      debited: "USDC base units taken for fees, in total.",
      updated_at: UPDATED,
    },
  },
};

/** The facilitator's verify and settle routes read one JSON body: an x402 payment and the seller's requirements. */
export const facilitatorBodyReader: ExternalDoc["bodyReaders"][number] = {
  file: "src/solana/facilitator.ts", carries: "payment-or-signature",
  reads: "The x402 { x402Version, paymentPayload, paymentRequirements } envelope: a payer-signed Solana transaction (exact) or a signed tab voucher, and the seller's payTo, asset, amount and network. No prompt, answer or caller text.",
  then: "Decodes and checks the payment against the requirements (fee payer, single USDC transfer or voucher, amount, freshness); settle co-signs as fee payer and submits it. Nothing is read beyond the envelope.",
  kept: "facilitator_settlements rows: payer and payTo addresses, amount, the payer's signature as nonce, the transaction signature, status and a fixed error code. The transaction bytes themselves are not stored.",
  evidence: [{ file: "src/solana/facilitator.ts", contains: "j = await c.req.json()" }],
};
