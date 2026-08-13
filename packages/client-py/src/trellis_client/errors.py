from __future__ import annotations

from typing import Any

from .types import ProviderVerification, ReceiptVerification


class TrellisError(Exception):
    """``code`` is the router's ``error.type`` (or a client-side reason such as ``bad_options``), ``status`` the HTTP
    status and ``details`` the error's metadata. The credits refusals are told apart by ``code`` (constants in
    ``trellis_client.solana``): ``credits_closing`` (409, its own class below), ``refund_destination_fixed`` (400, a
    closure request that names a destination; this client never sends one), ``nothing_to_cancel`` (400),
    ``refund_in_progress`` (409) and ``not_found`` (404)."""

    def __init__(self, message: str, code: str, status: int | None = None, details: Any = None):
        super().__init__(message)
        self.code = code
        self.status = status
        self.details = details


class CreditsClosing(TrellisError):
    """409 ``credits_closing``: this key's credits closure is registered, so the key is frozen until the refund is
    paid and cannot start new spending. Not retryable: use another key. ``closure`` is the closure's id."""

    def __init__(self, message: str, status: int = 409, details: Any = None):
        super().__init__(message, "credits_closing", status, details)
        self.closure = details.get("closure") if isinstance(details, dict) else None


class PaymentNotBound(TrellisError):
    """401 (or 402) ``payment_not_bound_to_caller``: ``X-PAYMENT`` carried the bare signature of a landed payment
    without ``X-Wallet-Auth`` from the wallet that paid, over the same request. Present it with
    ``trellis_client.solana.with_payment_signature``, or pay with a signed x402 payload. ``tx`` is the signature
    presented."""

    def __init__(self, message: str, status: int = 401, details: Any = None):
        super().__init__(message, "payment_not_bound_to_caller", status, details)
        self.tx = details.get("tx") if isinstance(details, dict) else None


class AttestationRefused(TrellisError):
    """Raised before anything is sent: the provider could not be verified. ``verification.checks`` says which check failed."""

    def __init__(self, verification: ProviderVerification):
        super().__init__(
            f"Refusing to send: provider {verification.provider_id} is not verified. " + " ".join(verification.failures),
            "attestation_refused",
            None,
            verification.failures,
        )
        self.verification = verification


class ReceiptInvalid(TrellisError):
    def __init__(self, verification: ReceiptVerification):
        super().__init__("The receipt on this response did not verify.", "receipt_invalid", None, [c for c in verification.checks if c.status == "fail"])
        self.verification = verification
