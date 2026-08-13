"""An OpenAI-compatible chat call to an Trellis router, with receipts verified and, for attested providers, the
provider verified before anything is sent."""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any

import httpx

from .attestation import fetch_router_attestation, verify_provider
from .errors import TrellisError, AttestationRefused, ReceiptInvalid
from .agent import AgentClient
from .playbooks import PlaybookClient
from .agent_errors import request_error
from .receipts import fetch_receipt_keys, verify_receipt
from .solana import as_signer, cancel_close_body, close_credits_body, deposit_tx_body, refund_destination_tx_body, release_close_body, wallet_auth_header, wallet_sign_in_body
from .types import ExpectedDigests, ProviderVerification, ReceiptVerification

_DISCLOSURE_RANK = {"any": 0, "policy": 1, "none": 2}
_LANE_RANK = {"public": 0, "attested": 1, "unlinkable": 2}


def _stricter(rank: dict[str, int], existing: Any, wanted: str | None) -> str | None:
    known = isinstance(existing, str) and existing in rank
    if wanted is None:
        return existing if known else None
    return existing if known and rank[existing] > rank[wanted] else wanted


def routing_headers(disclosure: str | None = None, lane: str | None = None) -> dict[str, str]:
    return {**({"x-trellis-disclosure-max": disclosure} if disclosure else {}), **({"x-trellis-lane": lane} if lane else {})}


def with_routing(body: dict[str, Any], *, disclosure: str | None = None, lane: str | None = None, only: list[str] | None = None, allow_fallbacks: bool | None = None) -> dict[str, Any]:
    """Merge routing options into ``body["provider"]`` without loosening what the caller already set. The unlinkable
    lane is passed through unchanged; the router refuses it."""
    provider = dict(body.get("provider") or {})
    d = _stricter(_DISCLOSURE_RANK, provider.get("disclosure"), disclosure)
    ln = _stricter(_LANE_RANK, provider.get("lane"), lane)
    if d:
        provider["disclosure"] = d
    if ln:
        provider["lane"] = ln
    if only is not None:
        provider["only"] = only
    if allow_fallbacks is not None:
        provider["allow_fallbacks"] = allow_fallbacks
    return {**body, "provider": provider} if provider else body


@dataclass
class AttestedOptions:
    provider_id: str
    attest_url: str
    expected: ExpectedDigests | None = None
    fresh_nonce: bool = True
    allow_simulated: bool = False
    require_certificate: bool = False
    max_attestation_age_ms: float = 3_600_000
    certificate: bytes | str | None = None
    quote_verifier: Any = None
    cache_seconds: float = 60
    attest_http: httpx.Client | None = None
    extra: dict[str, Any] = field(default_factory=dict)


