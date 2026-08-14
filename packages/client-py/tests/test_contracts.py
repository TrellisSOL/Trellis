"""The router's client-facing contracts, replayed from sdks/fixtures/contracts.json. No network.

The file is written by the router's own code (sdks/fixtures/generate.ts) and read in place; nothing here is signed or
built by hand. It stores no key: each test key is the ed25519 key whose seed is SHA-256("trellis-sdk-fixture:" +
label). Ed25519 signatures are deterministic, so whatever the SDK signs from the same inputs has to equal the file
byte for byte: sign-in, X-Wallet-Auth, a bare signature in X-PAYMENT, the credits closure (which names no destination),
its cancellation, a depositor's refund destination, tabs and vouchers, x402 ``exact`` payments and the refusals a
client has to recognise.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import time
from typing import Any

import httpx
import pytest

from trellis_client import CreditsClosing, PaymentNotBound, Trellis, TrellisError, canonical_json
from trellis_client import solana as S

from .conftest import CONTRACTS as F
from .conftest import fixture_key

WALLET, SESSION, FEE_PAYER, PAYEE, REFUND_TO, SECOND_DEPOSITOR = (fixture_key(label) for label in ("wallet", "session", "fee-payer", "payee", "refund-to", "second-depositor"))
NOW = F["now"]
ROUTER = f"https://{F['host']}"
API_KEY = "sk-test"
CHAT = next(c for c in F["wallet_auth"]["cases"] if c["name"] == "chat_request")


def client_for(handler: Any, api_key: Any = API_KEY, base_url: str = ROUTER) -> Trellis:
    return Trellis(base_url, api_key, http=httpx.Client(transport=httpx.MockTransport(handler)))


def refusal(name: str) -> httpx.Response:
    return httpx.Response(F["errors"][name]["status"], json=F["errors"][name]["body"])


def test_fixture_keys_are_derived_from_their_labels() -> None:
    for name, signer in (("wallet", WALLET), ("session", SESSION), ("fee_payer", FEE_PAYER), ("payee", PAYEE), ("refund_to", REFUND_TO), ("second_depositor", SECOND_DEPOSITOR)):
        assert signer.address == F["keys"][name]["address"]


# ---- 1. wallet sign-in (trellis:wallet:v2) ---------------------------------------------------------------------------------


def test_sign_in_signs_the_challenge_message_exactly_as_returned() -> None:
    sign_in = F["sign_in"]
    assert sign_in["version"] == sign_in["challenge"]["version"] == S.WALLET_SIGN_IN_VERSION
    body = S.wallet_sign_in_body(WALLET, sign_in["challenge"], sign_in["expected_host"], name=sign_in["request"]["name"])
    assert body == sign_in["request"] and body["signature"] == sign_in["signature"] and "timestamp" not in body
    # the expected domain may be given as the base URL the client talks to
    assert S.wallet_sign_in_body(WALLET, sign_in["challenge"], f"{ROUTER}/api/v1", name=sign_in["request"]["name"]) == sign_in["request"]
    fields = S.check_wallet_challenge(sign_in["challenge"], WALLET, sign_in["expected_host"])
    assert (fields.domain, fields.address, fields.nonce) == (sign_in["expected_host"], WALLET.address, sign_in["challenge"]["nonce"])


def test_sign_in_refuses_a_challenge_that_is_not_the_routers_own() -> None:
    sign_in = F["sign_in"]
    good, other, host = sign_in["challenge"], sign_in["other_domain_challenge"], sign_in["expected_host"]
    refused = [
        (WALLET, other, host),  # issued by another site
        (WALLET, {**good, "message": other["message"]}, host),  # the right domain field over another site's message
        (WALLET, {**other, "message": good["message"]}, host),  # the right message under another domain
        (WALLET, good, other["domain"]),  # this client talks to another router
        (PAYEE, good, host),  # the message's second line is another wallet's address
        (WALLET, {**good, "nonce": "0" * 48}, host),  # the message does not carry this challenge's nonce
        (WALLET, {**good, "message": sign_in["retired_v1_message"]}, host),  # the retired v1 text
        (WALLET, {**good, "version": "trellis:wallet:v1"}, host),
        (WALLET, {k: v for k, v in good.items() if k != "message"}, host),  # nothing to sign: a v1 challenge
    ]
    for signer, challenge, expected in refused:
        with pytest.raises(S.SolanaError):
            S.wallet_sign_in_body(signer, challenge, expected)
    assert S.wallet_sign_in_body(WALLET, other, other["domain"])["message"] == other["message"]  # it is a fine challenge of the other site


def test_the_retired_v1_sign_in_message_cannot_be_produced() -> None:
    sign_in = F["sign_in"]
    assert not hasattr(S, "wallet_sign_in_message")  # the only function that built it
    with pytest.raises(TypeError):
        S.wallet_sign_in_body(WALLET, sign_in["challenge"]["nonce"], timestamp=NOW)  # the v1 call: a nonce and a client clock
    with pytest.raises(S.SolanaError):
        S.parse_wallet_sign_in_message(sign_in["retired_v1_message"])
    assert not S.verify_signature(WALLET.address, sign_in["retired_v1_message"].encode(), sign_in["signature"])


class SignInRouter:
    """POST /api/v1/auth/wallet/challenge and /api/v1/auth/wallet as src/api/keys.ts answers them."""

    def __init__(self, challenge: dict) -> None:
        self.challenge = challenge
        self.requests: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        body = json.loads(request.content)
        if request.url.path == "/api/v1/auth/wallet/challenge":
            assert body == {"address": WALLET.address}
            return httpx.Response(200, json={"data": self.challenge})
        assert request.url.path == "/api/v1/auth/wallet"
        if not S.verify_signature(body["address"], self.challenge["message"].encode(), body["signature"]):
            return httpx.Response(401, json={"error": {"code": 401, "message": "Signature does not match the challenge message.", "type": "invalid_wallet_auth"}})
        return httpx.Response(201, json={"data": {"name": body.get("name", "wallet"), "label": "sk-tr-v1-…"}, "key": "sk-issued-by-the-fake-router"})


def test_client_signs_in_with_the_routers_challenge_and_refuses_another_sites() -> None:
    sign_in = F["sign_in"]
    router = SignInRouter(sign_in["challenge"])
    with client_for(router) as client:
        issued = client.wallet_sign_in(WALLET, name=sign_in["request"]["name"])
    assert issued["key"] == "sk-issued-by-the-fake-router" and issued["data"]["name"] == sign_in["request"]["name"]
    assert [r.url.path for r in router.requests] == ["/api/v1/auth/wallet/challenge", "/api/v1/auth/wallet"]
    assert json.loads(router.requests[1].content) == sign_in["request"]
    assert all("authorization" not in r.headers for r in router.requests)  # the client's own key is not sent
    # a challenge for another domain is refused before anything is signed or posted
    phish = SignInRouter(sign_in["other_domain_challenge"])
    with client_for(phish) as client:
        with pytest.raises(S.SolanaError, match="refusing to sign"):
            client.wallet_sign_in(WALLET)
    assert [r.url.path for r in phish.requests] == ["/api/v1/auth/wallet/challenge"]
    # a router reached under another name: the caller says which public host it expects
    internal = SignInRouter(sign_in["challenge"])
    with client_for(internal, base_url="http://127.0.0.1:8787") as client:
        with pytest.raises(S.SolanaError, match="refusing to sign"):
            client.wallet_sign_in(WALLET)
        assert client.wallet_sign_in(WALLET, expected_domain=sign_in["expected_host"])["key"]


# ---- 2. X-Wallet-Auth (trellis:wallet-auth:v2) -----------------------------------------------------------------------------


@pytest.mark.parametrize("case", F["wallet_auth"]["cases"], ids=lambda c: c["name"])
def test_wallet_auth_reproduces_the_routers_message_signature_and_header(case: dict) -> None:
    method, host, path, url, ts, body = case["method"], case["host"], case["path"], case["url"], case["timestamp"], case["body"]
    assert S.wallet_auth_hash(method, path, body) == case["sha256"]
    message = S.wallet_auth_message(method, host, path, ts, case["sha256"])
    assert message == case["message"] and message.startswith(F["wallet_auth"]["version"] + "\n") and not message.endswith("\n")
    assert S.b58encode(WALLET.sign(message.encode("utf-8"))) == case["signature"]
    # from the URL alone, from the path and the router's host, and from the request that is actually sent
    assert S.wallet_auth_header(WALLET, method, url, body, timestamp=ts) == case["header"]
    assert S.wallet_auth_header(WALLET, method.lower(), path, body, host=host.upper(), timestamp=ts) == case["header"]
    request = httpx.Request(method, url, json=body) if body is not None else httpx.Request(method, url)
    assert S.with_wallet_auth(request, WALLET, timestamp=ts).headers["x-wallet-auth"] == case["header"]
    if "canonical_json" in case:
        bound = {k: v for k, v in body.items() if k not in ("stream", "stream_options")} if case["name"] == "chat_request" else body
        assert canonical_json(bound) == case["canonical_json"] and hashlib.sha256(case["canonical_json"].encode("utf-8")).hexdigest() == case["sha256"]
    if "resource" in case:
        assert hashlib.sha256(case["resource"].encode()).hexdigest() == case["sha256"] and case["sha256"] != F["wallet_auth"]["empty_sha256"]


def test_wallet_auth_chat_body_binding_and_number_formatting() -> None:
    body = CHAT["body"]
    assert body["stream"] is True and "stream" not in json.loads(CHAT["canonical_json"]) and "stream_options" not in CHAT["canonical_json"]
    # 1 is written 1 whether it arrives as an int or as a float; non-ASCII characters are emitted as they are
    as_floats = {**body, "top_p": 1.0, "max_tokens": 64.0}
    assert S.wallet_auth_hash("POST", CHAT["path"], as_floats) == CHAT["sha256"]
    assert '"top_p":1,' in CHAT["canonical_json"] and "héllo ✓" in CHAT["canonical_json"] and "\\u" not in CHAT["canonical_json"]
    # the bytes on the wire may be spaced and escaped differently: what is bound is their canonical JSON
    for wire in (json.dumps(body), json.dumps(body, ensure_ascii=False, indent=2).encode("utf-8"), json.dumps(as_floats, sort_keys=True)):
        assert S.wallet_auth_header(WALLET, "POST", CHAT["url"], wire, timestamp=CHAT["timestamp"]) == CHAT["header"]
    # stream and stream_options are left out on the chat routes only
    without = {k: v for k, v in body.items() if k not in ("stream", "stream_options")}
    for path in ("/api/v1/chat/completions", "/api/v1/completions", "/v1/chat/completions", "/v1/completions"):
        assert S.wallet_auth_hash("POST", path, body) == S.wallet_auth_hash("POST", path, without) == CHAT["sha256"]
    assert S.wallet_auth_hash("POST", "/api/v1/network/hosts", body) != CHAT["sha256"]
    # a host resource is url-encoded the way the router encodes it, whatever escapes the path was sent with
    resource = next(c for c in F["wallet_auth"]["cases"] if c["name"] == "host_resource")
    assert S.wallet_auth_hash("GET", "/api/v1/hosts/fixture%20host%2f1") == resource["sha256"] != S.wallet_auth_hash("GET", "/api/v1/hosts")


def test_the_retired_v1_wallet_auth_message_is_not_what_gets_signed() -> None:
    first, retired = F["wallet_auth"]["cases"][0], F["wallet_auth"]["retired_v1_message"]
    assert not S.verify_signature(WALLET.address, retired.encode(), first["signature"])
    assert S.b58encode(WALLET.sign(retired.encode())) != first["signature"]
    with pytest.raises(TypeError):
        S.wallet_auth_header(WALLET, b"", timestamp=first["timestamp"])  # the v1 call: a body and nothing about the request
    with pytest.raises(TypeError):
        S.wallet_auth_message(first["timestamp"], first["sha256"])


def test_the_wallet_header_is_for_the_request_the_client_sends() -> None:
    seen: list[httpx.Request] = []

    def router(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json={"id": "gen-1", "choices": [{"message": {"role": "assistant", "content": "hi"}}]})

    # chat() does not stream; the two members that only say how the answer is delivered are not part of what is signed
    body = {k: v for k, v in CHAT["body"].items() if k not in ("stream", "stream_options")}
    with client_for(router, api_key=None) as client:
        header = Trellis.wallet_auth_header(WALLET, "POST", f"{client.base_url}{CHAT['path']}", body, timestamp=CHAT["timestamp"])
        assert header == CHAT["header"]
        client.chat(body, headers={S.WALLET_AUTH_HEADER: header})
    sent = seen[0]
    assert (sent.method, str(sent.url)) == ("POST", CHAT["url"]) and sent.headers["x-wallet-auth"] == CHAT["header"] and "authorization" not in sent.headers
    # the header that went out is the one for the bytes that went out
    assert S.wallet_auth_header(WALLET, sent.method, sent.url, sent.content, timestamp=CHAT["timestamp"]) == sent.headers["x-wallet-auth"]
    assert canonical_json(json.loads(sent.content)) == CHAT["canonical_json"]
    # a router reached under another name: the public host is what is signed
    assert Trellis.wallet_auth_header(WALLET, "POST", f"http://10.0.0.5:8787{CHAT['path']}", body, host=CHAT["host"], timestamp=CHAT["timestamp"]) == CHAT["header"]


# ---- 3. a bare transaction signature in X-PAYMENT needs X-Wallet-Auth --------------------------------------------------------


class LandedPaymentRouter:
    """src/solana/percall.ts: a bare signature is redeemed only with X-Wallet-Auth from the wallet that paid."""

    def __init__(self) -> None:
        self.requests: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if request.headers.get("x-payment") and request.headers.get("x-wallet-auth") != CHAT["header"]:
            return refusal("payment_not_bound_to_caller")
        return httpx.Response(200, json={"id": "gen-1", "choices": [{"message": {"role": "assistant", "content": "paid"}}]})


def test_a_bare_payment_signature_goes_out_with_the_wallet_header() -> None:
    not_bound = F["errors"]["payment_not_bound_to_caller"]
    landed = not_bound["body"]["error"]["metadata"]["tx"]
    assert not_bound["body"]["error"]["type"] == S.PAYMENT_NOT_BOUND and not_bound["status"] == 401
    request = httpx.Request("POST", CHAT["url"], json=CHAT["body"])
    paid = S.with_payment_signature(request, landed, WALLET, timestamp=CHAT["timestamp"])
    # the signature as it is, and the wallet header over this same request: exactly the router's chat vector
    assert paid.headers["x-payment"] == landed and paid.headers["x-wallet-auth"] == CHAT["header"]
    assert (paid.method, paid.url, paid.content) == (request.method, request.url, request.content) and "x-payment" not in request.headers
    for bad in ("", "not-a-signature", WALLET.address, S.x402_payment_header("dHg=", S.DEVNET)):
        with pytest.raises(S.SolanaError):
            S.with_payment_signature(request, bad, WALLET)
    router = LandedPaymentRouter()
    body = {k: v for k, v in CHAT["body"].items() if k not in ("stream", "stream_options")}
    with client_for(router, api_key=None) as client:
        with httpx.Client(transport=httpx.MockTransport(router)) as http:
            assert http.send(paid).json()["id"] == "gen-1"
        # through chat(): both headers of the same request
        assert client.chat(body, headers={S.PAYMENT_HEADER: landed, S.WALLET_AUTH_HEADER: paid.headers["x-wallet-auth"]})["id"] == "gen-1"
        # without the wallet header the router's refusal surfaces as its own error
        with pytest.raises(PaymentNotBound) as info:
            client.chat(body, headers={S.PAYMENT_HEADER: landed})
    error = info.value
    assert isinstance(error, TrellisError) and (error.status, error.code, error.tx) == (401, S.PAYMENT_NOT_BOUND, landed)
    assert str(error) == not_bound["body"]["error"]["message"] and error.details == not_bound["body"]["error"]["metadata"]
    assert len(router.requests) == 3  # one send each: not retried


# ---- 4. credits closure: no destination, the key's signature kept, a depositor's own refund destination ---------------------

CLOSURE = F["closure"]
CANCEL, RELEASE, MOVE, DEPOSIT, CLOSURES = (CLOSURE[name] for name in ("cancel", "release", "refund_destination", "deposit", "list"))
#: What an old-style closure call is told, in plain words.
NO_DESTINATION = r"names no destination.*returns to the wallets that funded the key.*cannot choose or change it.*only payer="
CLOSURE_FIELDS = {"id", "status", "payer", "authority", "payable_at", "transaction", "message", "accounts", "expires_at_block_height", "signed_by_key", "requested_by", "owner", "refunds", "note"}
CLOSURE_ROW_FIELDS = {"id", "status", "reason", "refund_to", "refunds", "amount_units", "requested_at", "payable_at", "paid_at", "register_tx", "pay_tx", "cancel_tx", "released_at"}
#: Calls written for the earlier contract: a destination in the first position or as refund_to=, or no payer at all.
OLD_STYLE_CALLS = [
    ("positional", (REFUND_TO,), {}),
    ("positional_address", (REFUND_TO.address,), {}),
    ("positional_with_payer", (REFUND_TO,), {"payer": WALLET}),
    ("refund_to_keyword", (), {"refund_to": REFUND_TO}),
    ("refund_to_keyword_with_payer", (), {"refund_to": REFUND_TO.address, "payer": WALLET}),
    ("no_payer", (), {}),
    ("payer_none", (), {"payer": None}),
    ("another_keyword", (), {"payer": WALLET, "destination": REFUND_TO}),
]
#: Values that are not a key's hash, the API key itself among them. None of them may be sent.
NOT_A_KEY_HASH = [API_KEY, "sk-tr-v1-" + "ab" * 32, "sk-" + "ab" * 32, "", CLOSURE["key_hash"][:-1], CLOSURE["key_hash"] + "0", "0x" + CLOSURE["key_hash"], "g" * 64, " " + CLOSURE["key_hash"], CLOSURE["key_address"], None, 7, bytes.fromhex(CLOSURE["key_hash"])]


def envelope(case: dict) -> httpx.Response:
    return httpx.Response(case["status"], json=case["body"])


class ClosureRouter:
    """Answers the credits routes with the fixture's responses, or with one refusal when ``refuse`` is set."""

    ANSWERS = {
        ("POST", "/api/v1/credits/deposit-tx"): (200, DEPOSIT["response"]),
        ("POST", "/api/v1/credits/close"): (201, CLOSURE["response"]),
        ("POST", "/api/v1/credits/close/cancel"): (200, CANCEL["response"]),
        ("POST", "/api/v1/credits/close/release"): (200, RELEASE["response"]),
        ("POST", "/api/v1/credits/refund-destination-tx"): (200, MOVE["response"]),
        ("GET", "/api/v1/credits/close"): (200, CLOSURES["response"]),
    }

    def __init__(self, refuse: Any = None) -> None:
        self.requests: list[httpx.Request] = []
        self.refuse = refuse

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if self.refuse is not None:
            return envelope(self.refuse)
        status, data = self.ANSWERS[(request.method, request.url.path)]
        return httpx.Response(status, json={"data": data})

    def sent(self, index: int = -1) -> tuple:
        """(method, path, JSON body, Authorization) of one request."""
        r = self.requests[index]
        return r.method, r.url.path, json.loads(r.content) if r.content else None, r.headers.get("authorization")


