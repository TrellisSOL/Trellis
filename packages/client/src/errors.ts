import type { ProviderVerification } from "./attestation.js";
import type { ReceiptVerification } from "./receipts.js";

export class TrellisError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status?: number,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "TrellisError";
  }
}

/**
 * The router's code for a key whose credits are being closed: once the closure is registered on chain the key is
 * frozen, and anything that would spend answers 409 with this code (`details.closure` names the closure) until the
 * refund is paid. It is not a transient failure: do not retry with the same key.
 */
export const CREDITS_CLOSING = "credits_closing";
export const isCreditsClosing = (e: unknown): e is TrellisError => e instanceof TrellisError && e.code === CREDITS_CLOSING;
/**
 * The router's code (400) for a closure request that names a destination. A closure names none: what is left returns
 * to the wallets that deposited to the key, and the API key cannot choose or change that. The client throws the same
 * code before sending when it is handed a destination, so an older call fails here instead of being misread.
 */
export const REFUND_DESTINATION_FIXED = "refund_destination_fixed";
/** The router's code (400) when a key has no closure on chain to take back. */
export const NOTHING_TO_CANCEL = "nothing_to_cancel";
/** The router's code (409) when a closure has already been paid in part or in full: it can no longer be cancelled. Not retryable. */
export const REFUND_IN_PROGRESS = "refund_in_progress";
/**
 * The router's code for a transaction signature presented in `X-PAYMENT` without `X-Wallet-Auth` from the wallet that
 * paid (401): send both (`landedPaymentHeaders`), or pay with a signed x402 payload.
 */
export const PAYMENT_NOT_BOUND = "payment_not_bound_to_caller";

/** Thrown before anything is sent: the provider could not be verified. `verification.checks` says which check failed. */
export class AttestationRefused extends TrellisError {
  constructor(readonly verification: ProviderVerification) {
    super(`Refusing to send: provider ${verification.providerId} is not verified. ${verification.failures.join(" ")}`.trim(), "attestation_refused", undefined, verification.failures);
    this.name = "AttestationRefused";
  }
}

export class ReceiptInvalid extends TrellisError {
  constructor(readonly verification: ReceiptVerification) {
    super("The receipt on this response did not verify.", "receipt_invalid", undefined, verification.checks.filter((c) => c.status === "fail"));
    this.name = "ReceiptInvalid";
  }
}