class Trellis:
    def __init__(
        self,
        base_url: str,
        api_key: str | None = None,
        *,
        private_token: str | None = None,
        http: httpx.Client | None = None,
        headers: dict[str, str] | None = None,
        disclosure: str | None = None,
        lane: str | None = None,
        verify_receipts: bool = True,
        strict_receipts: bool = False,
        receipt_keys: list[dict[str, Any]] | None = None,
        now_ms: Any = None,
    ) -> None:
        if not base_url:
            raise TrellisError("base_url is required", "bad_options")
        self.base_url = base_url.rstrip("/")
        self._own_http = http is None
        self._http = http or httpx.Client(timeout=60)
        self._api_key = api_key
        self._private_token = private_token
        self._headers = headers or {}
        self._disclosure = disclosure
        self._lane = lane
        self._verify_receipts = verify_receipts
        self._strict = strict_receipts
        self._pinned = receipt_keys
        self._keys = receipt_keys
        self._now_ms = now_ms
        self.agent = AgentClient(self.base_url, self._http, lambda: {**self._headers, **self._auth()})
        self.playbooks = PlaybookClient(self.base_url, self._http, lambda: {**self._headers, **self._auth()})
        self._verified: dict[str, tuple[float, ProviderVerification]] = {}

    def close(self) -> None:
        if self._own_http:
            self._http.close()

    def __enter__(self) -> "Trellis":
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    def with_private_token(self, token: str) -> "Trellis":
        """A copy that authenticates with a blind token instead of an API key."""
        return Trellis(self.base_url, None, private_token=token, http=self._http, headers=self._headers, disclosure=self._disclosure, lane=self._lane, verify_receipts=self._verify_receipts, strict_receipts=self._strict, receipt_keys=self._pinned, now_ms=self._now_ms)

    def _auth(self) -> dict[str, str]:
        if self._private_token:
            return {"authorization": f"PrivateToken token={self._private_token}"}
        return {"authorization": f"Bearer {self._api_key}"} if self._api_key else {}

    # ---- receipts -------------------------------------------------------------------------------------------------

    def receipt_keys(self, refresh: bool = False) -> list[dict[str, Any]]:
        if self._pinned is not None:
            return self._pinned
        if self._keys is None or refresh:
            self._keys = fetch_receipt_keys(self.base_url, self._http)
        return self._keys

    def verify_receipt(self, receipt: dict[str, Any]) -> ReceiptVerification:
        """Verify against the router's keys, re-reading the key set once when the key id is unknown (rotation)."""
        keys = self.receipt_keys()
        if self._pinned is None and not any(k.get("kid") == receipt.get("key_id") for k in keys):
            keys = self.receipt_keys(refresh=True)
        return verify_receipt(receipt, keys=keys)

    def get_receipt(self, receipt_id: str) -> dict[str, Any]:
        res = self._http.get(f"{self.base_url}/api/v1/receipts/{receipt_id}", headers={"accept": "application/json"})
        if res.status_code != 200:
            raise TrellisError(f"receipt lookup failed with {res.status_code}", "receipt_lookup_failed", res.status_code)
        return res.json()["data"]

    # ---- attestation ----------------------------------------------------------------------------------------------

    def attestation(self, provider_id: str) -> dict[str, Any] | None:
        return fetch_router_attestation(self.base_url, provider_id, self._http)

    def verify_provider(self, opts: AttestedOptions) -> ProviderVerification:
        """Check a provider now (no caching). Never raises for a bad provider: read ``.ok`` and ``.checks``."""
        return verify_provider(
            router_url=self.base_url,
            provider_id=opts.provider_id,
            attest_url=opts.attest_url,
            http=self._http,
            attest_http=opts.attest_http,
            fresh_nonce=opts.fresh_nonce,
            certificate=opts.certificate,
            expected=opts.expected,
            allow_simulated=opts.allow_simulated,
            require_certificate=opts.require_certificate,
            max_attestation_age_ms=opts.max_attestation_age_ms,
            quote_verifier=opts.quote_verifier,
            now_ms=self._now_ms() if self._now_ms else None,
            **opts.extra,
        )

    def _clock(self) -> float:
        return self._now_ms() / 1000 if self._now_ms else time.time()

    def _attest(self, opts: AttestedOptions) -> ProviderVerification:
        key = f"{opts.provider_id}|{opts.attest_url}"
        hit = self._verified.get(key)
        if hit and opts.cache_seconds > 0 and self._clock() - hit[0] < opts.cache_seconds:
            return hit[1]
        v = self.verify_provider(opts)
        if not v.ok:
            self._verified.pop(key, None)
            raise AttestationRefused(v)
        self._verified[key] = (self._clock(), v)
        return v

    # ---- Solana credits and wallets ---------------------------------------------------------------------------------

    def _json(self, method: str, path: str, body: dict[str, Any] | None = None, ok: tuple[int, ...] = (200, 201), *, auth: bool = True, whole: bool = False) -> Any:
        res = self._http.request(method, f"{self.base_url}{path}", json=body, headers={"accept": "application/json", **({"content-type": "application/json"} if body is not None else {}), **self._headers, **(self._auth() if auth else {})})
        try:
            data = res.json()
        except ValueError:
            data = None
        if res.status_code not in ok or not isinstance(data, dict):
            err = (data or {}).get("error", {}) if isinstance(data, dict) else {}
            raise request_error(err.get("message") or f"{method} {path} failed with {res.status_code}", err.get("type") or "request_failed", res.status_code, err.get("metadata"))
        return data if whole else data.get("data")

    # A closure names no destination: what is left returns to the wallets that deposited to the key, each at most what
    # it put in, to the token account that wallet named on chain (by default the one it paid from). The API key cannot
    # choose or change that; only a depositor can move its own refund destination, with its own wallet.

    def deposit_tx(self, amount: Any, payer: Any) -> dict[str, Any]:
        """``POST /api/v1/credits/deposit-tx``: an unsigned deposit transaction (``transaction`` base64, fee payer =
        ``payer``) for ``amount`` USDC (a decimal string; an ``int`` is base units). The wallet signs and sends it
        (``solana.sign_transaction(deposit["transaction"], wallet)``); the key is credited once it is finalized.
        Fields: ``transaction``, ``message``, ``network``, ``amount_usdc``, ``amount_units``, ``accounts``
        (``credit``, ``vault``, ``depositorToken``, ``share``: the on-chain record of what this wallet put into the
        key), ``refund_to`` (the token account a closure refund of this deposit returns to: the one it is paid from),
        ``expires_at_block_height``, ``key_hash``, ``note``."""
        return self._json("POST", "/api/v1/credits/deposit-tx", deposit_tx_body(amount, payer))

    def close_credits(self, *args: Any, payer: Any = None, **kwargs: Any) -> dict[str, Any]:
        """``close_credits(*, payer)``: ``POST /api/v1/credits/close`` with ``{"payer": ...}``: queue the closure of
        this key's credits. It must be asked with the key itself. ``payer`` is any wallet: it pays the transaction fee.

        A closure names no destination. The refund returns to the wallets that deposited to the key (``refunds``: one
        row per depositor with ``depositor``, ``refund_to``, ``deposited_units``, ``refunded_units``), after the
        dispute window, and the API key cannot choose or change where it goes. ``refund_to`` is never sent; a
        positional argument (the old ``refund_to`` position), a ``refund_to=`` keyword or a missing ``payer`` raises
        ``solana.SolanaError`` (a ``ValueError``) and nothing is sent.

        ``transaction`` (base64) is one ``close_account`` instruction that already carries the signature of the key's
        own keypair: the ``payer`` wallet adds its signature as fee payer
        (``solana.sign_transaction(closure["transaction"], wallet)``, which keeps the key's signature byte for byte)
        and sends it before ``expires_at_block_height``. ``transaction`` is None when the closure is already
        registered: there is nothing to sign. Fields: ``id``, ``status``, ``payer``, ``authority``, ``payable_at``,
        ``transaction``, ``message``, ``accounts`` (``refundRequest``), ``expires_at_block_height``,
        ``signed_by_key``, ``refunds``, ``note``. Once the closure is on chain the key is frozen: calls that would
        spend raise ``CreditsClosing`` (409 ``credits_closing``); do not retry them. Until anything is paid the
        closure can be taken back with ``cancel_credit_closure``."""
        return self._json("POST", "/api/v1/credits/close", close_credits_body(*args, payer=payer, **kwargs))

    def cancel_credit_closure(self, *, payer: Any) -> dict[str, Any]:
        """``POST /api/v1/credits/close/cancel`` with ``{"payer": ...}``: take a closure back while nothing has been
        paid. Asked with the key itself. ``transaction`` is one ``cancel_close`` instruction already signed by the
        key; the ``payer`` wallet finishes it exactly like the closure
        (``solana.sign_transaction(cancel["transaction"], wallet)``: the payer's signature is added, the key's stays
        byte for byte) and sends it before ``expires_at_block_height``. Once it lands the key is open again with its
        balance. Fields: ``transaction``, ``message``, ``accounts``, ``payer``, ``expires_at_block_height``,
        ``signed_by_key``, ``note``. Refusals (``TrellisError.code``): 400 ``nothing_to_cancel`` (no closure on
        chain), 409 ``refund_in_progress`` (part of the refund has already been paid)."""
        return self._json("POST", "/api/v1/credits/close/cancel", cancel_close_body(payer=payer))

    def release_credit_closure(self, key: str) -> list[dict[str, Any]]:
        """``POST /api/v1/credits/close/release`` with ``{"key": ...}``: let a closure that is on hold go ahead. For
        an owner or admin of the account. Disabling a key (``DELETE /api/v1/keys/{hash}``) puts the closure it
        started on hold (the answer carries ``closure_held``; the closure row shows ``reason: "key_disabled"``), so
        revoking a leaked key stops a closure it began. Releasing changes nothing about where the money goes: it
        still returns only to the wallets that paid in.

        ``key`` is the key's hash (64 hex characters, as ``GET /api/v1/keys`` lists it), not the API key. Anything
        else raises ``solana.SolanaError`` before a request is made, so a secret is never posted as a hash. Returns
        the released closures: ``id``, ``status``, ``released``, ``payable_at``. 404 ``not_found`` when the key has
        no open closure."""
        return self._json("POST", "/api/v1/credits/close/release", release_close_body(key))

    def refund_destination_tx(self, depositor: Any, refund_to: Any) -> dict[str, Any]:
        """``POST /api/v1/credits/refund-destination-tx`` with ``{"depositor": ..., "refund_to": ...}``: an UNSIGNED
        ``set_refund_destination`` transaction that moves where ``depositor``'s share of a closure refund of this key
        goes, to the USDC token account of the wallet ``refund_to``. Only the depositor's own wallet can sign it: it
        is the fee payer and the only signer (``solana.sign_transaction(change["transaction"], depositor_wallet)``;
        any other wallet is refused there). The API key signs nothing and is not in the transaction. It moves nothing
        now. Fields: ``transaction``, ``message``, ``accounts`` (``share``, ``refundToToken``), ``depositor``,
        ``refund_to``, ``current_refund_to``, ``expires_at_block_height``, ``note``. 404 ``not_found`` when that
        wallet never deposited to this key."""
        return self._json("POST", "/api/v1/credits/refund-destination-tx", refund_destination_tx_body(depositor, refund_to))

    def credit_closures(self) -> list[dict[str, Any]]:
        """``GET /api/v1/credits/close``: this key's closure requests, newest first. Each row: ``id``, ``status``
        (``solana.CLOSURE_STATUSES``: queued, registered, paid, refused, failed, cancelled), ``reason``
        (``solana.CLOSURE_REASONS``; a queued or registered row with a reason is waiting, not failed, and
        ``key_disabled`` is on hold until ``release_credit_closure``), ``refund_to`` (the wallets paid so far,
        comma-separated, or None), ``refunds`` (the payment plan, one row per depositor: ``depositor``,
        ``refund_to``, ``owner``, ``amount_units``, ``status`` (``solana.REFUND_STATUSES``: planned, paid, refused),
        ``reason``, ``tx``), ``amount_units``, ``requested_at``, ``payable_at``, ``paid_at``, ``register_tx``,
        ``pay_tx``, ``cancel_tx``, ``released_at``."""
        return self._json("GET", "/api/v1/credits/close")

    @staticmethod
    def wallet_auth_header(signer: Any, method: str, url: Any, body: Any = None, *, host: str | None = None, timestamp: int | None = None) -> str:
        """The ``X-Wallet-Auth`` value for one request (its method, its full URL and the JSON body it sends), signed
        by the wallet ``signer``: it lets a wallet spend its per-call change without an API key. ``host`` is the
        router's public host[:port] when it differs from the URL's. To sign an ``httpx.Request`` you built, use
        ``solana.with_wallet_auth(request, signer)``. See ``trellis_client.solana.wallet_auth_header``."""
        return wallet_auth_header(signer, method, url, body, host=host, timestamp=timestamp)

    def wallet_sign_in(self, signer: Any, *, name: str | None = None, expected_domain: str | None = None) -> dict[str, Any]:
        """Sign in with a wallet: fetch a challenge (``POST /api/v1/auth/wallet/challenge``), check it, sign its
        ``message`` exactly as returned and post it (``POST /api/v1/auth/wallet``). The answer holds the new API key
        in ``key`` (shown once) and its record in ``data``.

        Nothing is signed unless the challenge is this router's own: its ``domain`` must be the host[:port] of this
        client's ``base_url`` (or ``expected_domain``, the router's public host, when you reach it under another
        name), and the message must name that domain and the signer's own address. Otherwise ``solana.SolanaError``
        is raised and nothing is posted. This client's API key is not sent."""
        wallet = as_signer(signer)
        challenge = self._json("POST", "/api/v1/auth/wallet/challenge", {"address": wallet.address}, auth=False)
        body = wallet_sign_in_body(wallet, challenge if isinstance(challenge, dict) else {}, expected_domain or self.base_url, name=name)
        return self._json("POST", "/api/v1/auth/wallet", body, auth=False, whole=True)

    # ---- chat -----------------------------------------------------------------------------------------------------

    def chat(
        self,
        body: dict[str, Any],
        *,
        disclosure: str | None = None,
        lane: str | None = None,
        attested: AttestedOptions | None = None,
        headers: dict[str, str] | None = None,
        verify_receipt_on_response: bool | None = None,
    ) -> dict[str, Any]:
        """POST /api/v1/chat/completions. The result is the completion plus an ``trellis`` object holding the receipt,
        its verification and, when ``attested`` was given, the provider verification that ran before the request."""
        if body.get("stream"):
            raise TrellisError("Streaming is not supported by the Python client.", "bad_options")
        d = disclosure or self._disclosure
        ln = lane or self._lane
        routed = with_routing(body, disclosure=d, lane=ln)
        extra = routing_headers(d, ln)
        provider: ProviderVerification | None = None
        if attested is not None:
            provider = self._attest(attested)  # nothing has been sent yet
            routed = with_routing(routed, disclosure="none", lane="attested", only=[attested.provider_id], allow_fallbacks=False)
            extra = {**extra, **routing_headers("none", "attested")}
        res = self._http.post(f"{self.base_url}/api/v1/chat/completions", json=routed, headers={"content-type": "application/json", **self._headers, **self._auth(), **extra, **(headers or {})})
        try:
            data = res.json()
        except ValueError:
            data = None
        if res.status_code != 200 or not isinstance(data, dict):
            err = (data or {}).get("error", {}) if isinstance(data, dict) else {}
            raise request_error(err.get("message") or f"chat request failed with {res.status_code}", err.get("type") or "request_failed", res.status_code, err.get("metadata"))
        receipt = data.get("receipt")
        verification: ReceiptVerification | None = None
        if receipt and (verify_receipt_on_response if verify_receipt_on_response is not None else self._verify_receipts):
            verification = self.verify_receipt(receipt)
            if not verification.valid and self._strict:
                raise ReceiptInvalid(verification)
        data["trellis"] = {
            "generation_id": res.headers.get("x-generation-id"),
            "disclosure": res.headers.get("x-trellis-disclosure"),
            "lane": res.headers.get("x-trellis-lane"),
            "receipt": receipt,
            "receipt_verification": verification,
            "provider": provider,
            "served_by_verified_provider": (receipt.get("payload", {}).get("provider") == provider.provider_id) if provider and receipt else None,
        }
        return data