def check_signed_by_the_key(case: dict, transaction: str) -> None:
    """A transaction the router signed as the key: the payer adds its signature in slot 0 and nothing else changes."""
    unsigned = S.parse_transaction(transaction)
    index = case["key_signature_index"]
    assert unsigned.signers == case["signers"] == [WALLET.address, CLOSURE["key_address"]] and unsigned.fee_payer == case["payer"] == WALLET.address
    assert base64.b64encode(unsigned.message).decode() == case["message_base64"]
    assert len(unsigned.instructions) == case["instruction_count"] == 1
    # as it arrives: the key has signed, the payer's slot is empty
    assert unsigned.signature_of(WALLET) is None and S.b58encode(unsigned.signatures[index]) == case["key_signature_base58"]
    assert S.verify_signature(case["signers"][index], unsigned.message, unsigned.signatures[index])
    signed = S.sign_transaction(transaction, WALLET)
    assert signed == case["signed_transaction"]
    after = S.parse_transaction(signed)
    assert after.message == unsigned.message and after.signatures[index] == unsigned.signatures[index]  # the key's signature, byte for byte
    assert S.b58encode(after.signatures[0]) == case["payer_signature_base58"] and S.verify_signature(WALLET.address, after.message, after.signatures[0])
    assert S.sign_transaction(signed, WALLET) == signed  # signing again changes nothing
    for other in (REFUND_TO, SECOND_DEPOSITOR):
        with pytest.raises(S.SolanaError, match="not a required signer"):
            S.sign_transaction(transaction, other)  # only the payer named in the request can add its signature


