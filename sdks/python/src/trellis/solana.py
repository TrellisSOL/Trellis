"""Solana payments on Trellis: x402 ``exact`` per-call payments, tabs (session-key vouchers), credits deposit and
closure transactions, wallet sign-in and the ``X-Wallet-Auth`` header.

A credits closure names no destination: what is left returns to the wallets that deposited to the key, and the API key
cannot choose or change that (``close_credits_body`` takes only ``payer=``).

Everything here works with the core dependencies (``httpx``, ``cryptography``): voucher bytes and signatures, header
formats, base58, program-derived addresses, 402 parsing, the ``X-PAYMENT`` encoding, the deposit / close HTTP calls,
and compiling, parsing and signing legacy transactions (accounts in order of first appearance within the usual signer
and writable groups, the order the router's own tooling compiles). ``solders`` is optional: install the ``solana``
extra (``pip install "trellis[solana]"``) to pass a solders ``Keypair`` as a signer or to turn an ``Instruction``
into a solders one (``Instruction.to_solders()``); it is imported lazily, only there.

Wire formats (the router's ``src/solana`` and ``src/lib/wallet-sig.ts``):

* x402 ``exact``: the payer builds a transaction whose fee payer is the requirement's ``extra.feePayer`` with exactly
  one SPL ``TransferChecked`` of USDC to payTo's associated token account (data ``[12, amount u64 LE, 6]``), signs it
  and leaves the fee payer's signature slot zero. The fee payer co-signs only inside fixed bounds: exactly two
  signatures, the fee payer named by no instruction, at most one ``SetComputeUnitLimit`` (at most 200,000) and one
  ``SetComputeUnitPrice`` (at most 5,000,000 micro-lamports, priority fee at most 10,000 lamports), and at most one
  idempotent creation of payTo's token account, funded by the payer. ``X-PAYMENT`` carries base64 JSON
  ``{"x402Version": 1, "scheme": "exact", "network": ..., "payload": {"transaction": <base64>}}``. The bare signature
  of a payment that already landed is accepted in ``X-PAYMENT`` only together with ``X-Wallet-Auth`` from the wallet
  that paid (``with_payment_signature``).
* Tabs: ``open_tab`` escrows a cap of USDC under a fresh session key; every request then carries
  ``X-Trellis-Tab: <tab>`` and ``X-Trellis-Tab-Voucher: <base64 message>.<base64 signature>`` where the message is
  the 110 bytes ``"trellis:tab:voucher:v1" || tab program id (32) || tab (32) || created_at i64 LE ||
  cumulative_used u64 LE || seq u64 LE`` signed by the session key. ``created_at`` is the open tab's
  ``Tab.created_at``, read from the chain after ``open_tab`` lands (``fetch_tab_account``).
* ``X-Wallet-Auth: <address>:<unix seconds>:<base58 signature>`` over
  ``trellis:wallet-auth:v2\n<METHOD>\n<host>\n<path>\n<unix seconds>\n<sha256 hex>``: one request of one router.
* Wallet sign-in: the wallet signs the ``message`` of ``POST /api/v1/auth/wallet/challenge`` exactly as returned,
  after checking that it names the router it is talking to and the wallet's own address.

Addresses are base58 strings; ``bytes`` of length 32 and anything with ``.pubkey()`` (a solders ``Keypair`` or
``Pubkey``) are accepted wherever an address is expected. Amounts are USDC base units (6 decimals) as ``int``.
"""

from __future__ import annotations

import base64
import hashlib
import json
import re
import secrets
import struct
import time
from dataclasses import dataclass, field
from decimal import Decimal, InvalidOperation
from typing import Any, Mapping, Optional, Sequence, Union
from urllib.parse import quote, unquote

import httpx
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey
from cryptography.hazmat.primitives.serialization import Encoding, PrivateFormat, PublicFormat, NoEncryption

try:  # the canonical JSON module of whichever package this file ships in
    from ._canonical import canonical_bytes
except ImportError:
    from .canonical import canonical_bytes

__all__ = [
    "USDC_MINT",
    "USDC_DECIMALS",
    "MAINNET",
    "DEVNET",
    "TOKEN_PROGRAM",
    "TOKEN_2022_PROGRAM",
    "ASSOCIATED_TOKEN_PROGRAM",
    "SYSTEM_PROGRAM",
    "COMPUTE_BUDGET_PROGRAM",
    "TAB_PROGRAM_LOCALNET",
    "PAYMENT_HEADER",
    "PAYMENT_REQUIRED_HEADER",
    "PAYMENT_RESPONSE_HEADERS",
    "TAB_HEADER",
    "TAB_VOUCHER_HEADER",
    "WALLET_AUTH_HEADER",
    "WALLET_AUTH_VERSION",
    "WALLET_SIGN_IN_VERSION",
    "PAYMENT_NOT_BOUND",
    "CREDITS_CLOSING",
    "REFUND_DESTINATION_FIXED",
    "NOTHING_TO_CANCEL",
    "REFUND_IN_PROGRESS",
    "CANCEL_COOLDOWN",
    "NOT_REQUESTER",
    "CLOSURE_STATUSES",
    "CLOSURE_REASONS",
    "CLOSURE_KEY_DISABLED",
    "REFUND_STATUSES",
    "MAX_COMPUTE_UNIT_LIMIT",
    "MAX_COMPUTE_UNIT_PRICE_MICRO_LAMPORTS",
    "MAX_PRIORITY_FEE_LAMPORTS",
    "MAX_TAB_LIFETIME_SECONDS",
    "SolanaError",
    "SoldersMissing",
    "b58encode",
    "b58decode",
    "to_pubkey",
    "to_address",
    "Signer",
    "as_signer",
    "verify_signature",
    "create_program_address",
    "find_program_address",
    "associated_token_address",
    "AccountMeta",
    "Instruction",
    "compile_transaction",
    "ParsedTransaction",
    "parse_transaction",
    "sign_transaction",
    "parse_usdc",
    "format_usdc",
    "PaymentRequirement",
    "PaymentRequired",
    "parse_payment_required",
    "transfer_checked_instruction",
    "create_ata_idempotent_instruction",
    "set_compute_unit_limit_instruction",
    "set_compute_unit_price_instruction",
    "priority_fee_lamports",
    "exact_payment_instructions",
    "build_exact_payment",
    "x402_payment_header",
    "parse_payment_response",
    "with_payment_signature",
    "fetch_blockhash",
    "async_fetch_blockhash",
    "pay_per_call",
    "async_pay_per_call",
    "generate_session_key",
    "tab_config_address",
    "tab_address",
    "tab_escrow_address",
    "tab_enforcer_address",
    "rules_config_address",
    "open_tab_instruction",
    "open_tab_transaction",
    "OpenTab",
    "top_up_instruction",
    "top_up_transaction",
    "reclaim_instruction",
    "reclaim_transaction",
    "TabAccount",
    "decode_tab_account",
    "fetch_tab_account",
    "async_fetch_tab_account",
    "VOUCHER_DOMAIN",
    "VOUCHER_MESSAGE_LEN",
    "voucher_message",
    "sign_voucher",
    "verify_voucher",
    "parse_voucher_header",
    "Voucher",
    "TabSession",
    "router_host",
    "wallet_auth_hash",
    "wallet_auth_message",
    "wallet_auth_header",
    "with_wallet_auth",
    "WalletSignIn",
    "parse_wallet_sign_in_message",
    "check_wallet_challenge",
    "wallet_sign_in_body",
    "deposit_tx_body",
    "close_credits_body",
    "cancel_close_body",
    "release_close_body",
    "refund_destination_tx_body",
]

# ---- constants ---------------------------------------------------------------------------------------------------------

USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
USDC_DECIMALS = 6
MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"
DEVNET = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"
TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
ASSOCIATED_TOKEN_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
SYSTEM_PROGRAM = "11111111111111111111111111111111"
COMPUTE_BUDGET_PROGRAM = "ComputeBudget111111111111111111111111111111"
ED25519_PROGRAM = "Ed25519SigVerify111111111111111111111111111"
INSTRUCTIONS_SYSVAR = "Sysvar1nstructions1111111111111111111111111"
#: The IDL's localnet program id. The live id comes from ``GET /facilitator/supported`` or ``GET /api/v1/status``.
TAB_PROGRAM_LOCALNET = "9ZmEvfrQrZuVXGc4PovskV83KNxVvpFpvSu3K6R9a9tL"

PAYMENT_HEADER = "X-PAYMENT"
PAYMENT_REQUIRED_HEADER = "PAYMENT-REQUIRED"
PAYMENT_RESPONSE_HEADERS = ("X-PAYMENT-RESPONSE", "PAYMENT-RESPONSE")
TAB_HEADER = "X-Trellis-Tab"
TAB_VOUCHER_HEADER = "X-Trellis-Tab-Voucher"
WALLET_AUTH_HEADER = "X-Wallet-Auth"

#: The version line of the ``X-Wallet-Auth`` message. v1 (``trellis:<time>:<sha256>``) is retired: the router refuses it.
WALLET_AUTH_VERSION = "trellis:wallet-auth:v2"
#: The sign-in scheme the challenge route reports. v1 (a client-built ``trellis:wallet:v1`` text) is retired.
WALLET_SIGN_IN_VERSION = "trellis:wallet:v2"

#: ``error.type`` of the 401 (or 402) a bare transaction signature in ``X-PAYMENT`` gets without ``X-Wallet-Auth``
#: from the wallet that paid. Use ``with_payment_signature``.
PAYMENT_NOT_BOUND = "payment_not_bound_to_caller"
#: ``error.type`` of the 409 a key gets once its credits closure is registered: the key is frozen. Never retry it.
CREDITS_CLOSING = "credits_closing"
#: ``error.type`` of the 400 a closure request gets when it names a destination (``refund_to``): a closure refund
#: returns to the wallets that deposited to the key and the key cannot choose it. This module never sends one.
REFUND_DESTINATION_FIXED = "refund_destination_fixed"
#: ``error.type`` of the 400 ``POST /api/v1/credits/close/cancel`` gets when the key has no closure on chain.
NOTHING_TO_CANCEL = "nothing_to_cancel"
#: ``error.type`` of the 409 ``POST /api/v1/credits/close/cancel`` gets once any part of the refund has been paid: the
#: closure can no longer be taken back.
REFUND_IN_PROGRESS = "refund_in_progress"
#: ``error.type`` of the 409 ``POST /api/v1/credits/close/cancel`` gets when the key has already taken a closure back in
#: the last 60 days: the key may cancel once per period (``error.metadata.retry_at`` says when it may again). The key's
#: registered owner wallet is not bound by this.
CANCEL_COOLDOWN = "cancel_cooldown"
#: ``error.type`` of the 403 ``POST /api/v1/credits/close/cancel`` gets for a closure the key's registered owner wallet
#: asked for: only that wallet can take it back, not the API key. A wallet that only deposited to the key cannot cancel.
NOT_REQUESTER = "not_requester"

#: ``status`` of a closure row (``GET /api/v1/credits/close``).
CLOSURE_STATUSES = ("queued", "registered", "paid", "refused", "failed", "cancelled")
#: ``reason`` of a closure row or of one of its ``refunds``. A queued or registered row with a reason is waiting, not
#: failed: ``key_disabled`` is on hold until an owner or admin releases it (``POST /api/v1/credits/close/release``).
CLOSURE_REASONS = ("key_disabled", "refund_rate_limited", "refund_destination_unavailable", "depositors_unknown", "cancelled_on_chain", "sanctioned_address", "submission_failed", "refund_work_capped", "request_gone_refund_debited")
#: The reason of a closure that is on hold because its key was disabled (also in ``closure_held`` of
#: ``DELETE /api/v1/keys/{hash}``).
CLOSURE_KEY_DISABLED = "key_disabled"
#: ``status`` of one row of a closure's ``refunds`` (one row per wallet that deposited to the key).
REFUND_STATUSES = ("planned", "paid", "refused", "reversed")

