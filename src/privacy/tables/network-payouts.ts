import type { TableDoc } from "../types.ts";
import { CREATED, KEPT_APPEND } from "./common.ts";
export const networkPayoutTables: Record<string, TableDoc> = {
  network_fee_ledger: {
    category: "billing", purpose: "Network host payouts from confirmed per-host receipt roots, grouped in the UTC hour when they accrue. Gross and fee are pico-USD; the fee is zero unless NETWORK_FEE_BPS is set, and net is invoiced through settlements. The ledger is accounting only: nothing is swapped, bought or burned with a fee.", request: "aggregate", retention: KEPT_APPEND,
    notes: ["No request text, caller address, log field or Redis key is read or stored for this ledger. Payouts are not switched on yet."],
    columns: { id: "Provider and accrual-hour identifier.", provider_id: "The host owed a net payout.", period: "UTC hour when anchored receipts accrue, which may follow the served hour.", gross_pico: "Sum of upstream_cost for eligible linked generations, before the network fee.", fee_pico: "Floor of gross times configured basis points divided by 10000.", created_at: CREATED },
  },
  network_receipt_links: {
    category: "receipts", purpose: "Links a router generation to a sidecar receipt ID from the response header, so only work included in that host's confirmed root can be invoiced. The collected leaf's signature is checked by host-anchor. Each sidecar receipt may be linked once per provider.", request: "yes", retention: KEPT_APPEND,
    columns: { generation_id: "Router generation ID; no prompt or response bytes.", provider_id: "Provider that served the call.", receipt_id: "Strict rcpt_ identifier from the upstream response header, not caller-provided text.", accrued_period: "Null until included in a network invoice; then the UTC accrual hour preventing repeated accrual." },
  },
  network_payout_dispatch: {
    category: "chain", purpose: "Durable signed USDC transfer for a network payout. Written before broadcasting so recovery sends identical bytes and cannot pay again using another nonce.", request: "no", retention: KEPT_APPEND,
    notes: ["The signed transaction can authorize only its encoded transfer, but replaying it before inclusion broadcasts that transfer. It is encrypted with APP_SECRET and never exposed by public APIs. No private signing key is stored here. Reverted, destination-changed or nonce-conflicted transfers require operator reconciliation."],
    columns: { payout_id: "The payout whose claimed invoices this transfer settles.", signed_tx_enc: "Encrypted serialized signed blockchain transfer: chain, nonce, USDC contract, destination, amount and fees; no inference text or signing key.", tx_hash: "Hash of the signed transfer, fixed before first broadcast." },
  },
};