def test_closure_payer_adds_one_signature_and_keeps_the_keys() -> None:
    assert S.close_credits_body(payer=WALLET) == S.close_credits_body(payer=WALLET.address) == CLOSURE["request"] == {"payer": WALLET.address}
    check_signed_by_the_key(CLOSURE, CLOSURE["response"]["transaction"])
    # a closure that is already registered has nothing to sign
    assert CLOSURE["response_already_registered"]["transaction"] is None
    with pytest.raises(S.SolanaError, match="no transaction"):
        S.sign_transaction(CLOSURE["response_already_registered"]["transaction"], WALLET)


@pytest.mark.parametrize("args,kwargs", [c[1:] for c in OLD_STYLE_CALLS], ids=[c[0] for c in OLD_STYLE_CALLS])
def test_a_closure_call_that_names_a_destination_raises_and_sends_nothing(args: tuple, kwargs: dict) -> None:
    with pytest.raises(S.SolanaError, match=NO_DESTINATION) as built:
        S.close_credits_body(*args, **kwargs)
    assert isinstance(built.value, ValueError)
    router = ClosureRouter()
    with client_for(router) as client:
        with pytest.raises(S.SolanaError, match=NO_DESTINATION):
            client.close_credits(*args, **kwargs)
    assert router.requests == []  # nothing was sent: the call did not quietly become a closure paid for by that wallet