X402_VERSION = 1
TRANSFER_CHECKED = 12
ATA_CREATE_IDEMPOTENT = 1
COMPUTE_SET_UNIT_LIMIT = 2
COMPUTE_SET_UNIT_PRICE = 3
#: What the router's fee payer co-signs in an x402 ``exact`` payment (its defaults; a payment outside them is refused).
MAX_COMPUTE_UNIT_LIMIT = 200_000
MAX_COMPUTE_UNIT_PRICE_MICRO_LAMPORTS = 5_000_000
MAX_PRIORITY_FEE_LAMPORTS = 10_000
#: The runtime's budget when a transaction sets no limit: 200,000 units per instruction, at most 1.4 million.
DEFAULT_UNITS_PER_INSTRUCTION = 200_000
MAX_TRANSACTION_UNITS = 1_400_000

OPEN_TAB_DISCRIMINATOR = bytes([76, 59, 11, 59, 218, 58, 30, 59])
TOP_UP_DISCRIMINATOR = bytes([236, 225, 96, 9, 60, 106, 77, 208])
RECLAIM_DISCRIMINATOR = bytes([44, 177, 236, 249, 145, 109, 163, 186])
TAB_ACCOUNT_DISCRIMINATOR = bytes([194, 242, 40, 53, 214, 169, 9, 172])
#: The domain separator every voucher message starts with (22 ASCII bytes).
VOUCHER_DOMAIN = b"trellis:tab:voucher:v1"
#: 22 (domain) + 32 (tab program id) + 32 (tab) + 8 (created_at) + 8 (cumulative_used) + 8 (seq).
VOUCHER_MESSAGE_LEN = 110
#: A tab's expiry is at most this far from the moment it is opened (the tab program refuses more).
MAX_TAB_LIFETIME_SECONDS = 30 * 86_400


class SolanaError(ValueError):
    """A payment could not be built or parsed (missing fee payer, no exact requirement, malformed header, ...)."""


class SoldersMissing(ImportError):
    """``solders`` is not installed; it is only needed to hand an ``Instruction`` to solders (``to_solders()``)."""


def _solders() -> Any:
    try:
        import solders.instruction
        import solders.pubkey
    except ImportError as e:  # pragma: no cover - depends on the environment
        raise SoldersMissing("Converting to solders objects needs the `solana` extra: pip install \"trellis[solana]\" (solders). Transactions, vouchers, headers and the deposit/close calls work without it.") from e
    return solders


# ---- base58 -------------------------------------------------------------------------------------------------------------

_B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
_B58_INDEX = {c: i for i, c in enumerate(_B58)}


def b58encode(data: bytes) -> str:
    """Bitcoin-alphabet base58 (what Solana uses for addresses and signatures)."""
    n = int.from_bytes(data, "big")
    out = []
    while n:
        n, r = divmod(n, 58)
        out.append(_B58[r])
    pad = len(data) - len(data.lstrip(b"\0"))
    return "1" * pad + "".join(reversed(out))