def test_closure_through_the_client() -> None:
    answers = [httpx.Response(201, json={"data": CLOSURE["response"]}), httpx.Response(200, json={"data": CLOSURE["response_already_registered"]})]
    seen: list[httpx.Request] = []

    def router(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return answers[len(seen) - 1]

    with client_for(router) as client:
        first = client.close_credits(payer=WALLET)
        again = client.close_credits(payer=WALLET.address)
    assert all((r.method, r.url.path, json.loads(r.content), r.headers["authorization"]) == ("POST", "/api/v1/credits/close", CLOSURE["request"], f"Bearer {API_KEY}") for r in seen)
    assert len(seen) == 2 and all("refund_to" not in json.loads(r.content) for r in seen)  # a closure never names a destination
    assert set(CLOSURE["response"]) == CLOSURE_FIELDS and "refund_to" not in CLOSURE["response"]
    assert first == CLOSURE["response"]
    assert first["signed_by_key"] is True and first["payer"] == WALLET.address and first["expires_at_block_height"] == CLOSURE["response"]["expires_at_block_height"]
    assert S.sign_transaction(first["transaction"], WALLET) == CLOSURE["signed_transaction"]
    # who is paid back: one row per wallet that deposited, to the token account that wallet named
    assert first["refunds"] == CLOSURE["response"]["refunds"] and [r["depositor"] for r in first["refunds"]] == [WALLET.address, SECOND_DEPOSITOR.address]
    assert all(set(r) == {"depositor", "refund_to", "deposited_units", "refunded_units"} for r in first["refunds"])
    assert first["refunds"][0]["refund_to"] == DEPOSIT["response"]["refund_to"] and first["refunds"][1]["refund_to"] == MOVE["response"]["accounts"]["refundToToken"]
    assert again == CLOSURE["response_already_registered"] and again["status"] == "registered" and again["transaction"] is None and again["refunds"] == first["refunds"]


def test_cancel_is_finished_like_the_closure() -> None:
    assert S.cancel_close_body(payer=WALLET) == CANCEL["request"] == {"payer": WALLET.address}
    with pytest.raises(TypeError):
        S.cancel_close_body(WALLET)  # keyword only, like the closure
    check_signed_by_the_key(CANCEL, CANCEL["response"]["transaction"])
    assert CANCEL["signed_transaction"] != CLOSURE["signed_transaction"] and CANCEL["key_signature_base58"] != CLOSURE["key_signature_base58"]
    router = ClosureRouter()
    with client_for(router) as client:
        cancel = client.cancel_credit_closure(payer=WALLET)
        with pytest.raises(TypeError):
            client.cancel_credit_closure(WALLET)  # type: ignore[misc]
    assert router.sent() == ("POST", "/api/v1/credits/close/cancel", CANCEL["request"], f"Bearer {API_KEY}") and len(router.requests) == 1
    assert cancel == CANCEL["response"] and cancel["signed_by_key"] is True and cancel["payer"] == WALLET.address
    assert set(cancel) == {"transaction", "message", "accounts", "payer", "expires_at_block_height", "signed_by_key", "note"}
    assert cancel["accounts"] == CLOSURE["response"]["accounts"]  # the same refund request the closure opened
    assert S.sign_transaction(cancel["transaction"], WALLET) == CANCEL["signed_transaction"]


def test_release_takes_the_keys_hash_and_never_the_key() -> None:
    assert S.release_close_body(CLOSURE["key_hash"]) == S.release_close_body(CLOSURE["key_hash"].upper()) == RELEASE["request"] == {"key": CLOSURE["key_hash"]}
    assert CLOSURE["key_hash"] != DEPOSIT["response"]["key_hash"]  # a deposit names the key's on-chain hash: another value
    router = ClosureRouter()
    with client_for(router) as client:
        released = client.release_credit_closure(CLOSURE["key_hash"])
        assert router.sent() == ("POST", "/api/v1/credits/close/release", RELEASE["request"], f"Bearer {API_KEY}") and len(router.requests) == 1
        assert released == RELEASE["response"] and released[0]["released"] is True and set(released[0]) == {"id", "status", "released", "payable_at"}
        for bad in NOT_A_KEY_HASH:
            for call in (S.release_close_body, client.release_credit_closure):
                with pytest.raises(S.SolanaError, match="the key's hash") as info:
                    call(bad)
                assert not isinstance(bad, str) or len(bad) < 8 or bad not in str(info.value)  # a secret is not repeated in the error
    assert len(router.requests) == 1  # none of them was sent
    # what puts a closure on hold: disabling its key (DELETE /api/v1/keys/{hash}); this client has no key management call
    held = RELEASE["key_disabled_response"]["data"]["closure_held"]
    assert held == {"id": RELEASE["response"][0]["id"], "reason": S.CLOSURE_KEY_DISABLED, "release": "POST /api/v1/credits/close/release"}
    assert RELEASE["key_disabled_response"]["data"]["hash"] == CLOSURE["key_hash"]


def test_a_refund_destination_is_moved_by_the_depositor_alone() -> None:
    assert S.refund_destination_tx_body(WALLET, REFUND_TO) == S.refund_destination_tx_body(WALLET.address, REFUND_TO.address) == MOVE["request"]
    assert MOVE["request"] == {"depositor": WALLET.address, "refund_to": REFUND_TO.address}
    unsigned = S.parse_transaction(MOVE["response"]["transaction"])
    # unsigned as it arrives; the depositor is the fee payer and the only signer, and the API key is not in it at all
    assert unsigned.signers == MOVE["signers"] == [WALLET.address] and unsigned.fee_payer == WALLET.address
    assert all(not any(sig) for sig in unsigned.signatures) and unsigned.signature_of(WALLET) is None
    assert S.to_pubkey(CLOSURE["key_address"]) not in unsigned.account_keys
    assert base64.b64encode(unsigned.message).decode() == MOVE["message_base64"] and len(unsigned.instructions) == MOVE["instruction_count"]
    signed = S.sign_transaction(MOVE["response"]["transaction"], WALLET)
    assert signed == MOVE["signed_transaction"]
    after = S.parse_transaction(signed)
    assert after.message == unsigned.message and S.b58encode(after.signatures[0]) == MOVE["depositor_signature_base58"]
    assert S.verify_signature(WALLET.address, after.message, after.signatures[0])
    for other in (REFUND_TO, SECOND_DEPOSITOR, PAYEE):  # not the new destination, not another depositor, nobody else
        with pytest.raises(S.SolanaError, match="not a required signer"):
            S.sign_transaction(MOVE["response"]["transaction"], other)
    router = ClosureRouter()
    with client_for(router) as client:
        change = client.refund_destination_tx(WALLET, REFUND_TO)
    assert router.sent() == ("POST", "/api/v1/credits/refund-destination-tx", MOVE["request"], f"Bearer {API_KEY}") and len(router.requests) == 1
    assert change == MOVE["response"] and set(change) == {"transaction", "message", "accounts", "depositor", "refund_to", "current_refund_to", "expires_at_block_height", "note"}
    assert set(change["accounts"]) == {"share", "refundToToken"} and change["current_refund_to"] == DEPOSIT["response"]["refund_to"]
    assert S.sign_transaction(change["transaction"], WALLET) == MOVE["signed_transaction"]


def check_deposit(deposit: Any) -> None:
    assert deposit == DEPOSIT["response"]
    # where a closure refund of this deposit returns to: the token account it is paid from, recorded in the wallet's share
    assert deposit["refund_to"] == deposit["accounts"]["depositorToken"] == CLOSURE["response"]["refunds"][0]["refund_to"]
    assert deposit["accounts"]["share"] == MOVE["response"]["accounts"]["share"] and set(deposit["accounts"]) == {"credit", "vault", "depositorToken", "share"}
    assert "refund-destination-tx" in deposit["note"]
    assert S.parse_transaction(deposit["transaction"]).signers == [WALLET.address]  # unsigned, for the paying wallet alone


def test_a_deposit_says_where_its_refund_returns_to() -> None:
    assert S.deposit_tx_body("25", WALLET) == DEPOSIT["request"]
    router = ClosureRouter()
    with client_for(router) as client:
        check_deposit(client.deposit_tx("25", WALLET))
    assert router.sent() == ("POST", "/api/v1/credits/deposit-tx", DEPOSIT["request"], f"Bearer {API_KEY}") and len(router.requests) == 1


def check_closure_rows(rows: Any) -> None:
    assert list(S.CLOSURE_STATUSES) == CLOSURES["statuses"] and list(S.CLOSURE_REASONS) == CLOSURES["reasons"] and list(S.REFUND_STATUSES) == CLOSURES["refund_statuses"]
    assert rows == CLOSURES["response"] and len(rows) == 4
    for row in rows:
        assert set(row) == CLOSURE_ROW_FIELDS and row["status"] in S.CLOSURE_STATUSES and (row["reason"] is None or row["reason"] in S.CLOSURE_REASONS)
        for refund in row["refunds"]:
            assert set(refund) == {"depositor", "refund_to", "owner", "amount_units", "status", "reason", "tx"}
            assert refund["status"] in S.REFUND_STATUSES and (refund["reason"] is None or refund["reason"] in S.CLOSURE_REASONS)
    held, limited, cancelled, paid = rows
    assert (held["status"], held["reason"], held["released_at"]) == ("registered", S.CLOSURE_KEY_DISABLED, None)  # waiting for an owner, not failed
    assert [r["status"] for r in limited["refunds"]] == ["paid", "planned"] and limited["released_at"] is not None and limited["refund_to"] is None
    assert (cancelled["status"], cancelled["reason"]) == ("cancelled", "cancelled_on_chain") and cancelled["cancel_tx"] and cancelled["refunds"] == []
    assert paid["status"] == "paid" and paid["refund_to"] == ",".join(r["owner"] for r in paid["refunds"]) and all(r["tx"] for r in paid["refunds"])


def test_closures_list_the_refund_plan() -> None:
    router = ClosureRouter()
    with client_for(router) as client:
        check_closure_rows(client.credit_closures())
    assert router.sent() == ("GET", "/api/v1/credits/close", None, f"Bearer {API_KEY}") and len(router.requests) == 1


#: The router's refusals on the closure routes: (the envelope, the call that meets it, error.code).
CLOSURE_REFUSALS = [
    ("refund_destination_fixed", CLOSURE["refused_with_refund_to"], lambda c: c.close_credits(payer=WALLET), S.REFUND_DESTINATION_FIXED),
    ("nothing_to_cancel", CANCEL["errors"]["nothing_to_cancel"], lambda c: c.cancel_credit_closure(payer=WALLET), S.NOTHING_TO_CANCEL),
    ("refund_in_progress", CANCEL["errors"]["refund_in_progress"], lambda c: c.cancel_credit_closure(payer=WALLET), S.REFUND_IN_PROGRESS),
    ("release_not_found", RELEASE["errors"]["not_found"], lambda c: c.release_credit_closure(CLOSURE["key_hash"]), "not_found"),
    ("refund_destination_not_found", MOVE["errors"]["not_found"], lambda c: c.refund_destination_tx(REFUND_TO, REFUND_TO), "not_found"),
]
REFUSAL_STATUS = {"refund_destination_fixed": 400, "nothing_to_cancel": 400, "refund_in_progress": 409, "release_not_found": 404, "refund_destination_not_found": 404}


@pytest.mark.parametrize("name,case,call,code", CLOSURE_REFUSALS, ids=[r[0] for r in CLOSURE_REFUSALS])
def test_closure_refusals_keep_the_routers_reason(name: str, case: dict, call: Any, code: str) -> None:
    router = ClosureRouter(refuse=case)
    with client_for(router) as client:
        with pytest.raises(TrellisError) as info:
            call(client)
    error = info.value
    assert not isinstance(error, CreditsClosing)
    assert (error.status, error.code) == (case["status"], code) == (REFUSAL_STATUS[name], case["body"]["error"]["type"])
    assert str(error) == case["body"]["error"]["message"]
    assert len(router.requests) == 1  # sent once: a refusal is not retried
    sent = json.loads(router.requests[0].content)
    if name == "refund_destination_fixed":
        # the envelope answers a request that names a destination; this client cannot send one, whatever it is asked
        assert "refund_to" in case["request"] and sent == CLOSURE["request"] and "refund_to" not in sent
    elif "request" in case:
        assert sent == case["request"]


# ---- 5. tabs: instructions, the account, vouchers ----------------------------------------------------------------------------

TAB = F["tab"]
PROGRAM, TAB_ADDRESS, CREATED_AT = TAB["program_id"], TAB["tab"], int(TAB["tab_account"]["created_at"])


def same_instruction(ix: S.Instruction, expected: dict) -> bool:
    keys = [{"pubkey": a.address, "is_signer": a.is_signer, "is_writable": a.is_writable} for a in ix.accounts]
    return ix.program == expected["program_id"] and keys == expected["keys"] and ix.data.hex() == expected["data_hex"] and base64.b64encode(ix.data).decode() == expected["data_base64"]


def same_accounts_and_data(ix: S.Instruction, expected: dict) -> bool:
    """As ``same_instruction``, for an instruction read back from a compiled message: there an account's flags are the
    union of its uses in the whole transaction (the fee payer is always writable), so only the order and data compare."""
    return ix.program == expected["program_id"] and [a.address for a in ix.accounts] == [k["pubkey"] for k in expected["keys"]] and ix.data.hex() == expected["data_hex"]


def test_tab_addresses() -> None:
    assert S.tab_config_address(PROGRAM) == TAB["pdas"]["config"]
    assert S.tab_address(PROGRAM, TAB["payer"], TAB["payee"], int(TAB["tab_id"])) == TAB["pdas"]["tab"] == TAB_ADDRESS
    assert S.tab_escrow_address(PROGRAM, TAB_ADDRESS) == TAB["pdas"]["escrow"]
    assert S.rules_config_address(TAB["rules_program_id"]) == TAB["rulebook"]["rules_config"]
    assert S.tab_enforcer_address(PROGRAM) == TAB["instructions"]["open_tab"]["keys"][-1]["pubkey"]
    assert (TAB["payer"], TAB["payee"], TAB["session"], TAB["mint"]) == (WALLET.address, PAYEE.address, SESSION.address, S.USDC_MINT)


def test_tab_instructions_match_the_routers_account_lists() -> None:
    expected, book = TAB["instructions"], TAB["rulebook"]
    cap, expiry, tab_id = int(TAB["cap"]), int(TAB["expiry"]), int(TAB["tab_id"])
    opened = S.open_tab_instruction(PROGRAM, WALLET, PAYEE, cap, expiry, SESSION, tab_id, now=NOW)
    assert same_instruction(opened, expected["open_tab"])
    bound = S.open_tab_instruction(PROGRAM, WALLET, PAYEE, cap, expiry, SESSION, tab_id, book["rulebook"], rules_program=book["rules_program"], now=NOW)
    assert same_instruction(bound, expected["open_tab_with_rulebook"])
    with pytest.raises(S.SolanaError, match="rules_program"):
        S.open_tab_instruction(PROGRAM, WALLET, PAYEE, cap, expiry, SESSION, tab_id, book["rulebook"], now=NOW)
    amount = int(expected["top_up"]["amount"])
    assert same_instruction(S.top_up_instruction(PROGRAM, WALLET, TAB_ADDRESS, amount), expected["top_up"])
    assert same_instruction(S.top_up_instruction(PROGRAM, WALLET, TAB_ADDRESS, amount, rulebook=book["rulebook"], rules_program=book["rules_program"]), expected["top_up_with_rulebook"])
    reclaim = S.reclaim_instruction(PROGRAM, WALLET, PAYEE, TAB_ADDRESS)
    assert same_instruction(reclaim, expected["reclaim"]) and not any(a.is_signer for a in reclaim.accounts)
    # close and reclaim take no rulebook account, whatever the tab was opened with
    rule_accounts = set(book.values())
    assert not rule_accounts & {a.address for a in reclaim.accounts} and not rule_accounts & {k["pubkey"] for k in expected["close"]["instructions"][1]["keys"]}
    # the transactions around them: the wallet is the only signer of open_tab and top_up, anyone sends a reclaim
    blockhash = F["x402"]["recent_blockhash"]
    tx = S.parse_transaction(S.open_tab_transaction(PROGRAM, WALLET, PAYEE, cap, expiry, SESSION, tab_id, book["rulebook"], rules_program=book["rules_program"], recent_blockhash=blockhash, now=NOW).transaction)
    assert tx.signers == [WALLET.address] and same_instruction(tx.instructions[0], expected["open_tab_with_rulebook"]) and S.verify_signature(WALLET.address, tx.message, tx.signatures[0])
    tx = S.parse_transaction(S.top_up_transaction(PROGRAM, WALLET, TAB_ADDRESS, amount, recent_blockhash=blockhash))
    assert tx.signers == [WALLET.address] and same_accounts_and_data(tx.instructions[0], expected["top_up"]) and S.verify_signature(WALLET.address, tx.message, tx.signatures[0])
    tx = S.parse_transaction(S.reclaim_transaction(PROGRAM, WALLET.address, PAYEE, TAB_ADDRESS, REFUND_TO, recent_blockhash=blockhash))
    assert tx.signers == [REFUND_TO.address] and same_instruction(tx.instructions[0], expected["reclaim"])


def test_a_tab_expires_within_thirty_days() -> None:
    limit = TAB["max_lifetime_seconds"]
    cap, tab_id = int(TAB["cap"]), int(TAB["tab_id"])
    assert S.MAX_TAB_LIFETIME_SECONDS == limit == 30 * 86_400
    assert S.open_tab_instruction(PROGRAM, WALLET, PAYEE, cap, NOW + limit, SESSION, tab_id, now=NOW).data[24:32] == (NOW + limit).to_bytes(8, "little")
    with pytest.raises(S.SolanaError, match="30 days"):
        S.open_tab_instruction(PROGRAM, WALLET, PAYEE, cap, NOW + limit + 1, SESSION, tab_id, now=NOW)
    with pytest.raises(S.SolanaError, match="30 days"):
        S.open_tab_transaction(PROGRAM, WALLET, PAYEE, cap, NOW + limit + 1, SESSION, tab_id, recent_blockhash=F["x402"]["recent_blockhash"], now=NOW)
    with pytest.raises(S.SolanaError, match="30 days"):
        S.open_tab_transaction(PROGRAM, WALLET, PAYEE, cap, int(time.time()) + limit + 3600, SESSION, tab_id, recent_blockhash=F["x402"]["recent_blockhash"])


def test_tab_account_gives_the_created_at_vouchers_are_signed_with() -> None:
    stored = TAB["tab_account"]
    data = base64.b64decode(stored["data_base64"])
    account = S.decode_tab_account(data)
    assert (account.payer, account.payee, account.session_key, account.mint, account.tab_id) == (WALLET.address, PAYEE.address, SESSION.address, TAB["mint"], int(TAB["tab_id"]))
    assert (str(account.created_at), str(account.cap), str(account.expiry), str(account.posted_used), str(account.posted_seq), account.rulebook) == (stored["created_at"], stored["cap"], stored["expiry"], stored["posted_used"], stored["posted_seq"], stored["rulebook"])
    rpc = "https://rpc.test"
    answers: dict[str, Any] = {"owner": PROGRAM, "exists": True}
    asked: list[dict] = []

    def node(request: httpx.Request) -> httpx.Response:
        asked.append(json.loads(request.content))
        value = {"data": [stored["data_base64"], "base64"], "executable": False, "lamports": 2_000_000, "owner": answers["owner"], "rentEpoch": 0, "space": len(data)} if answers["exists"] else None
        return httpx.Response(200, json={"jsonrpc": "2.0", "id": 1, "result": {"context": {"slot": 1}, "value": value}})

    with httpx.Client(transport=httpx.MockTransport(node)) as http:
        read = S.fetch_tab_account(rpc, PROGRAM, TAB_ADDRESS, http)
        assert read == account and asked[0]["method"] == "getAccountInfo" and asked[0]["params"] == [TAB_ADDRESS, {"encoding": "base64", "commitment": "confirmed"}]
        # the payer's side of the tab, from what the chain says
        session = S.TabSession(TAB_ADDRESS, SESSION, PROGRAM, read.created_at, cap=read.cap)
        assert session.voucher(int(TAB["voucher"]["cases"][0]["cumulative_used"])).headers == TAB["voucher"]["cases"][0]["headers"]
        # Tab-shaped bytes under another owner, or at an address that is not the tab's own, are not a tab
        with pytest.raises(S.SolanaError, match="tab address"):
            S.fetch_tab_account(rpc, PROGRAM, TAB["pdas"]["escrow"], http)
        answers["owner"] = TAB["rules_program_id"]
        with pytest.raises(S.SolanaError, match="tab program"):
            S.fetch_tab_account(rpc, PROGRAM, TAB_ADDRESS, http)
        answers["exists"] = False
        assert S.fetch_tab_account(rpc, PROGRAM, TAB_ADDRESS, http) is None  # never opened, closed or reclaimed


def test_async_fetch_tab_account() -> None:
    stored = TAB["tab_account"]

    def node(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"jsonrpc": "2.0", "id": 1, "result": {"context": {"slot": 1}, "value": {"data": [stored["data_base64"], "base64"], "owner": PROGRAM}}})

    async def read() -> Any:
        async with httpx.AsyncClient(transport=httpx.MockTransport(node)) as http:
            return await S.async_fetch_tab_account("https://rpc.test", PROGRAM, TAB_ADDRESS, http)

    account = asyncio.run(read())
    assert account is not None and str(account.created_at) == stored["created_at"]


@pytest.mark.parametrize("case", TAB["voucher"]["cases"], ids=lambda c: f"seq-{c['seq']}")
def test_vouchers_reproduce_the_routers_bytes_signature_headers_and_wire(case: dict) -> None:
    used, seq, created_at = int(case["cumulative_used"]), int(case["seq"]), int(case["created_at"])
    assert (case["program_id"], created_at) == (PROGRAM, CREATED_AT)
    message = S.voucher_message(PROGRAM, TAB_ADDRESS, created_at, used, seq)
    assert message.hex() == case["message_hex"] and base64.b64encode(message).decode() == case["message_base64"] and len(message) == TAB["voucher"]["length"] == S.VOUCHER_MESSAGE_LEN
    for part in TAB["voucher"]["layout"]:  # the six fields, where the router puts them
        piece = message[part["offset"] : part["offset"] + part["length"]]
        want = {"domain": TAB["voucher"]["domain"].encode("ascii"), "program_id": S.to_pubkey(PROGRAM), "tab": S.to_pubkey(TAB_ADDRESS), "created_at": created_at.to_bytes(8, "little", signed=True), "cumulative_used": used.to_bytes(8, "little"), "seq": seq.to_bytes(8, "little")}
        assert piece == want[part["field"]]
    signature = S.sign_voucher(SESSION, PROGRAM, TAB_ADDRESS, created_at, used, seq)
    assert S.b58encode(signature) == case["signature_base58"] and base64.b64encode(signature).decode() == case["signature_base64"]
    assert S.verify_voucher(PROGRAM, TAB_ADDRESS, created_at, used, seq, case["signature_base58"], SESSION.address)
    # the session signs the next sequence number
    voucher = S.TabSession(TAB_ADDRESS, SESSION, PROGRAM, created_at, seq=seq - 1, cap=int(TAB["cap"])).voucher(used)
    assert voucher.headers == case["headers"] and voucher.signature == signature and voucher.verify()
    wire = voucher.wire
    assert wire.pop("session_key") == SESSION.address and wire == case["wire"]
    parsed = S.parse_voucher_header(case["headers"]["X-Trellis-Tab-Voucher"], PROGRAM, created_at, case["headers"]["X-Trellis-Tab"], SESSION)
    assert parsed == voucher and parsed.verify()