def b58decode(text: str) -> bytes:
    n = 0
    for c in text:
        try:
            n = n * 58 + _B58_INDEX[c]
        except KeyError:
            raise SolanaError(f"not base58: {text!r}") from None
    body = n.to_bytes((n.bit_length() + 7) // 8, "big") if n else b""
    pad = len(text) - len(text.lstrip("1"))
    return b"\0" * pad + body


def to_pubkey(value: Any) -> bytes:
    """The 32 key bytes of an address (base58 ``str``, 32 ``bytes``, a solders ``Pubkey``/``Keypair`` or a ``Signer``)."""
    if isinstance(value, Signer):
        return value.public_key
    if isinstance(value, (bytes, bytearray, memoryview)):
        b = bytes(value)
    elif isinstance(value, str):
        b = b58decode(value)
    elif hasattr(value, "pubkey") and callable(value.pubkey):  # solders Keypair / NullSigner
        b = bytes(value.pubkey())
    elif hasattr(value, "public_key") and isinstance(getattr(value, "public_key"), (bytes, bytearray)):
        b = bytes(value.public_key)
    else:
        try:
            b = bytes(value)  # solders Pubkey
        except TypeError:
            raise SolanaError(f"not an address: {value!r}") from None
    if len(b) != 32:
        raise SolanaError(f"an address is 32 bytes, got {len(b)}")
    return b


def to_address(value: Any) -> str:
    return b58encode(to_pubkey(value))


# ---- ed25519 keys and signers ------------------------------------------------------------------------------------------


class Signer:
    """An ed25519 signer on ``cryptography``: a wallet or a tab session key.

    ``public_key`` is 32 bytes, ``address`` its base58 and ``sign(message)`` the 64-byte detached signature.
    ``seed`` is the 32-byte private seed (export it to keep a session key between runs).
    """

    def __init__(self, key: Ed25519PrivateKey) -> None:
        self._key = key
        self.public_key = key.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
        self.address = b58encode(self.public_key)

    @classmethod
    def generate(cls) -> "Signer":
        return cls(Ed25519PrivateKey.generate())

    @classmethod
    def from_seed(cls, seed: bytes) -> "Signer":
        """From a 32-byte seed or a 64-byte Solana secret key (seed || public key)."""
        seed = bytes(seed)
        if len(seed) == 64:
            seed = seed[:32]
        if len(seed) != 32:
            raise SolanaError("an ed25519 seed is 32 bytes (or a 64-byte Solana secret key)")
        return cls(Ed25519PrivateKey.from_private_bytes(seed))

    @classmethod
    def from_base58(cls, secret: str) -> "Signer":
        return cls.from_seed(b58decode(secret))

    @property
    def seed(self) -> bytes:
        return self._key.private_bytes(Encoding.Raw, PrivateFormat.Raw, NoEncryption())

    def sign(self, message: bytes) -> bytes:
        return self._key.sign(bytes(message))

    def pubkey(self) -> bytes:
        """solders-style accessor so a ``Signer`` passes wherever a ``Keypair`` would."""
        return self.public_key

    def __repr__(self) -> str:
        return f"Signer({self.address})"


class _ForeignSigner(Signer):
    """A solders ``Keypair`` (or any object with ``pubkey()`` and ``sign_message(bytes)``) behind the ``Signer`` interface."""

    def __init__(self, inner: Any) -> None:  # noqa: D107 - does not call Signer.__init__ on purpose
        self._inner = inner
        self.public_key = bytes(inner.pubkey())
        self.address = b58encode(self.public_key)

    @property
    def seed(self) -> bytes:
        return bytes(self._inner)[:32] if hasattr(self._inner, "__bytes__") else b""

    def sign(self, message: bytes) -> bytes:
        return bytes(self._inner.sign_message(bytes(message)))


def as_signer(value: Any) -> Signer:
    """Accept a ``Signer``, a ``cryptography`` ``Ed25519PrivateKey``, a 32/64-byte secret or a solders ``Keypair``."""
    if isinstance(value, Signer):
        return value
    if isinstance(value, Ed25519PrivateKey):
        return Signer(value)
    if isinstance(value, (bytes, bytearray)):
        return Signer.from_seed(bytes(value))
    if hasattr(value, "sign_message") and hasattr(value, "pubkey"):
        return _ForeignSigner(value)
    raise SolanaError("a signer is a Signer, an Ed25519PrivateKey, a 32/64-byte secret key or a solders Keypair")


def verify_signature(public_key: Any, message: bytes, signature: Union[bytes, str]) -> bool:
    """Whether ``signature`` (64 bytes, or base58) is ``public_key`` signing exactly ``message``. Never raises."""
    try:
        sig = b58decode(signature) if isinstance(signature, str) else bytes(signature)
        if len(sig) != 64:
            return False
        Ed25519PublicKey.from_public_bytes(to_pubkey(public_key)).verify(sig, bytes(message))
        return True
    except (InvalidSignature, ValueError, SolanaError):
        return False


# ---- program-derived addresses -------------------------------------------------------------------------------------------
# Pure-Python derivation (sha256 of seeds || program id || "ProgramDerivedAddress", off the ed25519 curve), the same
# rule as solders' Pubkey.find_program_address; solders is used when it is installed.

_P = 2**255 - 19
_D = (-121665 * pow(121666, _P - 2, _P)) % _P
_SQRT_M1 = pow(2, (_P - 1) // 4, _P)


def _on_curve(b: bytes) -> bool:
    """Whether the 32 bytes decompress to an ed25519 point (curve25519-dalek's rule: no canonical-encoding checks)."""
    y = int.from_bytes(b, "little") & ((1 << 255) - 1)
    y2 = y * y % _P
    u = (y2 - 1) % _P
    v = (_D * y2 + 1) % _P
    v3 = v * v * v % _P
    v7 = v3 * v3 * v % _P
    x = u * v3 * pow(u * v7 % _P, (_P - 5) // 8, _P) % _P
    check = v * x * x % _P
    return check == u or check == (-u) % _P


def _create_program_address_py(seeds: Sequence[bytes], program_id: bytes) -> Optional[bytes]:
    h = hashlib.sha256()
    for s in seeds:
        h.update(s)
    h.update(program_id)
    h.update(b"ProgramDerivedAddress")
    digest = h.digest()
    return None if _on_curve(digest) else digest


def _find_program_address_py(seeds: Sequence[bytes], program_id: bytes) -> tuple[bytes, int]:
    for bump in range(255, -1, -1):
        pda = _create_program_address_py([*seeds, bytes([bump])], program_id)
        if pda is not None:
            return pda, bump
    raise SolanaError("no viable program address bump")  # pragma: no cover


def create_program_address(seeds: Sequence[bytes], program_id: Any) -> Optional[bytes]:
    """The PDA for ``seeds`` (each at most 32 bytes), or None when the hash lands on the curve."""
    program = to_pubkey(program_id)
    if any(len(s) > 32 for s in seeds) or len(seeds) > 16:
        raise SolanaError("PDA seeds are at most 16 seeds of at most 32 bytes")
    return _create_program_address_py([bytes(s) for s in seeds], program)


def find_program_address(seeds: Sequence[bytes], program_id: Any) -> tuple[bytes, int]:
    """The canonical PDA and bump for ``seeds`` under ``program_id`` (32 bytes, bump)."""
    program = to_pubkey(program_id)
    seeds = [bytes(s) for s in seeds]
    try:
        from solders.pubkey import Pubkey  # optional; the pure-Python derivation gives the same result
    except ImportError:
        return _find_program_address_py(seeds, program)
    pda, bump = Pubkey.find_program_address(seeds, Pubkey.from_bytes(program))
    return bytes(pda), bump


def associated_token_address(owner: Any, mint: Any = USDC_MINT, token_program: Any = TOKEN_PROGRAM) -> str:
    """``owner``'s associated token account for ``mint`` (base58)."""
    pda, _ = find_program_address([to_pubkey(owner), to_pubkey(token_program), to_pubkey(mint)], ASSOCIATED_TOKEN_PROGRAM)
    return b58encode(pda)


# ---- instructions and transactions --------------------------------------------------------------------------------------


@dataclass(frozen=True)
class AccountMeta:
    pubkey: bytes
    is_signer: bool = False
    is_writable: bool = False

    @property
    def address(self) -> str:
        return b58encode(self.pubkey)


@dataclass(frozen=True)
class Instruction:
    """A Solana instruction without the chain library: program id, ordered accounts and data bytes."""

    program_id: bytes
    accounts: tuple[AccountMeta, ...]
    data: bytes

    @property
    def program(self) -> str:
        return b58encode(self.program_id)

    def to_solders(self) -> Any:
        s = _solders()
        metas = [s.instruction.AccountMeta(s.pubkey.Pubkey.from_bytes(a.pubkey), a.is_signer, a.is_writable) for a in self.accounts]
        return s.instruction.Instruction(s.pubkey.Pubkey.from_bytes(self.program_id), self.data, metas)


def _meta(pubkey: Any, *, signer: bool = False, writable: bool = False) -> AccountMeta:
    return AccountMeta(to_pubkey(pubkey), signer, writable)


def _blockhash_bytes(recent_blockhash: Any) -> bytes:
    if recent_blockhash is None:
        raise SolanaError("recent_blockhash is required: fetch one with fetch_blockhash(rpc_url)")
    b = to_pubkey(recent_blockhash)  # a blockhash is also 32 bytes in base58
    return b


def _shortvec(n: int) -> bytes:
    """Solana's compact-u16 length prefix."""
    out = bytearray()
    while True:
        b = n & 0x7F
        n >>= 7
        if n:
            out.append(b | 0x80)
        else:
            out.append(b)
            return bytes(out)


def _read_shortvec(data: bytes, pos: int) -> tuple[int, int]:
    n = shift = 0
    while True:
        if pos >= len(data) or shift > 14:
            raise SolanaError("not a Solana transaction (bad length prefix)")
        b = data[pos]
        pos += 1
        n |= (b & 0x7F) << shift
        if not b & 0x80:
            return n, pos
        shift += 7


def _compile_message(instructions: Sequence[Instruction], fee_payer: bytes, recent_blockhash: bytes) -> tuple[bytes, list[bytes], int]:
    """A legacy message: (bytes, account keys, number of required signatures). Accounts come in order of first
    appearance (the fee payer, then per instruction its program and its accounts) within the four groups writable
    signers, read-only signers, writable non-signers, read-only non-signers; a key's flags are the union of its uses."""
    flags: dict[bytes, list[bool]] = {fee_payer: [True, True]}  # insertion-ordered: [is_signer, is_writable]
    for ix in instructions:
        flags.setdefault(ix.program_id, [False, False])
        for a in ix.accounts:
            f = flags.setdefault(a.pubkey, [False, False])
            f[0] = f[0] or a.is_signer
            f[1] = f[1] or a.is_writable
    groups = [[k for k, (s, w) in flags.items() if (s, w) == want] for want in ((True, True), (True, False), (False, True), (False, False))]
    keys = [k for g in groups for k in g]
    if len(keys) > 256:
        raise SolanaError("a transaction names at most 256 accounts")
    index = {k: i for i, k in enumerate(keys)}
    out = bytearray([len(groups[0]) + len(groups[1]), len(groups[1]), len(groups[3])])
    out += _shortvec(len(keys)) + b"".join(keys) + recent_blockhash + _shortvec(len(instructions))
    for ix in instructions:
        out += bytes([index[ix.program_id]]) + _shortvec(len(ix.accounts)) + bytes(index[a.pubkey] for a in ix.accounts) + _shortvec(len(ix.data)) + ix.data
    return bytes(out), keys, len(groups[0]) + len(groups[1])


def compile_transaction(instructions: Sequence[Instruction], fee_payer: Any, recent_blockhash: Any, signers: Sequence[Any] = ()) -> bytes:
    """A legacy transaction around ``instructions`` with ``fee_payer`` first, signed by every signer in ``signers``
    whose key the message requires; every other required signature (the fee payer's, for a sponsored payment, or the
    wallet's, for a transaction a wallet will sign) stays all-zero."""
    message, keys, required = _compile_message(instructions, to_pubkey(fee_payer), _blockhash_bytes(recent_blockhash))
    by_key = {s.public_key: s for s in (as_signer(x) for x in signers)}
    signatures = [by_key[k].sign(message) if k in by_key else bytes(64) for k in keys[:required]]
    return _shortvec(required) + b"".join(signatures) + message


@dataclass(frozen=True)
class ParsedTransaction:
    """A serialized transaction taken apart: the signature slots in order, the message bytes they sign, and what the
    message says. ``version`` is None for a legacy message. ``instructions`` carry each account's signer and writable
    flags as the message header gives them."""

    signatures: tuple[bytes, ...]
    message: bytes
    version: Optional[int]
    num_required_signatures: int
    num_readonly_signed: int
    num_readonly_unsigned: int
    account_keys: tuple[bytes, ...]
    recent_blockhash: str
    instructions: tuple[Instruction, ...]

    @property
    def signers(self) -> list[str]:
        """The required signers in signature order (the fee payer first), base58."""
        return [b58encode(k) for k in self.account_keys[: self.num_required_signatures]]

    @property
    def fee_payer(self) -> str:
        return b58encode(self.account_keys[0])

    def signature_of(self, signer: Any) -> Optional[bytes]:
        """The 64 bytes in ``signer``'s slot, or None when the slot is empty (all zero) or the key does not sign."""
        key = to_pubkey(signer)
        for k, sig in zip(self.account_keys[: self.num_required_signatures], self.signatures):
            if k == key:
                return sig if any(sig) else None
        return None


def _transaction_bytes(transaction: Any) -> bytes:
    if transaction is None or transaction == "" or transaction == b"":
        raise SolanaError("there is no transaction to sign or read (a closure that is already registered returns `transaction: null`)")
    if isinstance(transaction, str):
        try:
            return base64.b64decode(transaction, validate=True)
        except ValueError:
            raise SolanaError("a transaction is base64 (or raw bytes)") from None
    return bytes(transaction)


def _transaction_head(raw: bytes) -> tuple[list[bytes], bytes, Optional[int], tuple[int, int, int], list[bytes], int]:
    """(signatures, message, version, header, static account keys, offset in the message after the keys)."""
    count, pos = _read_shortvec(raw, 0)
    if count == 0 or pos + 64 * count + 5 > len(raw):
        raise SolanaError("not a Solana transaction (truncated signatures)")
    signatures = [raw[pos + 64 * i : pos + 64 * (i + 1)] for i in range(count)]
    message = raw[pos + 64 * count :]
    version: Optional[int] = None
    at = 0
    if message[0] & 0x80:
        version, at = message[0] & 0x7F, 1
    header = (message[at], message[at + 1], message[at + 2])
    n_keys, at = _read_shortvec(message, at + 3)
    if at + 32 * n_keys + 32 > len(message) or header[0] != count or header[0] > n_keys:
        raise SolanaError("not a Solana transaction (signature count and account keys do not agree)")
    keys = [message[at + 32 * i : at + 32 * (i + 1)] for i in range(n_keys)]
    return signatures, message, version, header, keys, at + 32 * n_keys


def parse_transaction(transaction: Union[str, bytes]) -> ParsedTransaction:
    """Take a serialized transaction (base64, or raw bytes) apart without changing it. A versioned transaction that
    names accounts through address lookup tables is refused: its instructions cannot be read from the message alone."""
    signatures, message, version, header, keys, at = _transaction_head(_transaction_bytes(transaction))
    required, readonly_signed, readonly_unsigned = header
    blockhash = message[at : at + 32]
    count, at = _read_shortvec(message, at + 32)

    def meta(i: int) -> AccountMeta:
        if i >= len(keys):
            raise SolanaError("the transaction names accounts through address lookup tables")
        return AccountMeta(keys[i], i < required, i < required - readonly_signed or required <= i < len(keys) - readonly_unsigned)

    instructions = []
    try:
        for _ in range(count):
            program = meta(message[at]).pubkey
            n, at = _read_shortvec(message, at + 1)
            if at + n > len(message):
                raise IndexError
            accounts = tuple(meta(i) for i in message[at : at + n])
            size, at = _read_shortvec(message, at + n)
            if at + size > len(message):
                raise IndexError
            instructions.append(Instruction(program, accounts, message[at : at + size]))
            at += size
    except IndexError:
        raise SolanaError("not a Solana transaction (truncated instructions)") from None
    return ParsedTransaction(tuple(signatures), message, version, required, readonly_signed, readonly_unsigned, tuple(keys), b58encode(blockhash), tuple(instructions))


def sign_transaction(transaction: Union[str, bytes], signer: Any) -> str:
    """Add ``signer``'s signature to a transaction (base64, or raw bytes) and return it as base64.

    Only ``signer``'s own slot changes: the message and every other signature slot come back byte for byte, so a
    signature that is already in place stays valid. Works on legacy and versioned transactions. Raises
    ``SolanaError`` when there is nothing to sign (``None``) or when the message does not ask for this signer's
    signature.

    The credits transactions the router returns are all finished with this one call:

    * a closure (``POST /api/v1/credits/close``) and its cancellation (``POST /api/v1/credits/close/cancel``) arrive
      already signed by the API key; the ``payer`` named in the request adds its signature (slot 0, the fee payer) and
      the key's stays byte for byte;
    * a deposit (``POST /api/v1/credits/deposit-tx``) and a refund destination change
      (``POST /api/v1/credits/refund-destination-tx``) arrive unsigned and are signed by one wallet alone: the payer
      of the deposit, the depositor of the change. The API key is not a signer of either, and any other wallet is
      refused here."""
    raw = _transaction_bytes(transaction)
    signatures, message, _version, header, keys, _at = _transaction_head(raw)
    s = as_signer(signer)
    try:
        slot = keys[: header[0]].index(s.public_key)
    except ValueError:
        raise SolanaError(f"{s.address} is not a required signer of this transaction (its signers: {', '.join(b58encode(k) for k in keys[: header[0]])})") from None
    signatures[slot] = s.sign(message)
    return base64.b64encode(raw[: len(raw) - len(message) - 64 * len(signatures)] + b"".join(signatures) + message).decode()


# ---- USDC amounts --------------------------------------------------------------------------------------------------------


def parse_usdc(amount: Union[str, int, Decimal, float]) -> int:
    """USDC base units from a decimal amount ("12.50") with at most 6 decimals. An ``int`` is already units."""
    if isinstance(amount, bool):
        raise SolanaError("amount must be a number")
    if isinstance(amount, int):
        return amount
    try:
        d = Decimal(str(amount))
    except InvalidOperation:
        raise SolanaError(f"not a USDC amount: {amount!r}") from None
    units = d.scaleb(USDC_DECIMALS)
    if units != units.to_integral_value() or units < 0:
        raise SolanaError("a USDC amount has at most 6 decimals and is not negative")
    return int(units)


def format_usdc(units: int) -> str:
    """Base units as the decimal string the router takes ("12.5", "0.000001")."""
    s = str(int(units)).rjust(USDC_DECIMALS + 1, "0")
    whole, frac = s[:-USDC_DECIMALS], s[-USDC_DECIMALS:].rstrip("0")
    return f"{whole}.{frac}" if frac else whole


def _usdc_string(amount: Union[str, int, Decimal, float]) -> str:
    """The ``amount`` field of deposit-tx: a decimal USDC string. Strings pass through unchanged (validated)."""
    if isinstance(amount, str):
        parse_usdc(amount)
        return amount
    return format_usdc(parse_usdc(amount))


# ---- x402 `exact` -------------------------------------------------------------------------------------------------------


@dataclass
class PaymentRequirement:
    """One entry of a 402's ``accepts`` (x402 v1 shape; v2 ``PAYMENT-REQUIRED`` headers are mapped onto it)."""

    scheme: str
    network: str
    max_amount_required: int
    pay_to: str
    asset: str
    fee_payer: Optional[str]
    decimals: int = USDC_DECIMALS
    resource: str = ""
    description: str = ""
    mime_type: str = "application/json"
    max_timeout_seconds: Optional[int] = None
    raw: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_v1(cls, r: Mapping[str, Any]) -> "PaymentRequirement":
        extra = r.get("extra") if isinstance(r.get("extra"), Mapping) else {}
        amount = r.get("maxAmountRequired", r.get("amount"))
        try:
            units = int(amount)
        except (TypeError, ValueError):
            raise SolanaError("the requirement has no integer maxAmountRequired") from None
        return cls(
            scheme=str(r.get("scheme", "")),
            network=str(r.get("network", "")),
            max_amount_required=units,
            pay_to=str(r.get("payTo", "")),
            asset=str(r.get("asset", "")),
            fee_payer=extra.get("feePayer") if isinstance(extra.get("feePayer"), str) else None,
            decimals=int(extra.get("decimals", USDC_DECIMALS)),
            resource=str(r.get("resource", "")),
            description=str(r.get("description", "")),
            mime_type=str(r.get("mimeType", "application/json")),
            max_timeout_seconds=r.get("maxTimeoutSeconds"),
            raw=dict(r),
        )

    @classmethod
    def from_v2(cls, accept: Mapping[str, Any], resource: Optional[Mapping[str, Any]] = None) -> "PaymentRequirement":
        resource = resource or {}
        merged = {**accept, "maxAmountRequired": accept.get("amount"), "resource": resource.get("url", ""), "description": resource.get("description", ""), "mimeType": resource.get("mimeType", "application/json")}
        return cls.from_v1(merged)

    @property
    def amount_usdc(self) -> str:
        return format_usdc(self.max_amount_required)

    @property
    def destination(self) -> str:
        """Where the USDC goes: payTo's associated token account for the asset."""
        return associated_token_address(self.pay_to, self.asset)

    def to_v1(self) -> dict[str, Any]:
        """The requirement as the facilitator's ``paymentRequirements``."""
        return {"scheme": self.scheme, "network": self.network, "maxAmountRequired": str(self.max_amount_required), "resource": self.resource, "description": self.description, "mimeType": self.mime_type, "payTo": self.pay_to, "maxTimeoutSeconds": self.max_timeout_seconds, "asset": self.asset, "extra": {"feePayer": self.fee_payer, "decimals": self.decimals}}


@dataclass
class PaymentRequired:
    """A parsed 402: the requirements the router accepts and what it said about the price."""

    accepts: list[PaymentRequirement]
    error: str = ""
    x402_version: int = X402_VERSION
    price_usdc: Optional[str] = None
    model: Optional[str] = None
    payment_error: Optional[str] = None

    def exact(self, network: Optional[str] = None) -> PaymentRequirement:
        """The first ``exact`` requirement on a Solana network (or on ``network``)."""
        for r in self.accepts:
            if r.scheme == "exact" and r.network.startswith("solana:") and (network is None or r.network == network):
                return r
        raise SolanaError("the 402 offers no x402 `exact` requirement on a Solana network")


def _b64json(value: Any) -> str:
    return base64.b64encode(json.dumps(value, separators=(",", ":")).encode()).decode()


def _json_b64(text: str) -> Any:
    try:
        return json.loads(base64.b64decode(text, validate=False))
    except (ValueError, UnicodeDecodeError):
        raise SolanaError("not a base64 JSON header value") from None


def parse_payment_required(response: Any = None, *, body: Any = None, headers: Optional[Mapping[str, str]] = None) -> PaymentRequired:
    """Read a 402 from an ``httpx.Response`` (or from ``body`` / ``headers`` given separately).

    The v1 JSON body (``accepts``) is preferred; a ``PAYMENT-REQUIRED`` header (x402 v2) is read when the body does
    not carry the requirements. ``payment_error`` names why an earlier payment was rejected.
    """
    if response is not None:
        headers = headers if headers is not None else getattr(response, "headers", None)
        if body is None:
            try:
                body = response.json()
            except (ValueError, AttributeError):
                body = None
    body = body if isinstance(body, Mapping) else {}
    headers = headers or {}
    accepts: list[PaymentRequirement] = []
    version = int(body.get("x402Version", X402_VERSION) or X402_VERSION)
    if isinstance(body.get("accepts"), list):
        accepts = [PaymentRequirement.from_v1(r) for r in body["accepts"] if isinstance(r, Mapping)]
    if not accepts:
        header = _header(headers, PAYMENT_REQUIRED_HEADER)
        if header:
            v2 = _json_b64(header)
            if isinstance(v2, Mapping) and isinstance(v2.get("accepts"), list):
                version = int(v2.get("x402Version", 2) or 2)
                resource = v2.get("resource") if isinstance(v2.get("resource"), Mapping) else {}
                accepts = [PaymentRequirement.from_v2(r, resource) for r in v2["accepts"] if isinstance(r, Mapping)]
                body = {**{"error": v2.get("error", "")}, **body}
    if not accepts:
        raise SolanaError("the response carries no x402 requirements (no `accepts` body and no PAYMENT-REQUIRED header)")
    err = body.get("error")
    message = err if isinstance(err, str) else (err.get("message", "") if isinstance(err, Mapping) else "")
    return PaymentRequired(accepts=accepts, error=str(message), x402_version=version, price_usdc=body.get("price_usdc"), model=body.get("model"), payment_error=body.get("payment_error"))


def _header(headers: Mapping[str, str], name: str) -> Optional[str]:
    if hasattr(headers, "get"):
        v = headers.get(name)
        if v is None and not isinstance(headers, httpx.Headers):
            lower = name.lower()
            v = next((val for k, val in headers.items() if str(k).lower() == lower), None)
        return v
    return None


def transfer_checked_instruction(source: Any, mint: Any, destination: Any, owner: Any, amount: int, decimals: int = USDC_DECIMALS, token_program: Any = TOKEN_PROGRAM) -> Instruction:
    """SPL ``TransferChecked``: data ``[12, amount u64 LE, decimals]``, accounts ``[source, mint, destination, owner]``."""
    if amount <= 0 or amount >= 1 << 64:
        raise SolanaError("the transfer amount must be a positive u64")
    data = bytes([TRANSFER_CHECKED]) + struct.pack("<Q", amount) + bytes([decimals])
    return Instruction(to_pubkey(token_program), (_meta(source, writable=True), _meta(mint), _meta(destination, writable=True), _meta(owner, signer=True)), data)


def create_ata_idempotent_instruction(funder: Any, owner: Any, mint: Any, token_program: Any = TOKEN_PROGRAM) -> Instruction:
    """``create_associated_token_account_idempotent`` for ``owner``'s ``mint`` account, rent paid by ``funder``."""
    ata = associated_token_address(owner, mint, token_program)
    return Instruction(to_pubkey(ASSOCIATED_TOKEN_PROGRAM), (_meta(funder, signer=True, writable=True), _meta(ata, writable=True), _meta(owner), _meta(mint), _meta(SYSTEM_PROGRAM), _meta(token_program)), bytes([ATA_CREATE_IDEMPOTENT]))


def set_compute_unit_limit_instruction(units: int) -> Instruction:
    """ComputeBudget ``SetComputeUnitLimit``: data ``[2, units u32 LE]``, no accounts."""
    if isinstance(units, bool) or not isinstance(units, int) or not 0 < units < 1 << 32:
        raise SolanaError("the compute unit limit must be a positive u32")
    return Instruction(to_pubkey(COMPUTE_BUDGET_PROGRAM), (), bytes([COMPUTE_SET_UNIT_LIMIT]) + struct.pack("<I", units))


def set_compute_unit_price_instruction(micro_lamports: int) -> Instruction:
    """ComputeBudget ``SetComputeUnitPrice``: data ``[3, micro-lamports per compute unit u64 LE]``, no accounts."""
    if isinstance(micro_lamports, bool) or not isinstance(micro_lamports, int) or not 0 <= micro_lamports < 1 << 64:
        raise SolanaError("the compute unit price must be a u64 of micro-lamports")
    return Instruction(to_pubkey(COMPUTE_BUDGET_PROGRAM), (), bytes([COMPUTE_SET_UNIT_PRICE]) + struct.pack("<Q", micro_lamports))


def priority_fee_lamports(compute_unit_limit: int, micro_lamports_per_unit: int) -> int:
    """The priority fee the runtime charges: ``ceil(compute unit limit * micro-lamports per unit / 1e6)`` lamports."""
    return (int(compute_unit_limit) * int(micro_lamports_per_unit) + 999_999) // 1_000_000


def _check_exact_limits(compute_unit_limit: Optional[int], compute_unit_price_micro_lamports: Optional[int], budgeted_instructions: int) -> None:
    """Refuse compute-budget options the router's fee payer would not sign (its ``inspectExactTransaction``)."""
    for name, value in (("compute_unit_limit", compute_unit_limit), ("compute_unit_price_micro_lamports", compute_unit_price_micro_lamports)):
        if value is not None and (isinstance(value, bool) or not isinstance(value, int)):
            raise SolanaError(f"{name} must be an int")
    if compute_unit_limit is not None and compute_unit_limit > MAX_COMPUTE_UNIT_LIMIT:
        raise SolanaError(f"compute_unit_limit {compute_unit_limit} is above the {MAX_COMPUTE_UNIT_LIMIT} the router's fee payer signs")
    if compute_unit_price_micro_lamports is None:
        return
    if compute_unit_price_micro_lamports > MAX_COMPUTE_UNIT_PRICE_MICRO_LAMPORTS:
        raise SolanaError(f"compute_unit_price_micro_lamports {compute_unit_price_micro_lamports} is above the {MAX_COMPUTE_UNIT_PRICE_MICRO_LAMPORTS} the router's fee payer signs")
    # Without an explicit limit the runtime budgets 200,000 units per instruction, and the fee is charged on that.
    limit = compute_unit_limit if compute_unit_limit is not None else min(MAX_TRANSACTION_UNITS, DEFAULT_UNITS_PER_INSTRUCTION * budgeted_instructions)
    fee = priority_fee_lamports(limit, compute_unit_price_micro_lamports)
    if fee > MAX_PRIORITY_FEE_LAMPORTS:
        raise SolanaError(f"a priority fee of {fee} lamports ({limit} compute units at {compute_unit_price_micro_lamports} micro-lamports) is above the {MAX_PRIORITY_FEE_LAMPORTS} the router's fee payer signs" + ("" if compute_unit_limit is not None else "; set compute_unit_limit, or lower the price"))


def exact_payment_instructions(
    requirement: PaymentRequirement,
    payer: Any,
    *,
    create_destination_ata: bool = False,
    amount: Optional[int] = None,
    token_program: Any = TOKEN_PROGRAM,
    compute_unit_limit: Optional[int] = None,
    compute_unit_price_micro_lamports: Optional[int] = None,
) -> list[Instruction]:
    """The instructions of an x402 ``exact`` payment, in the order the router's fee payer accepts: an optional
    ``SetComputeUnitLimit`` and ``SetComputeUnitPrice``, an optional idempotent creation of payTo's token account
    funded by ``payer`` (never by the fee payer), then exactly one ``TransferChecked``. Options outside what the fee
    payer signs are refused here with ``SolanaError``."""
    if requirement.scheme != "exact":
        raise SolanaError(f"cannot build a payment for scheme {requirement.scheme!r}")
    if not requirement.fee_payer:
        raise SolanaError("the requirement names no fee payer (extra.feePayer is null): this router cannot sponsor the transaction; send the transfer yourself and present its signature with with_payment_signature (X-PAYMENT plus X-Wallet-Auth from the wallet that paid)")
    if requirement.decimals != USDC_DECIMALS:
        raise SolanaError(f"unexpected asset decimals {requirement.decimals}")
    if to_pubkey(token_program) not in (to_pubkey(TOKEN_PROGRAM), to_pubkey(TOKEN_2022_PROGRAM)):
        raise SolanaError("token_program must be the SPL Token or the Token-2022 program")
    payer_key = to_pubkey(payer)
    units = requirement.max_amount_required if amount is None else int(amount)
    if units < requirement.max_amount_required:
        raise SolanaError("amount is below maxAmountRequired")
    _check_exact_limits(compute_unit_limit, compute_unit_price_micro_lamports, 2 if create_destination_ata else 1)
    source = associated_token_address(payer_key, requirement.asset, token_program)
    destination = associated_token_address(requirement.pay_to, requirement.asset, token_program)
    instructions: list[Instruction] = []
    if compute_unit_limit is not None:
        instructions.append(set_compute_unit_limit_instruction(compute_unit_limit))
    if compute_unit_price_micro_lamports is not None:
        instructions.append(set_compute_unit_price_instruction(compute_unit_price_micro_lamports))
    if create_destination_ata:
        instructions.append(create_ata_idempotent_instruction(payer_key, requirement.pay_to, requirement.asset, token_program))
    instructions.append(transfer_checked_instruction(source, requirement.asset, destination, payer_key, units, requirement.decimals, token_program))
    # The fee payer signs for the fee and nothing else: no instruction may name it as an account or as a program.
    fee_payer = to_pubkey(requirement.fee_payer)
    if any(ix.program_id == fee_payer or any(a.pubkey == fee_payer for a in ix.accounts) for ix in instructions):
        raise SolanaError("the fee payer may not appear in the payment's instructions: pay from a wallet other than the router's fee payer")
    return instructions


def build_exact_payment(
    requirement: PaymentRequirement,
    payer: Any,
    recent_blockhash: Any,
    *,
    create_destination_ata: bool = False,
    amount: Optional[int] = None,
    token_program: Any = TOKEN_PROGRAM,
    compute_unit_limit: Optional[int] = None,
    compute_unit_price_micro_lamports: Optional[int] = None,
) -> str:
    """The x402 ``exact`` payment transaction, base64: fee payer = ``requirement.fee_payer`` (slot left unsigned),
    one USDC ``TransferChecked`` from the payer's associated token account to payTo's, signed by ``payer``. Exactly
    two signatures are required, and the fee payer is named by no instruction.

    ``amount`` defaults to ``max_amount_required``. With ``create_destination_ata`` an idempotent creation of payTo's
    token account precedes the transfer; its rent comes from ``payer``'s own lamports (the router's fee payer refuses
    to fund it). ``compute_unit_limit`` (at most 200,000) and ``compute_unit_price_micro_lamports`` (at most
    5,000,000) add the compute-budget instructions; the priority fee they imply,
    ``ceil(limit * price / 1e6)`` lamports, may not exceed 10,000 (a price without a limit is charged on 200,000
    units per instruction). Anything outside these bounds raises ``SolanaError``: the router would refuse it.
    """
    signer = as_signer(payer)
    instructions = exact_payment_instructions(requirement, signer.public_key, create_destination_ata=create_destination_ata, amount=amount, token_program=token_program, compute_unit_limit=compute_unit_limit, compute_unit_price_micro_lamports=compute_unit_price_micro_lamports)
    return base64.b64encode(compile_transaction(instructions, requirement.fee_payer, recent_blockhash, [signer])).decode()


def x402_payment_header(transaction: str, network: str, *, scheme: str = "exact", version: int = X402_VERSION) -> str:
    """The ``X-PAYMENT`` value: base64 JSON ``{x402Version, scheme, network, payload: {transaction}}``."""
    return _b64json({"x402Version": version, "scheme": scheme, "network": network, "payload": {"transaction": transaction}})


def parse_payment_response(headers: Mapping[str, str]) -> Optional[dict[str, Any]]:
    """The settlement a served call carries (``X-PAYMENT-RESPONSE`` / ``PAYMENT-RESPONSE``):
    ``{success, transaction, network, payer}``, or None when there is none."""
    for name in PAYMENT_RESPONSE_HEADERS:
        v = _header(headers, name)
        if v:
            parsed = _json_b64(v)
            return dict(parsed) if isinstance(parsed, Mapping) else None
    return None


def _blockhash_request(commitment: str) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": 1, "method": "getLatestBlockhash", "params": [{"commitment": commitment}]}


def _blockhash_result(response: httpx.Response) -> str:
    try:
        body = response.json()
        return str(body["result"]["value"]["blockhash"])
    except (ValueError, KeyError, TypeError):
        raise SolanaError(f"getLatestBlockhash failed: HTTP {response.status_code} {response.text[:200]}") from None


def fetch_blockhash(rpc_url: str, http: Optional[httpx.Client] = None, *, commitment: str = "confirmed") -> str:
    """A recent blockhash from a Solana JSON-RPC endpoint (``getLatestBlockhash``), base58."""
    if http is None:
        with httpx.Client(timeout=15.0) as own:
            return _blockhash_result(own.post(rpc_url, json=_blockhash_request(commitment)))
    return _blockhash_result(http.post(rpc_url, json=_blockhash_request(commitment)))


async def async_fetch_blockhash(rpc_url: str, http: Optional[httpx.AsyncClient] = None, *, commitment: str = "confirmed") -> str:
    if http is None:
        async with httpx.AsyncClient(timeout=15.0) as own:
            return _blockhash_result(await own.post(rpc_url, json=_blockhash_request(commitment)))
    return _blockhash_result(await http.post(rpc_url, json=_blockhash_request(commitment)))


def _http_of(client_or_http: Any) -> Any:
    http = getattr(client_or_http, "_http", client_or_http)
    if not hasattr(http, "send"):
        raise SolanaError("pass an httpx client or a Trellis client")
    return http


def _with_payment(request: httpx.Request, header: str) -> httpx.Request:
    headers = dict(request.headers)
    headers.pop("content-length", None)
    # X-Wallet-Auth is single use and the first send spent it. A signed x402 payload needs none; a bare signature gets
    # a fresh one (with_payment_signature).
    headers.pop(WALLET_AUTH_HEADER.lower(), None)
    headers[PAYMENT_HEADER] = header
    return httpx.Request(request.method, request.url, headers=headers, content=request.content)


def with_payment_signature(request: httpx.Request, signature: str, signer: Any, *, host: Optional[str] = None, timestamp: Optional[int] = None, sha256_hex: Optional[str] = None) -> httpx.Request:
    """``request`` again, paid with a transfer that already landed: ``X-PAYMENT: <transaction signature>`` (base58)
    plus the ``X-Wallet-Auth`` the router requires with it, signed by ``signer`` over this same request.

    ``signer`` must be the wallet that paid (the token owner of that transfer). A landed payment is public, so the
    signature alone does not show who is asking: without the wallet header, or with another wallet's, the router
    answers ``payment_not_bound_to_caller`` (``PAYMENT_NOT_BOUND``) and redeems nothing. ``host``, ``timestamp`` and
    ``sha256_hex`` are those of ``with_wallet_auth``. A new request is returned; send it once (the wallet header is
    single use)."""
    try:
        ok = len(b58decode(signature)) == 64
    except (SolanaError, TypeError):
        ok = False
    if not ok:
        raise SolanaError("a transaction signature is 64 bytes in base58")
    return with_wallet_auth(_with_payment(request, signature), signer, host=host, timestamp=timestamp, sha256_hex=sha256_hex)


def _paid_request(response: httpx.Response, request: httpx.Request, signer: Any, blockhash: Any, network: Optional[str], options: Mapping[str, Any]) -> httpx.Request:
    requirement = parse_payment_required(response).exact(network)
    tx = build_exact_payment(requirement, signer, blockhash, **options)
    return _with_payment(request, x402_payment_header(tx, requirement.network))


def _payment_options(create_destination_ata: bool, compute_unit_limit: Optional[int], compute_unit_price_micro_lamports: Optional[int]) -> dict[str, Any]:
    options: dict[str, Any] = {"create_destination_ata": create_destination_ata}
    if compute_unit_limit is not None:
        options["compute_unit_limit"] = compute_unit_limit
    if compute_unit_price_micro_lamports is not None:
        options["compute_unit_price_micro_lamports"] = compute_unit_price_micro_lamports
    return options


def pay_per_call(
    client_or_http: Any,
    request: httpx.Request,
    signer: Any,
    rpc_url: Optional[str] = None,
    *,
    blockhash: Any = None,
    network: Optional[str] = None,
    create_destination_ata: bool = False,
    compute_unit_limit: Optional[int] = None,
    compute_unit_price_micro_lamports: Optional[int] = None,
) -> httpx.Response:
    """Send ``request``; on a 402 build the x402 ``exact`` payment with ``signer`` and retry once with ``X-PAYMENT``.

    ``client_or_http`` is an ``httpx.Client`` or a Trellis client (its ``httpx.Client`` is used, so the 402 is seen
    here rather than raised). The blockhash comes from ``rpc_url`` (``getLatestBlockhash``) unless ``blockhash`` is
    given. ``create_destination_ata`` and the compute-budget options are those of ``build_exact_payment`` (the rent of
    payTo's token account is paid by ``signer``; options outside what the router's fee payer signs raise
    ``SolanaError``). The final response is returned as is: a second 402 means the payment was rejected
    (``parse_payment_required(response).payment_error``); a served call carries ``parse_payment_response(headers)``.
    """
    http = _http_of(client_or_http)
    response = http.send(request)
    if response.status_code != 402:
        return response
    if blockhash is None:
        if not rpc_url:
            raise SolanaError("pay_per_call needs rpc_url (or blockhash) to build the payment")
        blockhash = fetch_blockhash(rpc_url, http if isinstance(http, httpx.Client) else None)
    return http.send(_paid_request(response, request, signer, blockhash, network, _payment_options(create_destination_ata, compute_unit_limit, compute_unit_price_micro_lamports)))


async def async_pay_per_call(
    client_or_http: Any,
    request: httpx.Request,
    signer: Any,
    rpc_url: Optional[str] = None,
    *,
    blockhash: Any = None,
    network: Optional[str] = None,
    create_destination_ata: bool = False,
    compute_unit_limit: Optional[int] = None,
    compute_unit_price_micro_lamports: Optional[int] = None,
) -> httpx.Response:
    """``pay_per_call`` on an ``httpx.AsyncClient`` (or an async Trellis client)."""
    http = _http_of(client_or_http)
    response = await http.send(request)
    if response.status_code != 402:
        return response
    if blockhash is None:
        if not rpc_url:
            raise SolanaError("async_pay_per_call needs rpc_url (or blockhash) to build the payment")
        blockhash = await async_fetch_blockhash(rpc_url, http if isinstance(http, httpx.AsyncClient) else None)
    return await http.send(_paid_request(response, request, signer, blockhash, network, _payment_options(create_destination_ata, compute_unit_limit, compute_unit_price_micro_lamports)))


# ---- tabs --------------------------------------------------------------------------------------------------------------


def generate_session_key() -> Signer:
    """A fresh ed25519 session key for a tab. Its ``address`` goes into ``open_tab``; it signs every voucher."""
    return Signer.generate()


def tab_config_address(program_id: Any) -> str:
    return b58encode(find_program_address([b"config"], program_id)[0])


def tab_address(program_id: Any, payer: Any, payee: Any, tab_id: int) -> str:
    """The tab PDA: seeds ``["tab", payer, payee, tab_id u64 LE]`` under the tab program."""
    return b58encode(find_program_address([b"tab", to_pubkey(payer), to_pubkey(payee), struct.pack("<Q", int(tab_id))], program_id)[0])


def tab_escrow_address(program_id: Any, tab: Any) -> str:
    return b58encode(find_program_address([b"escrow", to_pubkey(tab)], program_id)[0])


def tab_enforcer_address(program_id: Any) -> str:
    """The tab program's ``["enforcer"]`` PDA: what signs its call into the rules program. ``open_tab`` and
    ``top_up`` always name it."""
    return b58encode(find_program_address([b"enforcer"], program_id)[0])


def rules_config_address(rules_program: Any) -> str:
    """The rules program's ``["config"]`` PDA (the ``rules_config`` account of a rulebook-bound tab)."""
    return b58encode(find_program_address([b"config"], rules_program)[0])


def _u64(value: int, name: str) -> bytes:
    if not 0 <= int(value) < 1 << 64:
        raise SolanaError(f"{name} must be a u64")
    return struct.pack("<Q", int(value))


def _i64(value: int, name: str) -> bytes:
    if not -(1 << 63) <= int(value) < 1 << 63:
        raise SolanaError(f"{name} must be an i64")
    return struct.pack("<q", int(value))


def _rulebook_group(program_id: Any, rulebook: Any, rules_program: Any) -> tuple[AccountMeta, AccountMeta, AccountMeta]:
    """The rulebook, rules config and rules program slots of ``open_tab`` / ``top_up``. A tab that is bound to no
    rulebook holds the tab program id in all three (the placeholder for an absent optional account)."""
    if rulebook is None:
        return (_meta(program_id), _meta(program_id), _meta(program_id))
    if rules_program is None:
        raise SolanaError("a rulebook-bound tab needs rules_program: the rules program the tab program's config names")
    return (_meta(rulebook, writable=True), _meta(rules_config_address(rules_program)), _meta(rules_program))


def open_tab_instruction(program_id: Any, payer: Any, payee: Any, cap: int, expiry: int, session_key: Any, tab_id: int, rulebook: Any = None, mint: Any = USDC_MINT, *, rules_program: Any = None, now: Optional[int] = None) -> Instruction:
    """``open_tab(OpenTabArgs{tab_id, cap, expiry, session_key})``. Accounts: payer (signer, writable), payee, config,
    tab (writable), mint, escrow (writable), payer_token (writable), rulebook, token_program, system_program,
    rules_config, rules_program, enforcer.

    A tab bound to a ``rulebook`` (the payer's own; it is writable, the cap is counted against its daily limit) also
    takes the rules program's config and the rules program itself, so ``rules_program`` is required with it. Without
    a rulebook those three slots hold the tab program id. ``expiry`` (unix seconds) may be at most 30 days
    (``MAX_TAB_LIFETIME_SECONDS``) after ``now`` (default: this machine's clock): the program refuses a longer one,
    and so does this function."""
    if int(cap) <= 0:
        raise SolanaError("tab cap must be above 0")
    current = int(time.time()) if now is None else int(now)
    if int(expiry) > current + MAX_TAB_LIFETIME_SECONDS:
        raise SolanaError(f"a tab's expiry is at most 30 days ({MAX_TAB_LIFETIME_SECONDS} seconds) from now: {int(expiry)} is {int(expiry) - current} seconds away")
    payer_key = to_pubkey(payer)
    tab = tab_address(program_id, payer_key, payee, tab_id)
    data = OPEN_TAB_DISCRIMINATOR + _u64(tab_id, "tab_id") + _u64(cap, "cap") + _i64(expiry, "expiry") + to_pubkey(session_key)
    book, rules_config, rules = _rulebook_group(program_id, rulebook, rules_program)
    accounts = (
        _meta(payer_key, signer=True, writable=True),
        _meta(payee),
        _meta(tab_config_address(program_id)),
        _meta(tab, writable=True),
        _meta(mint),
        _meta(tab_escrow_address(program_id, tab), writable=True),
        _meta(associated_token_address(payer_key, mint), writable=True),
        book,
        _meta(TOKEN_PROGRAM),
        _meta(SYSTEM_PROGRAM),
        rules_config,
        rules,
        _meta(tab_enforcer_address(program_id)),
    )
    return Instruction(to_pubkey(program_id), accounts, data)


@dataclass
class OpenTab:
    """What ``open_tab_transaction`` built: the tab's address and id, and the transaction (base64) to send."""

    tab: str
    tab_id: int
    transaction: str
    session_key: str
    escrow: str
    signed: bool
    program_id: str

    def session(self, session_key: Any, created_at: int) -> "TabSession":
        """The voucher signer for this tab. ``created_at`` is the open tab's ``Tab.created_at``: read it from the
        chain once the transaction has landed (``fetch_tab_account(rpc_url, program_id, tab).created_at``)."""
        return TabSession(self.tab, session_key, self.program_id, created_at)


def _signer_or_address(value: Any) -> tuple[Optional[Signer], bytes]:
    try:
        signer: Optional[Signer] = as_signer(value)
    except SolanaError:
        signer = None
    return signer, signer.public_key if signer else to_pubkey(value)


def open_tab_transaction(
    program_id: Any,
    payer: Any,
    payee: Any,
    cap: int,
    expiry: int,
    session_key: Any,
    tab_id: Optional[int] = None,
    rulebook: Any = None,
    *,
    rules_program: Any = None,
    recent_blockhash: Any = None,
    mint: Any = USDC_MINT,
    now: Optional[int] = None,
) -> OpenTab:
    """The transaction that opens a tab with ``cap`` USDC base units until ``expiry`` (unix seconds, at most 30 days
    from now).

    ``payer`` is the wallet: pass a signer (``Signer``, solders ``Keypair``, secret bytes) to get a signed
    transaction, or just its address to get one for a wallet to sign. ``tab_id`` defaults to a random u64.
    ``session_key`` is the ``Signer`` from ``generate_session_key()`` (or its public key). ``rulebook`` binds the tab
    to the payer's own rulebook and needs ``rules_program``. Vouchers need the tab's ``created_at``, which exists
    only once this transaction has landed: read it with ``fetch_tab_account`` and call ``.session(...)``.
    """
    tab_id = secrets.randbits(64) if tab_id is None else int(tab_id)
    signer, payer_key = _signer_or_address(payer)
    ix = open_tab_instruction(program_id, payer_key, payee, cap, expiry, session_key, tab_id, rulebook, mint, rules_program=rules_program, now=now)
    raw = compile_transaction([ix], payer_key, recent_blockhash, [signer] if signer else [])
    tab = ix.accounts[3].address
    return OpenTab(tab=tab, tab_id=tab_id, transaction=base64.b64encode(raw).decode(), session_key=to_address(session_key), escrow=ix.accounts[5].address, signed=signer is not None, program_id=to_address(program_id))


def top_up_instruction(program_id: Any, payer: Any, tab: Any, amount: int, mint: Any = USDC_MINT, *, rulebook: Any = None, rules_program: Any = None) -> Instruction:
    """``top_up(amount)``: payer (signer), config, tab (writable), mint, escrow (writable), payer_token (writable),
    token_program, rulebook, rules_config, rules_program, enforcer. A rulebook-bound tab (``TabAccount.rulebook``)
    passes its ``rulebook`` and ``rules_program``: the top-up is a new commitment under the rulebook. Otherwise those
    three slots hold the tab program id."""
    if int(amount) <= 0:
        raise SolanaError("top-up must be above 0")
    payer_key = to_pubkey(payer)
    book, rules_config, rules = _rulebook_group(program_id, rulebook, rules_program)
    accounts = (
        _meta(payer_key, signer=True),
        _meta(tab_config_address(program_id)),
        _meta(tab, writable=True),
        _meta(mint),
        _meta(tab_escrow_address(program_id, tab), writable=True),
        _meta(associated_token_address(payer_key, mint), writable=True),
        _meta(TOKEN_PROGRAM),
        book,
        rules_config,
        rules,
        _meta(tab_enforcer_address(program_id)),
    )
    return Instruction(to_pubkey(program_id), accounts, TOP_UP_DISCRIMINATOR + _u64(amount, "amount"))


def top_up_transaction(program_id: Any, payer: Any, tab: Any, amount: int, *, rulebook: Any = None, rules_program: Any = None, recent_blockhash: Any = None, mint: Any = USDC_MINT) -> str:
    """The base64 top-up transaction, signed when ``payer`` is a signer."""
    signer, payer_key = _signer_or_address(payer)
    ix = top_up_instruction(program_id, payer_key, tab, amount, mint, rulebook=rulebook, rules_program=rules_program)
    return base64.b64encode(compile_transaction([ix], payer_key, recent_blockhash, [signer] if signer else [])).decode()


def reclaim_instruction(program_id: Any, payer: Any, payee: Any, tab: Any, mint: Any = USDC_MINT) -> Instruction:
    """``reclaim()``: payer (writable, not a signer: only the wallet that gets the rent back), tab (writable), config,
    mint, escrow (writable), payer_token (writable), payee_token (writable), token_program. After the tab's expiry and
    the program's grace period (or at any time once the payee has closed), anyone delivers the escrow: what the payee
    posted to the payee's token account, the rest to the payer's. No signature of the payer or the payee is needed,
    and no rulebook account is involved, whatever the tab was opened with."""
    payer_key = to_pubkey(payer)
    accounts = (
        _meta(payer_key, writable=True),
        _meta(tab, writable=True),
        _meta(tab_config_address(program_id)),
        _meta(mint),
        _meta(tab_escrow_address(program_id, tab), writable=True),
        _meta(associated_token_address(payer_key, mint), writable=True),
        _meta(associated_token_address(payee, mint), writable=True),
        _meta(TOKEN_PROGRAM),
    )
    return Instruction(to_pubkey(program_id), accounts, RECLAIM_DISCRIMINATOR)


def reclaim_transaction(program_id: Any, payer: Any, payee: Any, tab: Any, fee_payer: Any, *, recent_blockhash: Any = None, mint: Any = USDC_MINT) -> str:
    """The base64 reclaim transaction for the tab of ``payer`` and ``payee``. ``fee_payer`` is whoever sends it (any
    wallet; it only pays the fee): a signer gives a signed transaction, an address one for a wallet to sign."""
    signer, fee_payer_key = _signer_or_address(fee_payer)
    ix = reclaim_instruction(program_id, payer, payee, tab, mint)
    return base64.b64encode(compile_transaction([ix], fee_payer_key, recent_blockhash, [signer] if signer else [])).decode()


@dataclass
class TabAccount:
    payer: str
    payee: str
    session_key: str
    mint: str
    tab_id: int
    cap: int
    posted_used: int
    posted_seq: int
    expiry: int
    created_at: int
    rulebook: Optional[str]
    bump: int
    escrow_bump: int


def decode_tab_account(data: bytes) -> TabAccount:
    """A ``Tab`` account's data (from ``getAccountInfo``). A closed or reclaimed tab has no account. ``created_at``
    is what every voucher for this opening of the tab is signed with."""
    data = bytes(data)
    if data[:8] != TAB_ACCOUNT_DISCRIMINATOR:
        raise SolanaError("not a Tab account")
    try:
        keys = [b58encode(data[8 + 32 * i : 40 + 32 * i]) for i in range(4)]
        tab_id, cap, posted_used, posted_seq, expiry, created_at = struct.unpack_from("<QQQQqq", data, 136)
        pos = 136 + 48
        rulebook = None
        if data[pos] == 1:
            rulebook = b58encode(data[pos + 1 : pos + 33])
            pos += 33
        else:
            pos += 1
        return TabAccount(keys[0], keys[1], keys[2], keys[3], tab_id, cap, posted_used, posted_seq, expiry, created_at, rulebook, data[pos], data[pos + 1])
    except (IndexError, struct.error):
        raise SolanaError("not a Tab account (truncated)") from None


def _account_request(address: str, commitment: str) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": 1, "method": "getAccountInfo", "params": [address, {"encoding": "base64", "commitment": commitment}]}


def _tab_account_result(response: httpx.Response, program_id: Any, tab: str) -> Optional[TabAccount]:
    try:
        value = response.json()["result"]["value"]
        if value is None:
            return None
        owner, data = str(value["owner"]), base64.b64decode(value["data"][0])
    except (ValueError, KeyError, TypeError, IndexError):
        raise SolanaError(f"getAccountInfo failed: HTTP {response.status_code} {response.text[:200]}") from None
    # Any account can carry Tab-shaped bytes: it is a tab only if the tab program owns it and it sits at the program's
    # address for its own (payer, payee, tab_id).
    if owner != to_address(program_id):
        raise SolanaError(f"{tab} is not an account of the tab program {to_address(program_id)}")
    account = decode_tab_account(data)
    if tab_address(program_id, account.payer, account.payee, account.tab_id) != tab:
        raise SolanaError(f"{tab} is not the tab address of the account it holds")
    return account


def fetch_tab_account(rpc_url: str, program_id: Any, tab: Any, http: Optional[httpx.Client] = None, *, commitment: str = "confirmed") -> Optional[TabAccount]:
    """Read and decode a tab's account from a Solana JSON-RPC endpoint (``getAccountInfo``): what the payer does after
    ``open_tab`` lands, to learn the ``created_at`` its vouchers are signed with. None when there is no account (the
    tab was never opened, or is closed or reclaimed). Raises ``SolanaError`` when the account is not a tab of
    ``program_id``."""
    address = to_address(tab)
    if http is None:
        with httpx.Client(timeout=15.0) as own:
            return _tab_account_result(own.post(rpc_url, json=_account_request(address, commitment)), program_id, address)
    return _tab_account_result(http.post(rpc_url, json=_account_request(address, commitment)), program_id, address)


async def async_fetch_tab_account(rpc_url: str, program_id: Any, tab: Any, http: Optional[httpx.AsyncClient] = None, *, commitment: str = "confirmed") -> Optional[TabAccount]:
    address = to_address(tab)
    if http is None:
        async with httpx.AsyncClient(timeout=15.0) as own:
            return _tab_account_result(await own.post(rpc_url, json=_account_request(address, commitment)), program_id, address)
    return _tab_account_result(await http.post(rpc_url, json=_account_request(address, commitment)), program_id, address)


def voucher_message(program_id: Any, tab: Any, created_at: int, cumulative_used: int, seq: int) -> bytes:
    """The 110 bytes a voucher signs: ``"trellis:tab:voucher:v1" || tab program id (32) || tab (32) || created_at
    i64 LE || cumulative_used u64 LE || seq u64 LE``. ``program_id`` binds the voucher to one deployment of the tab
    program and ``created_at`` (the open tab's ``Tab.created_at``) to this opening of the tab address."""
    return VOUCHER_DOMAIN + to_pubkey(program_id) + to_pubkey(tab) + _i64(created_at, "created_at") + _u64(cumulative_used, "cumulative_used") + _u64(seq, "seq")


def sign_voucher(session_key: Any, program_id: Any, tab: Any, created_at: int, cumulative_used: int, seq: int) -> bytes:
    """The session key's detached ed25519 signature (64 bytes) over the voucher message."""
    return as_signer(session_key).sign(voucher_message(program_id, tab, created_at, cumulative_used, seq))


def verify_voucher(program_id: Any, tab: Any, created_at: int, cumulative_used: int, seq: int, signature: Union[bytes, str], session_key: Any) -> bool:
    """Whether ``signature`` (64 bytes or base58) is ``session_key`` signing this voucher for this tab program and
    this opening of the tab. Never raises."""
    try:
        return verify_signature(session_key, voucher_message(program_id, tab, created_at, cumulative_used, seq), signature)
    except (SolanaError, TypeError, ValueError):
        return False


@dataclass(frozen=True)
class Voucher:
    """A signed voucher: ``headers`` for a request, ``wire`` for the facilitator's JSON form."""

    program_id: str
    tab: str
    created_at: int
    cumulative_used: int
    seq: int
    signature: bytes
    session_key: str

    @property
    def message(self) -> bytes:
        return voucher_message(self.program_id, self.tab, self.created_at, self.cumulative_used, self.seq)

    @property
    def header(self) -> str:
        """The ``X-Trellis-Tab-Voucher`` value: ``base64(message).base64(signature)``."""
        return base64.b64encode(self.message).decode() + "." + base64.b64encode(self.signature).decode()

    @property
    def headers(self) -> dict[str, str]:
        return {TAB_HEADER: self.tab, TAB_VOUCHER_HEADER: self.header}

    @property
    def wire(self) -> dict[str, str]:
        return {"tab": self.tab, "cumulative_used": str(self.cumulative_used), "seq": str(self.seq), "signature": b58encode(self.signature), "session_key": self.session_key}

    def verify(self) -> bool:
        return verify_voucher(self.program_id, self.tab, self.created_at, self.cumulative_used, self.seq, self.signature, self.session_key)


def parse_voucher_header(value: str, program_id: Any, created_at: int, tab: Optional[str] = None, session_key: Any = None) -> Voucher:
    """Decode an ``X-Trellis-Tab-Voucher`` value and check what it was signed for: the tab program ``program_id``,
    the tab opening ``created_at`` and, when given, ``tab``. A voucher for another program or an earlier opening of
    the tab address is refused, and so is the retired 48-byte form. ``session_key`` is recorded when known so
    ``.verify()`` works; the signature is not verified here."""
    try:
        m, s = value.split(".", 1)
        message, signature = base64.b64decode(m, validate=True), base64.b64decode(s, validate=True)
    except (ValueError, TypeError, AttributeError):
        raise SolanaError("a voucher header is <base64 message>.<base64 signature>") from None
    d = len(VOUCHER_DOMAIN)
    if len(message) != VOUCHER_MESSAGE_LEN or len(signature) != 64 or message[:d] != VOUCHER_DOMAIN:
        raise SolanaError('a voucher is the 110-byte message "trellis:tab:voucher:v1" || program id || tab || created_at || cumulative_used || seq and a 64-byte signature (the 48-byte form is no longer accepted)')
    program_of, tab_of = b58encode(message[d : d + 32]), b58encode(message[d + 32 : d + 64])
    opened_at, cumulative_used, seq = struct.unpack("<qQQ", message[d + 64 :])
    if program_of != to_address(program_id):
        raise SolanaError("the voucher was signed for another tab program (another cluster or deployment)")
    if tab is not None and tab_of != to_address(tab):
        raise SolanaError("the voucher names another tab")
    if opened_at != int(created_at):
        raise SolanaError("the voucher was signed for another opening of this tab address (created_at differs)")
    return Voucher(program_of, tab_of, opened_at, cumulative_used, seq, signature, to_address(session_key) if session_key is not None else "")


class TabSession:
    """The payer's side of an open tab: the session key, the running sequence and the cumulative total vouched.

    ``program_id`` is the tab program and ``created_at`` the open tab's ``Tab.created_at`` (from the chain, after
    ``open_tab`` landed: ``fetch_tab_account``); both are part of what every voucher signs, so a voucher is good for
    this deployment and this opening of the tab only. ``voucher(cumulative_used)`` signs the next voucher (``seq`` + 1,
    ``cumulative_used`` never decreasing) and returns its request ``headers``. Send one with every request; a voucher
    covers everything served so far.
    """

    def __init__(self, tab: Any, session_key: Any, program_id: Any, created_at: int, *, seq: int = 0, cumulative_used: int = 0, cap: Optional[int] = None) -> None:
        if isinstance(created_at, bool) or not isinstance(created_at, int):
            raise SolanaError("created_at is the open tab's Tab.created_at (unix seconds, an int): read it with fetch_tab_account")
        self.tab = to_address(tab)
        self.session_key = as_signer(session_key)
        self.program_id = to_address(program_id)
        self.created_at = created_at
        self.seq = int(seq)
        self.cumulative_used = int(cumulative_used)
        self.cap = cap
        self.last: Optional[Voucher] = None

    @property
    def session_public_key(self) -> str:
        return self.session_key.address

    def voucher(self, cumulative_used: int) -> Voucher:
        cumulative_used = int(cumulative_used)
        if cumulative_used < self.cumulative_used:
            raise SolanaError(f"cumulative_used cannot decrease ({cumulative_used} < {self.cumulative_used})")
        if self.cap is not None and cumulative_used > self.cap:
            raise SolanaError(f"cumulative_used {cumulative_used} exceeds the tab cap {self.cap}")
        seq = self.seq + 1
        signature = self.session_key.sign(voucher_message(self.program_id, self.tab, self.created_at, cumulative_used, seq))
        self.seq, self.cumulative_used = seq, cumulative_used
        self.last = Voucher(self.program_id, self.tab, self.created_at, cumulative_used, seq, signature, self.session_key.address)
        return self.last

    def add(self, units: int) -> Voucher:
        """A voucher for ``units`` more than the last one."""
        return self.voucher(self.cumulative_used + int(units))

    def headers(self, cumulative_used: int) -> dict[str, str]:
        return self.voucher(cumulative_used).headers


# ---- X-Wallet-Auth and wallet sign-in ----------------------------------------------------------------------------------

_DEFAULT_PORTS = {"http": 80, "https": 443, "ws": 80, "wss": 443}
# Paths whose signed hash is the router's request hash: the canonical JSON of the body without the two members that
# only say how the answer is delivered.
_REQUEST_HASH_PATHS = frozenset(f"/api/v1{route}" for route in ("/chat/completions", "/completions", "/embeddings", "/rerank"))
_HOST_RESOURCE = re.compile(r"/api/v1/hosts/([^/]+)")
_URI_COMPONENT_SAFE = "!*'()"  # with Python's always-safe set, what JavaScript's encodeURIComponent leaves alone


def _url_host(url: httpx.URL) -> str:
    """host[:port] of a URL as a URL's ``host`` gives it: lower case, the scheme's default port left out."""
    netloc = url.netloc.decode("ascii")
    if url.port is not None and _DEFAULT_PORTS.get(url.scheme.lower()) == url.port:
        netloc = netloc[: -len(f":{url.port}")]
    return netloc.lower()


def router_host(url_or_host: Any) -> str:
    """The router's public host[:port] as ``X-Wallet-Auth`` and the sign-in challenge name it: from a base URL
    (``https://Router.Example:443/api/v1`` gives ``router.example``) or from a bare ``host[:port]``, in lower case."""
    text = str(url_or_host).strip()
    if "://" in text:
        try:
            host = _url_host(httpx.URL(text))
        except httpx.InvalidURL:
            host = ""
    else:
        host = text.lower()
    if not host or re.search(r"[\s/?#@]", host):
        raise SolanaError(f"not a router URL or host[:port]: {url_or_host!r}")
    return host


def wallet_auth_hash(method: str, path: str, body: Any = None) -> str:
    """The SHA-256 (hex) a route binds an ``X-Wallet-Auth`` signature to, for ``method`` and ``path`` (the request
    target, query string included):

    * the chat routes (``/api/v1/chat/completions``, ``/api/v1/completions``, everything under ``/v1/``) and the
      other inference routes that share their request hash (``/api/v1/embeddings``, ``/api/v1/rerank``): the
      canonical JSON (keys sorted recursively, no whitespace) of the body without ``stream`` and ``stream_options``;
    * any other request with a JSON body: the canonical JSON of the body;
    * a request without a body: the empty string, except ``GET /api/v1/hosts/{id}`` (the string
      ``GET /api/v1/hosts/<url-encoded id>``) and the paid data routes under ``/api/v1/data/`` (``GET <path>``),
      which bind the resource instead.

    ``body`` is the JSON value (a ``dict``) or the JSON text or bytes that are sent; ``None`` or empty means none."""
    pathname = path.split("?", 1)[0]
    if body is None or (isinstance(body, (str, bytes, bytearray, memoryview)) and len(body) == 0):
        if method.upper() == "GET":
            host_resource = _HOST_RESOURCE.fullmatch(pathname)
            if host_resource:
                return hashlib.sha256(f"GET /api/v1/hosts/{quote(unquote(host_resource.group(1)), safe=_URI_COMPONENT_SAFE)}".encode("utf-8")).hexdigest()
            if pathname.startswith("/api/v1/data/"):
                return hashlib.sha256(f"GET {pathname}".encode("utf-8")).hexdigest()
        return hashlib.sha256(b"").hexdigest()
    value = body
    if isinstance(body, (str, bytes, bytearray, memoryview)):
        try:
            value = json.loads(bytes(body) if not isinstance(body, str) else body)
        except ValueError:
            raise SolanaError("X-Wallet-Auth binds the canonical JSON of the request body: the body is not JSON (pass sha256_hex for a route that binds something else)") from None
    if isinstance(value, Mapping) and (pathname.startswith("/v1/") or pathname in _REQUEST_HASH_PATHS):
        value = {k: v for k, v in value.items() if k not in ("stream", "stream_options")}
    try:
        return hashlib.sha256(canonical_bytes(value)).hexdigest()
    except TypeError as e:
        raise SolanaError(f"the request body is not JSON: {e}") from None


def wallet_auth_message(method: str, host: str, path: str, timestamp: int, sha256_hex: str) -> str:
    """The exact text behind an ``X-Wallet-Auth`` signature (UTF-8, no trailing newline):
    ``trellis:wallet-auth:v2\\n<METHOD>\\n<host>\\n<path>\\n<unix seconds>\\n<sha256 hex>``. METHOD is upper case,
    ``host`` the router's public host[:port] in lower case, ``path`` the request target as sent (from the first ``/``
    through the query string)."""
    fields = [WALLET_AUTH_VERSION, str(method).upper(), str(host).lower(), str(path), str(int(timestamp)), str(sha256_hex)]
    if any("\n" in f or "\r" in f for f in fields):  # one field per line: a field with a line break could pass for two
        raise SolanaError("X-Wallet-Auth fields must not contain line breaks")
    if not fields[3].startswith("/"):
        raise SolanaError("the X-Wallet-Auth path is the request target: it starts with /")
    return "\n".join(fields)


def wallet_auth_header(signer: Any, method: str, url: Any, body: Any = None, *, host: Optional[str] = None, timestamp: Optional[int] = None, sha256_hex: Optional[str] = None) -> str:
    """``X-Wallet-Auth: <address>:<unix seconds>:<base58 signature>`` for one request: the wallet signs
    ``wallet_auth_message(method, host, path, unix seconds, hash)``. Valid for five minutes, single use, and good
    for this method, this path and this router only.

    ``url`` is the full URL the request goes to (or an ``httpx.URL``); a bare path (``/api/v1/refunds?x=1``) works
    when ``host`` is given. ``host`` defaults to the URL's host[:port]: pass the router's public host (or its public
    base URL) when you reach it under another name. ``body`` is the JSON body that is sent (a ``dict``, or the JSON
    text or bytes), from which ``wallet_auth_hash`` takes what the route binds; ``sha256_hex`` overrides it."""
    s = as_signer(signer)
    if isinstance(url, str) and url.startswith("/"):
        if not host:
            raise SolanaError("a bare path needs host: the router's public host[:port]")
        path = url
    else:
        try:
            parsed = url if isinstance(url, httpx.URL) else httpx.URL(str(url))
        except httpx.InvalidURL:
            raise SolanaError(f"not a URL: {url!r}") from None
        if not parsed.netloc:
            raise SolanaError(f"X-Wallet-Auth needs the full URL of the request (or a path and host): {url!r}")
        path = parsed.raw_path.decode("ascii")
        host = host or _url_host(parsed)
    ts = int(time.time()) if timestamp is None else int(timestamp)
    digest = sha256_hex if sha256_hex is not None else wallet_auth_hash(method, path, body)
    signature = s.sign(wallet_auth_message(method, router_host(host), path, ts, digest).encode("utf-8"))
    return f"{s.address}:{ts}:{b58encode(signature)}"


def with_wallet_auth(request: httpx.Request, signer: Any, *, host: Optional[str] = None, timestamp: Optional[int] = None, sha256_hex: Optional[str] = None) -> httpx.Request:
    """Set ``X-Wallet-Auth`` on an unsent ``httpx.Request``, computed from that request's own method, URL and body,
    and return it. Change nothing of the request afterwards, and send it once: the header is single use."""
    try:
        body = request.content
    except httpx.RequestNotRead:
        raise SolanaError("X-Wallet-Auth signs the request body: build the request with its whole body (json= or content=), not a stream") from None
    request.headers[WALLET_AUTH_HEADER] = wallet_auth_header(signer, request.method, request.url, body, host=host, timestamp=timestamp, sha256_hex=sha256_hex)
    return request


_SIGN_IN_MESSAGE = re.compile(
    r"(\S+) wants you to sign in with your Solana account:\n([1-9A-HJ-NP-Za-km-z]{32,44})\n\n([^\n]*)\n\n"
    r"URI: ([^\n]+)\nVersion: ([^\n]+)\nChain ID: ([^\n]+)\nNonce: ([^\n]+)\nIssued At: ([^\n]+)\nExpiration Time: ([^\n]+)"
)


@dataclass(frozen=True)
class WalletSignIn:
    """The fields of a sign-in message (Sign-In-With-Solana layout): the site being signed in to comes first."""

    domain: str
    address: str
    statement: str
    uri: str
    version: str
    chain_id: str
    nonce: str
    issued_at: str
    expiration_time: str


def parse_wallet_sign_in_message(message: str) -> WalletSignIn:
    """Read a sign-in message back into its fields. Raises ``SolanaError`` when the text is not one."""
    m = _SIGN_IN_MESSAGE.fullmatch(message) if isinstance(message, str) else None
    if not m:
        raise SolanaError("not a Trellis wallet sign-in message")
    return WalletSignIn(*m.groups())


def check_wallet_challenge(challenge: Mapping[str, Any], signer: Any, expected_domain: Any) -> WalletSignIn:
    """Check that a sign-in challenge is the router's own before anything is signed: its ``domain`` is
    ``expected_domain`` (the host[:port] of the router you are talking to, or its base URL), the message's first
    line names that same domain, its second line is the signer's own address, and it carries the challenge's nonce.
    Raises ``SolanaError`` otherwise: a challenge relayed from another site must not be signed."""
    expected = router_host(expected_domain)
    address = to_address(signer)
    if not isinstance(challenge, Mapping) or not isinstance(challenge.get("message"), str):
        raise SolanaError("the challenge carries no message to sign: the router must answer with trellis:wallet:v2")
    if challenge.get("version", WALLET_SIGN_IN_VERSION) != WALLET_SIGN_IN_VERSION:
        raise SolanaError(f"unsupported sign-in version {challenge.get('version')!r} (this client signs {WALLET_SIGN_IN_VERSION})")
    if challenge.get("domain") != expected:
        raise SolanaError(f"refusing to sign: the challenge is for {challenge.get('domain')!r}, not for {expected!r}")
    fields = parse_wallet_sign_in_message(challenge["message"])
    if fields.domain != expected:
        raise SolanaError(f"refusing to sign: the message signs in to {fields.domain!r}, not to {expected!r}")
    if fields.address != address:
        raise SolanaError("refusing to sign: the message names another wallet's address")
    if fields.nonce != challenge.get("nonce"):
        raise SolanaError("refusing to sign: the message does not carry the challenge's nonce")
    return fields


def wallet_sign_in_body(signer: Any, challenge: Mapping[str, Any], expected_domain: Any, *, name: Optional[str] = None) -> dict[str, Any]:
    """The body of ``POST /api/v1/auth/wallet`` for the ``data`` of ``POST /api/v1/auth/wallet/challenge``:
    ``{address, nonce, signature, message}`` (and ``name``), the signature (base58) over the UTF-8 bytes of the
    challenge's ``message`` exactly as returned. Nothing is signed unless ``check_wallet_challenge`` passes for
    ``expected_domain``, the host[:port] (or base URL) of the router the challenge was fetched from."""
    s = as_signer(signer)
    check_wallet_challenge(challenge, s, expected_domain)
    message = challenge["message"]
    body: dict[str, Any] = {"address": s.address, "nonce": challenge["nonce"], "signature": b58encode(s.sign(message.encode("utf-8"))), "message": message}
    if name:
        body["name"] = name
    return body


# ---- credits ------------------------------------------------------------------------------------------------------------


def deposit_tx_body(amount: Union[str, int, Decimal, float], payer: Any) -> dict[str, str]:
    """The body of ``POST /api/v1/credits/deposit-tx``: ``amount`` in USDC (a decimal string; an ``int`` is base
    units) and the ``payer`` wallet address. The response's ``refund_to`` is the token account a closure refund of
    this deposit returns to (the one it is paid from) and ``accounts.share`` the on-chain record of what this wallet
    put into the key."""
    return {"amount": _usdc_string(amount), "payer": to_address(payer)}


#: What a closure call that still names a destination (or names no payer) is told.
_CLOSURE_NAMES_NO_DESTINATION = (
    "A closure names no destination: the refund returns to the wallets that funded the key, each to the token account "
    "that wallet named on chain, and the API key cannot choose or change it. Pass only payer=, the wallet that pays the "
    "transaction fee."
)
_KEY_HASH = re.compile(r"[0-9a-fA-F]{64}")


def close_credits_body(*args: Any, payer: Any = None, **kwargs: Any) -> dict[str, str]:
    """``close_credits_body(*, payer)``: the body of ``POST /api/v1/credits/close``, ``{"payer": <address>}``, the
    wallet that will sign the returned transaction as fee payer.

    A closure names no destination. What is left of the key's credits returns to the wallets that deposited to it,
    each at most what it put in, to the token account that wallet named on chain (by default the one it paid from).
    The API key cannot choose or change that, so ``refund_to`` is never sent: the router refuses a request that
    carries one (400 ``refund_destination_fixed``). A positional argument (the old ``refund_to`` position), a
    ``refund_to=`` keyword or a missing ``payer`` raises ``SolanaError``.

    The returned ``transaction`` already carries the API key's own signature: add the payer's with
    ``sign_transaction`` and send it before ``expires_at_block_height``; it is null when the closure is already
    registered."""
    if args:
        problem = "A closure request takes no positional argument (that position used to be refund_to)"
    elif "refund_to" in kwargs:
        problem = "A closure request does not take refund_to"
    elif kwargs:
        problem = f"A closure request does not take {', '.join(sorted(kwargs))}"
    elif payer is None:
        problem = "A closure request needs payer="
    else:
        return {"payer": to_address(payer)}
    raise SolanaError(f"{problem}. {_CLOSURE_NAMES_NO_DESTINATION}")


def cancel_close_body(*, payer: Any) -> dict[str, str]:
    """The body of ``POST /api/v1/credits/close/cancel``: ``{"payer": <address>}``, the wallet that will sign the
    returned ``cancel_close`` transaction as fee payer. Like the closure, that transaction arrives signed by the API
    key: ``sign_transaction(response["transaction"], payer_wallet)`` adds the payer's signature and keeps the key's
    byte for byte. A closure can be taken back until anything has been paid."""
    return {"payer": to_address(payer)}


def release_close_body(key: str) -> dict[str, str]:
    """The body of ``POST /api/v1/credits/close/release``: ``{"key": <hash>}``. ``key`` is the 64-hex hash that names
    the key in the API (as ``GET /api/v1/keys`` lists it), never the API key itself. Anything else raises
    ``SolanaError`` before a request exists, so a secret is not posted in place of a hash; the value is not echoed in
    the error. (The ``key_hash`` of a deposit response is the key's on-chain hash, a different value.)"""
    if not isinstance(key, str) or not _KEY_HASH.fullmatch(key):
        raise SolanaError("key must be the key's hash: 64 hex characters, as GET /api/v1/keys lists it. It is not the API key (sk-...): that is a secret and is never sent here.")
    return {"key": key.lower()}


def refund_destination_tx_body(depositor: Any, refund_to: Any) -> dict[str, str]:
    """The body of ``POST /api/v1/credits/refund-destination-tx``: the ``depositor`` wallet that paid into the key and
    the wallet (``refund_to``) whose USDC token account its share of a closure refund should go to from now on. The
    router answers with an unsigned ``set_refund_destination`` transaction whose fee payer and only signer is the
    depositor: ``sign_transaction(response["transaction"], depositor_wallet)``. The API key signs nothing in it and
    cannot make this change; it moves nothing now."""
    return {"depositor": to_address(depositor), "refund_to": to_address(refund_to)}