def test_vouchers_for_another_opening_another_program_or_the_old_form_are_not_this_tabs() -> None:
    others = TAB["voucher"]["not_for_this_tab"]
    for name in ("reopened_later", "another_program"):
        other = others[name]
        used, seq = int(other["cumulative_used"]), int(other["seq"])
        # it is a genuine voucher of the same session key for the same tab address...
        assert S.verify_voucher(other["program_id"], TAB_ADDRESS, int(other["created_at"]), used, seq, other["signature_base58"], SESSION.address)
        # ...and nothing for this program and this opening of the tab
        assert not S.verify_voucher(PROGRAM, TAB_ADDRESS, CREATED_AT, used, seq, other["signature_base58"], SESSION.address)
        with pytest.raises(S.SolanaError, match="another"):
            S.parse_voucher_header(other["headers"]["X-Trellis-Tab-Voucher"], PROGRAM, CREATED_AT, TAB_ADDRESS, SESSION)
        assert S.voucher_message(PROGRAM, TAB_ADDRESS, CREATED_AT, used, seq).hex() != other["message_hex"]
    retired = others["retired_48_byte_form"]
    first = TAB["voucher"]["cases"][0]
    used, seq = int(first["cumulative_used"]), int(first["seq"])
    assert len(bytes.fromhex(retired["message_hex"])) == 48 and bytes.fromhex(retired["message_hex"]) == S.to_pubkey(TAB_ADDRESS) + used.to_bytes(8, "little") + seq.to_bytes(8, "little")
    assert not S.verify_voucher(PROGRAM, TAB_ADDRESS, CREATED_AT, used, seq, retired["signature_base58"], SESSION.address)
    with pytest.raises(S.SolanaError, match="48-byte"):
        S.parse_voucher_header(f"{retired['message_base64']}.{retired['signature_base64']}", PROGRAM, CREATED_AT, TAB_ADDRESS, SESSION)
    # the SDK has no way left to sign it: the program id and created_at are required everywhere
    for old_call in (lambda: S.voucher_message(TAB_ADDRESS, used, seq), lambda: S.sign_voucher(SESSION, TAB_ADDRESS, used, seq), lambda: S.TabSession(TAB_ADDRESS, SESSION), lambda: S.parse_voucher_header(first["headers"]["X-Trellis-Tab-Voucher"])):
        with pytest.raises(TypeError):
            old_call()
    assert S.b58encode(S.sign_voucher(SESSION, PROGRAM, TAB_ADDRESS, CREATED_AT, used, seq)) != retired["signature_base58"]


# ---- 6. x402 `exact`: inside what the router's fee payer signs ---------------------------------------------------------------

X402 = F["x402"]
REQUIREMENT = S.PaymentRequirement.from_v1(X402["requirement"])
BLOCKHASH = X402["recent_blockhash"]


def options_of(case: dict) -> dict:
    return {k: int(v) if isinstance(v, str) else v for k, v in case["options"].items()}


def shape_of(transaction: str) -> dict:
    """What a payment transaction asks of the fee payer, decoded: its compute-budget options, who funds an
    associated-token-account creation, and how many transfers it carries."""
    tx = S.parse_transaction(transaction)
    shape: dict[str, Any] = {"options": {}, "ata_funder": None, "transfers": 0, "tx": tx}
    for ix in tx.instructions:
        if ix.program == S.COMPUTE_BUDGET_PROGRAM and ix.data[0] == 2:
            shape["options"]["compute_unit_limit"] = int.from_bytes(ix.data[1:5], "little")
        elif ix.program == S.COMPUTE_BUDGET_PROGRAM and ix.data[0] == 3:
            shape["options"]["compute_unit_price_micro_lamports"] = int.from_bytes(ix.data[1:9], "little")
        elif ix.program == S.ASSOCIATED_TOKEN_PROGRAM:
            shape["options"]["create_destination_ata"] = True
            shape["ata_funder"] = ix.accounts[0].address
        elif ix.program == S.TOKEN_PROGRAM and ix.data[0] == 12:
            shape["transfers"] += 1
    return shape


def test_x402_limits_are_the_routers() -> None:
    limits = X402["limits"]
    assert S.MAX_COMPUTE_UNIT_LIMIT == limits["max_compute_unit_limit"]
    assert S.MAX_COMPUTE_UNIT_PRICE_MICRO_LAMPORTS == int(limits["max_compute_unit_price_micro_lamports"])
    assert S.MAX_PRIORITY_FEE_LAMPORTS == int(limits["max_priority_fee_lamports"]) and limits["allow_ata_creation"] is True
    for example in X402["priority_fee_examples"]:
        assert S.priority_fee_lamports(example["compute_unit_limit"], int(example["compute_unit_price_micro_lamports"])) == int(example["lamports"])
    assert (REQUIREMENT.fee_payer, REQUIREMENT.pay_to, X402["payer"]) == (FEE_PAYER.address, PAYEE.address, WALLET.address)
    assert (S.associated_token_address(WALLET), REQUIREMENT.destination) == (X402["source"], X402["destination"])


@pytest.mark.parametrize("case", X402["accepted"], ids=lambda c: c["name"])
def test_x402_payment_is_the_routers_accepted_transaction_byte_for_byte(case: dict) -> None:
    options = options_of(case)
    transaction = S.build_exact_payment(REQUIREMENT, WALLET, BLOCKHASH, **options)
    assert transaction == case["transaction"]
    assert S.x402_payment_header(transaction, REQUIREMENT.network) == case["payment_header"]
    shape = shape_of(transaction)
    tx = shape["tx"]
    # the fee payer is account 0 with an empty slot and is named by no instruction; exactly two signatures; one transfer
    assert tx.version is None and tx.signers == [FEE_PAYER.address, WALLET.address] and tx.recent_blockhash == BLOCKHASH
    assert tx.signature_of(FEE_PAYER) is None and S.verify_signature(WALLET.address, tx.message, tx.signature_of(WALLET))
    assert all(ix.program != FEE_PAYER.address and all(a.address != FEE_PAYER.address for a in ix.accounts) for ix in tx.instructions)
    assert shape["transfers"] == 1 and shape["options"] == options and shape["ata_funder"] in (None, WALLET.address)
    limit = options.get("compute_unit_limit", 200_000 * (2 if options.get("create_destination_ata") else 1))
    fee = S.priority_fee_lamports(limit, options["compute_unit_price_micro_lamports"]) if "compute_unit_price_micro_lamports" in options else 0
    assert fee == int(case["priority_fee_lamports"]) <= S.MAX_PRIORITY_FEE_LAMPORTS
    assert [(ix.program, [a.address for a in ix.accounts], ix.data) for ix in S.exact_payment_instructions(REQUIREMENT, WALLET, **options)] == [(ix.program, [a.address for a in ix.accounts], ix.data) for ix in tx.instructions]


@pytest.mark.parametrize("case", X402["refused"], ids=lambda c: c["name"])
def test_x402_shapes_the_router_refuses_cannot_be_built(case: dict) -> None:
    shape = shape_of(case["transaction"])
    if case["name"] == "ata_funded_by_fee_payer":
        # the only creation the SDK offers is funded by the payer: there is no option that names another funder
        assert shape["ata_funder"] == FEE_PAYER.address
        mine = S.build_exact_payment(REQUIREMENT, WALLET, BLOCKHASH, **shape["options"])
        assert mine != case["transaction"] and shape_of(mine)["ata_funder"] == WALLET.address and mine == X402["accepted"][1]["transaction"]
        with pytest.raises(S.SolanaError, match="fee payer"):  # and the fee payer's own key cannot be the payer
            S.build_exact_payment(REQUIREMENT, FEE_PAYER, BLOCKHASH, **shape["options"])
    elif case["name"] == "two_transfers":
        # exactly one transfer whatever the options: a second one cannot be asked for
        assert shape["transfers"] == 2 and not shape["options"]
        assert all(shape_of(S.build_exact_payment(REQUIREMENT, WALLET, BLOCKHASH, **options_of(a)))["transfers"] == 1 for a in X402["accepted"])
        with pytest.raises(TypeError):
            S.build_exact_payment(REQUIREMENT, WALLET, BLOCKHASH, transfers=2)
    else:
        # the compute-budget options that would express it are refused before anything is built or signed
        assert shape["options"] and shape["transfers"] == 1 and "compute" in case["reason"]
        with pytest.raises(S.SolanaError, match="fee payer signs"):
            S.build_exact_payment(REQUIREMENT, WALLET, BLOCKHASH, **shape["options"])
        with pytest.raises(S.SolanaError, match="fee payer signs"):
            S.exact_payment_instructions(REQUIREMENT, WALLET, **shape["options"])


def test_pay_per_call_sends_the_routers_accepted_payment() -> None:
    case = next(a for a in X402["accepted"] if a["name"] == "with_destination_ata")
    seen: list[httpx.Request] = []

    def router(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if "x-payment" not in request.headers:
            return httpx.Response(402, json={"x402Version": 1, "error": "Payment required", "accepts": [X402["requirement"]]})
        return httpx.Response(200, json={"id": "gen-1"})

    with client_for(router, api_key=None) as client:
        request = httpx.Request("POST", CHAT["url"], json=CHAT["body"])
        response = S.pay_per_call(client, request, WALLET, blockhash=BLOCKHASH, **options_of(case))
        assert response.status_code == 200 and seen[1].headers["x-payment"] == case["payment_header"]
        with pytest.raises(S.SolanaError, match="fee payer signs"):
            S.pay_per_call(client, request, WALLET, blockhash=BLOCKHASH, compute_unit_limit=X402["limits"]["max_compute_unit_limit"] + 1)


def test_solders_reads_the_payment_the_same_way() -> None:
    pytest.importorskip("solders")
    from solders.transaction import VersionedTransaction

    for case in X402["accepted"]:
        tx = VersionedTransaction.from_bytes(base64.b64decode(S.build_exact_payment(REQUIREMENT, WALLET, BLOCKHASH, **options_of(case))))
        assert tx.verify_with_results() == [False, True] and bytes(tx) == base64.b64decode(case["transaction"])
    closed = VersionedTransaction.from_bytes(base64.b64decode(S.sign_transaction(F["closure"]["response"]["transaction"], WALLET)))
    assert closed.verify_with_results() == [True, True]
    cancelled = VersionedTransaction.from_bytes(base64.b64decode(S.sign_transaction(F["closure"]["cancel"]["response"]["transaction"], WALLET)))
    assert cancelled.verify_with_results() == [True, True]
    moved = VersionedTransaction.from_bytes(base64.b64decode(S.sign_transaction(F["closure"]["refund_destination"]["response"]["transaction"], WALLET)))
    assert moved.verify_with_results() == [True]


# ---- 7. 409 credits_closing: the key is frozen -------------------------------------------------------------------------------


def test_credits_closing_is_its_own_error_and_is_not_retried() -> None:
    closing = F["errors"]["credits_closing"]
    assert (closing["status"], closing["body"]["error"]["type"]) == (409, S.CREDITS_CLOSING)
    seen: list[httpx.Request] = []

    def router(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return refusal("credits_closing")

    body = {k: v for k, v in CHAT["body"].items() if k not in ("stream", "stream_options")}
    with client_for(router) as client:
        calls = [lambda: client.chat(body), lambda: client.deposit_tx("1", WALLET)]
        for call in calls:
            with pytest.raises(CreditsClosing) as info:
                call()
            error = info.value
            assert isinstance(error, TrellisError) and (error.status, error.code, error.closure) == (409, "credits_closing", closing["body"]["error"]["metadata"]["closure"])
            assert str(error) == closing["body"]["error"]["message"] and error.details == closing["body"]["error"]["metadata"]
        # a hand-driven send gets the answer as it came, once
        response = S.pay_per_call(client, httpx.Request("POST", CHAT["url"], json=CHAT["body"]), WALLET, blockhash=BLOCKHASH)
        assert response.status_code == 409 and response.json() == closing["body"]
    assert len(seen) == len(calls) + 1  # one request per call: a frozen key is never retried

