"""Solana payments: vouchers, headers, base58, PDAs, instruction bytes and the 402 -> X-PAYMENT retry. No network.

Addresses are placeholders (base58 of repeated bytes); the only keys are derived from fixed seeds inside the tests.
Transactions are compiled, parsed and signed in pure Python; the tests that cross-check them against ``solders`` (the
``solana`` extra) skip without it. The router's own vectors are replayed in test_contracts.py.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import struct
import sys
import time

import httpx
import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from trellis import solana as S

from .conftest import CONTRACTS, fixture_key

P1, P2, P3, P4 = (bytes([i] * 32) for i in (1, 2, 3, 4))
PAYER = S.Signer.from_seed(P1)  # a throwaway key derived from a fixed seed
FEE_PAYER = S.b58encode(P2)
PAY_TO = S.b58encode(P3)
PAYEE = S.b58encode(P4)
BLOCKHASH = S.b58encode(bytes([9] * 32))
PROGRAM = S.TAB_PROGRAM_LOCALNET
TAB = "4qgTjxS34a6vUR6kQtgZL5sgbxbiJ3FXsrq2TMYTekBn"  # tab_address(PROGRAM, P1, P4, 42)
RPC = "https://rpc.test"
ROUTER = "https://router.test"
NOW = 1_790_000_000  # the moment the tab tests open their tab; a tab's created_at
CREATED_AT = NOW
EXPIRY = NOW + 86_400
RULES = S.b58encode(bytes([7] * 32))  # a stand-in rules program id


def requirement(fee_payer: str | None = FEE_PAYER, amount: str = "12345") -> dict:
    return {"scheme": "exact", "network": S.MAINNET, "maxAmountRequired": amount, "resource": f"{ROUTER}/api/v1/chat/completions", "description": "Pay-per-call inference", "mimeType": "application/json", "payTo": PAY_TO, "maxTimeoutSeconds": 60, "asset": S.USDC_MINT, "extra": {"feePayer": fee_payer, "decimals": 6}}


def b64json(v: object) -> str:
    return base64.b64encode(json.dumps(v).encode()).decode()


# ---- base58 -----------------------------------------------------------------------------------------------------------


def test_base58_vectors() -> None:
    assert S.b58encode(b"") == "" and S.b58decode("") == b""
    assert S.b58encode(b"\0") == "1" and S.b58decode("1") == b"\0"
    assert S.b58encode(b"\x00\x01") == "12" and S.b58decode("12") == b"\x00\x01"
    assert S.b58encode(b"Hello World!") == "2NEpo7TZRRrLZSi2U"
    assert S.b58encode(bytes([0xFF] * 4)) == "7YXq9G"
    assert S.b58encode(bytes(32)) == S.SYSTEM_PROGRAM
    assert S.b58decode(S.USDC_MINT) == S.to_pubkey(S.USDC_MINT) and len(S.b58decode(S.TOKEN_PROGRAM)) == 32
    for _ in range(50):
        raw = os.urandom(os.urandom(1)[0] % 70)
        assert S.b58decode(S.b58encode(raw)) == raw
    with pytest.raises(S.SolanaError):
        S.b58decode("0OIl")


def test_addresses_from_many_shapes() -> None:
    assert S.to_address(P1) == S.b58encode(P1) == S.to_address(S.b58encode(P1))
    assert S.to_pubkey(PAYER) == PAYER.public_key and S.to_address(PAYER) == PAYER.address
    with pytest.raises(S.SolanaError):
        S.to_pubkey(b"short")
    with pytest.raises(S.SolanaError):
        S.to_pubkey(12)


# ---- signers ------------------------------------------------------------------------------------------------------------


def test_signer_shapes_and_signature_round_trip() -> None:
    key = Ed25519PrivateKey.from_private_bytes(P1)
    for value in (PAYER, key, P1, P1 + PAYER.public_key):
        s = S.as_signer(value)
        assert s.address == PAYER.address and s.seed == P1
    sig = PAYER.sign(b"hello")
    assert len(sig) == 64 and S.verify_signature(PAYER.address, b"hello", sig) and S.verify_signature(PAYER.public_key, b"hello", S.b58encode(sig))
    assert not S.verify_signature(PAYER.address, b"hellp", sig) and not S.verify_signature(PAY_TO, b"hello", sig)
    assert not S.verify_signature(PAYER.address, b"hello", b"x" * 63) and not S.verify_signature("not-base58-0", b"hello", sig)
    assert S.Signer.from_base58(S.b58encode(P1)).address == PAYER.address
    assert S.generate_session_key().address != S.generate_session_key().address
    with pytest.raises(S.SolanaError):
        S.as_signer("a string is not a signer")
    with pytest.raises(S.SolanaError):
        S.Signer.from_seed(b"\1" * 31)


# ---- program-derived addresses (pure Python) ---------------------------------------------------------------------------


def test_on_curve_and_pda_rules() -> None:
    assert S._on_curve(bytes(32))  # y = 0 decompresses (x^2 = -1 has a root)
    assert S._on_curve(PAYER.public_key) and S._on_curve(S.to_pubkey(S.USDC_MINT))
    pda, bump = S._find_program_address_py([b"config"], S.to_pubkey(PROGRAM))
    assert not S._on_curve(pda) and bump == 255 and S.b58encode(pda) == "9GCbuLgAAPFpibCnTmdbVQxyomjwVr6pHsD8o56CeRwW"
    assert S.create_program_address([b"config", bytes([bump])], PROGRAM) == pda
    with pytest.raises(S.SolanaError):
        S.create_program_address([b"x" * 33], PROGRAM)


def test_pda_vectors() -> None:
    assert S.tab_config_address(PROGRAM) == "9GCbuLgAAPFpibCnTmdbVQxyomjwVr6pHsD8o56CeRwW"
    assert S.tab_address(PROGRAM, P1, P4, 42) == TAB == S.tab_address(PROGRAM, S.b58encode(P1), PAYEE, 42)
    assert S.tab_escrow_address(PROGRAM, TAB) == "Bh9vHqiTgJ6kMeCjqv91GmHQTVKAFqt7mNW8Cs5VKEVS"
    assert S.associated_token_address(P3) == "GewoiTtgmMFV5vERJqe64UJXUW2ygmxtAxZ8mhpju1dH"
    assert S.associated_token_address(P1, S.USDC_MINT) == "Gs6NxmndAL3PULGZeYUHCknpMdDVbL46eFCBh856p5z6"
    assert S.tab_address(PROGRAM, P1, P4, 43) != TAB
    # the pure-Python derivation and find_program_address (solders when installed) agree
    for seeds in ([b"config"], [b"tab", P1, P4, struct.pack("<Q", 42)], [b"escrow", S.to_pubkey(TAB)]):
        assert S.find_program_address(seeds, PROGRAM) == S._find_program_address_py(seeds, S.to_pubkey(PROGRAM))


# ---- vouchers and tabs ---------------------------------------------------------------------------------------------------


def test_voucher_bytes_and_signature_round_trip() -> None:
    session = S.generate_session_key()
    msg = S.voucher_message(PROGRAM, TAB, CREATED_AT, 1_500_000, 7)
    assert len(msg) == S.VOUCHER_MESSAGE_LEN == 110 and S.VOUCHER_DOMAIN == b"trellis:tab:voucher:v1"
    assert msg == S.VOUCHER_DOMAIN + S.to_pubkey(PROGRAM) + S.to_pubkey(TAB) + CREATED_AT.to_bytes(8, "little", signed=True) + (1_500_000).to_bytes(8, "little") + (7).to_bytes(8, "little")
    sig = S.sign_voucher(session, PROGRAM, TAB, CREATED_AT, 1_500_000, 7)
    assert len(sig) == 64
    assert S.verify_voucher(PROGRAM, TAB, CREATED_AT, 1_500_000, 7, sig, session.address)
    assert S.verify_voucher(PROGRAM, TAB, CREATED_AT, 1_500_000, 7, S.b58encode(sig), session.public_key)
    assert not S.verify_voucher(PROGRAM, TAB, CREATED_AT, 1_500_001, 7, sig, session.address)
    assert not S.verify_voucher(PROGRAM, TAB, CREATED_AT, 1_500_000, 8, sig, session.address)
    assert not S.verify_voucher(PROGRAM, TAB, CREATED_AT + 1, 1_500_000, 7, sig, session.address)  # the same address, opened again
    assert not S.verify_voucher(RULES, TAB, CREATED_AT, 1_500_000, 7, sig, session.address)  # another program
    assert not S.verify_voucher(PROGRAM, TAB, CREATED_AT, 1_500_000, 7, sig, S.generate_session_key().address)
    assert not S.verify_voucher(PROGRAM, "not-an-address", CREATED_AT, 1, 1, sig, session.address)
    with pytest.raises(S.SolanaError):
        S.voucher_message(PROGRAM, TAB, CREATED_AT, -1, 0)
    with pytest.raises(TypeError):
        S.voucher_message(TAB, 1_500_000, 7)  # the retired form (tab, cumulative_used, seq): the scope is not optional
    with pytest.raises(TypeError):
        S.sign_voucher(session, TAB, 1_500_000, 7)


def test_tab_session_headers_and_wire() -> None:
    session_key = S.Signer.from_seed(P2)
    with pytest.raises(TypeError):
        S.TabSession(TAB, session_key, cap=5_000_000)  # the program id and the tab's created_at are required
    tab = S.TabSession(TAB, session_key, PROGRAM, CREATED_AT, cap=5_000_000)
    assert tab.session_public_key == session_key.address and tab.seq == 0 and tab.cumulative_used == 0
    assert (tab.program_id, tab.created_at) == (PROGRAM, CREATED_AT)
    v1 = tab.voucher(1000)
    assert (tab.seq, tab.cumulative_used, tab.last) == (1, 1000, v1)
    assert set(v1.headers) == {"X-Trellis-Tab", "X-Trellis-Tab-Voucher"} and v1.headers["X-Trellis-Tab"] == TAB
    m, s = v1.headers["X-Trellis-Tab-Voucher"].split(".")
    assert base64.b64decode(m) == v1.message == S.voucher_message(PROGRAM, TAB, CREATED_AT, 1000, 1) and base64.b64decode(s) == v1.signature
    assert v1.wire == {"tab": TAB, "cumulative_used": "1000", "seq": "1", "signature": S.b58encode(v1.signature), "session_key": session_key.address}
    assert v1.verify() and S.verify_voucher(PROGRAM, TAB, CREATED_AT, 1000, 1, v1.wire["signature"], v1.wire["session_key"])
    assert S.parse_voucher_header(v1.header, PROGRAM, CREATED_AT, TAB, session_key) == v1
    assert S.parse_voucher_header(v1.header, PROGRAM, CREATED_AT) == S.Voucher(PROGRAM, TAB, CREATED_AT, 1000, 1, v1.signature, "")
    with pytest.raises(S.SolanaError, match="another opening"):
        S.parse_voucher_header(v1.header, PROGRAM, CREATED_AT + 1, TAB)
    with pytest.raises(S.SolanaError, match="another tab program"):
        S.parse_voucher_header(v1.header, RULES, CREATED_AT, TAB)
    v2 = tab.add(250)
    assert (v2.seq, v2.cumulative_used) == (2, 1250) and v2.signature != v1.signature
    assert tab.headers(1250)["X-Trellis-Tab-Voucher"] != v2.header  # a new seq, a new signature
    with pytest.raises(S.SolanaError):
        tab.voucher(1000)  # cumulative_used never decreases
    with pytest.raises(S.SolanaError):
        tab.voucher(5_000_001)  # above the cap
    with pytest.raises(S.SolanaError):
        S.parse_voucher_header(v1.header, PROGRAM, CREATED_AT, S.b58encode(P3))
    with pytest.raises(S.SolanaError):
        S.parse_voucher_header("nope", PROGRAM, CREATED_AT)


def test_open_tab_and_top_up_instruction_bytes() -> None:
    session_key = S.Signer.from_seed(P2)
    config, escrow, enforcer = S.tab_config_address(PROGRAM), S.tab_escrow_address(PROGRAM, TAB), S.tab_enforcer_address(PROGRAM)
    ix = S.open_tab_instruction(PROGRAM, P1, PAYEE, 5_000_000, EXPIRY, session_key, 42, now=NOW)
    assert ix.program == PROGRAM
    assert ix.data == S.OPEN_TAB_DISCRIMINATOR + struct.pack("<QQq", 42, 5_000_000, EXPIRY) + session_key.public_key and len(ix.data) == 64
    # no rulebook: the rulebook, rules config and rules program slots hold the tab program id; the enforcer comes last
    assert [a.address for a in ix.accounts] == [S.b58encode(P1), PAYEE, config, TAB, S.USDC_MINT, escrow, S.associated_token_address(P1), PROGRAM, S.TOKEN_PROGRAM, S.SYSTEM_PROGRAM, PROGRAM, PROGRAM, enforcer]
    assert [(a.is_signer, a.is_writable) for a in ix.accounts] == [(True, True), (False, False), (False, False), (False, True), (False, False), (False, True), (False, True)] + [(False, False)] * 6
    with_rules = S.open_tab_instruction(PROGRAM, P1, PAYEE, 1, EXPIRY, session_key, 42, rulebook=P3, rules_program=RULES, now=NOW)
    assert [(a.address, a.is_writable) for a in with_rules.accounts[7:]] == [(S.b58encode(P3), True), (S.TOKEN_PROGRAM, False), (S.SYSTEM_PROGRAM, False), (S.rules_config_address(RULES), False), (RULES, False), (enforcer, False)]
    assert with_rules.accounts[:7] == ix.accounts[:7] and not any(a.is_signer for a in with_rules.accounts[1:])
    with pytest.raises(S.SolanaError, match="rules_program"):
        S.open_tab_instruction(PROGRAM, P1, PAYEE, 1, EXPIRY, session_key, 42, rulebook=P3, now=NOW)
    with pytest.raises(S.SolanaError):
        S.open_tab_instruction(PROGRAM, P1, PAYEE, 0, EXPIRY, session_key, 42, now=NOW)
    # a tab lives at most 30 days: a longer expiry is refused here, before the program refuses it
    assert S.MAX_TAB_LIFETIME_SECONDS == 30 * 86_400
    S.open_tab_instruction(PROGRAM, P1, PAYEE, 1, NOW + S.MAX_TAB_LIFETIME_SECONDS, session_key, 42, now=NOW)
    with pytest.raises(S.SolanaError, match="30 days"):
        S.open_tab_instruction(PROGRAM, P1, PAYEE, 1, NOW + S.MAX_TAB_LIFETIME_SECONDS + 1, session_key, 42, now=NOW)
    with pytest.raises(S.SolanaError, match="30 days"):
        S.open_tab_instruction(PROGRAM, P1, PAYEE, 1, int(time.time()) + 31 * 86_400, session_key, 42)  # on this machine's clock
    top = S.top_up_instruction(PROGRAM, P1, TAB, 250_000)
    assert top.data == S.TOP_UP_DISCRIMINATOR + (250_000).to_bytes(8, "little")
    assert [a.address for a in top.accounts] == [S.b58encode(P1), config, TAB, S.USDC_MINT, escrow, S.associated_token_address(P1), S.TOKEN_PROGRAM, PROGRAM, PROGRAM, PROGRAM, enforcer]
    assert [(a.is_signer, a.is_writable) for a in top.accounts] == [(True, False), (False, False), (False, True), (False, False), (False, True), (False, True)] + [(False, False)] * 5
    bound = S.top_up_instruction(PROGRAM, P1, TAB, 250_000, rulebook=P3, rules_program=RULES)
    assert [(a.address, a.is_writable) for a in bound.accounts[7:]] == [(S.b58encode(P3), True), (S.rules_config_address(RULES), False), (RULES, False), (enforcer, False)]
    # reclaim: no rulebook account and no signer (the payer is only where the rent goes back to)
    reclaim = S.reclaim_instruction(PROGRAM, P1, PAYEE, TAB)
    assert reclaim.data == S.RECLAIM_DISCRIMINATOR and not any(a.is_signer for a in reclaim.accounts)
    assert [a.address for a in reclaim.accounts] == [S.b58encode(P1), TAB, config, S.USDC_MINT, escrow, S.associated_token_address(P1), S.associated_token_address(P4), S.TOKEN_PROGRAM]
    assert [a.is_writable for a in reclaim.accounts] == [True, True, False, False, True, True, True, False]


def test_decode_tab_account() -> None:
    body = S.TAB_ACCOUNT_DISCRIMINATOR + P1 + P4 + P2 + S.to_pubkey(S.USDC_MINT) + struct.pack("<QQQQqq", 42, 5_000_000, 1000, 3, 1_800_000_000, 1_790_000_000)
    plain = S.decode_tab_account(body + b"\0" + bytes([254, 253]))
    assert (plain.payer, plain.payee, plain.session_key, plain.mint) == (S.b58encode(P1), PAYEE, S.b58encode(P2), S.USDC_MINT)
    assert (plain.tab_id, plain.cap, plain.posted_used, plain.posted_seq, plain.expiry, plain.created_at) == (42, 5_000_000, 1000, 3, 1_800_000_000, 1_790_000_000)
    assert plain.rulebook is None and (plain.bump, plain.escrow_bump) == (254, 253)
    ruled = S.decode_tab_account(body + b"\1" + P3 + bytes([255, 252]))
    assert ruled.rulebook == S.b58encode(P3) and (ruled.bump, ruled.escrow_bump) == (255, 252)
    with pytest.raises(S.SolanaError):
        S.decode_tab_account(b"\0" * 200)
    with pytest.raises(S.SolanaError):
        S.decode_tab_account(body[:150])


# ---- X-Wallet-Auth and sign-in ------------------------------------------------------------------------------------------


def test_wallet_auth_header_format() -> None:
    body = b'{"model":"example/model"}'
    url, digest = f"{ROUTER}/api/v1/chat/completions", hashlib.sha256(body).hexdigest()
    header = S.wallet_auth_header(PAYER, "POST", url, body, timestamp=1_700_000_000)
    address, ts, sig = header.split(":")
    assert address == PAYER.address and ts == "1700000000"
    message = S.wallet_auth_message("POST", "router.test", "/api/v1/chat/completions", 1_700_000_000, digest)
    assert message == f"trellis:wallet-auth:v2\nPOST\nrouter.test\n/api/v1/chat/completions\n1700000000\n{digest}"
    assert S.verify_signature(PAYER.address, message.encode(), sig)
    assert not S.verify_signature(PAYER.address, f"trellis:1700000000:{digest}".encode(), sig)  # the retired v1 message
    # the same request, however it is described: a dict, the JSON text, a path with the host, a built request
    assert S.wallet_auth_header(PAYER, "post", url, {"model": "example/model"}, timestamp=1_700_000_000) == header
    assert S.wallet_auth_header(PAYER, "POST", "/api/v1/chat/completions", body.decode(), host="ROUTER.TEST", timestamp=1_700_000_000) == header
    assert S.wallet_auth_header(PAYER, "POST", "http://127.0.0.1:8787/api/v1/chat/completions", body, host=ROUTER, timestamp=1_700_000_000) == header
    assert S.with_wallet_auth(httpx.Request("POST", url, content=body), PAYER, timestamp=1_700_000_000).headers["x-wallet-auth"] == header
    # another method, path, query, host or body is another signature; a chat route does not bind `stream`
    others = [("GET", url, body), ("POST", f"{ROUTER}/api/v1/embeddings", body), ("POST", url + "?x=1", body), ("POST", "https://other.test/api/v1/chat/completions", body), ("POST", url, {"model": "example/other"})]
    assert all(S.wallet_auth_header(PAYER, m, u, b, timestamp=1_700_000_000) != header for m, u, b in others)
    assert S.wallet_auth_header(PAYER, "POST", url, {"model": "example/model", "stream": True, "stream_options": {"include_usage": True}}, timestamp=1_700_000_000) == header
    assert S.wallet_auth_hash("POST", "/api/v1/holders/polls/p/vote", {"stream": True}) != S.wallet_auth_hash("POST", "/api/v1/holders/polls/p/vote", {})
    assert S.wallet_auth_hash("GET", "/api/v1/refunds") == S.wallet_auth_hash("GET", "/api/v1/refunds?page=2", b"") == hashlib.sha256(b"").hexdigest()
    assert S.wallet_auth_header(PAYER, "POST", url, body) != header  # the clock moved on
    assert header.count(":") == 2 and all(c in S._B58 for c in sig)
    assert S.router_host("HTTPS://Router.Test:443/api/v1") == "router.test" == S.router_host("Router.Test") and S.router_host("http://127.0.0.1:8787") == "127.0.0.1:8787"
    with pytest.raises(S.SolanaError, match="host"):
        S.wallet_auth_header(PAYER, "POST", "/api/v1/chat/completions", body)  # a bare path names no router
    with pytest.raises(S.SolanaError):
        S.wallet_auth_message("GET", "router.test", "/a\n/b", 1, digest)
    with pytest.raises(S.SolanaError, match="not JSON"):
        S.wallet_auth_header(PAYER, "POST", url, b"not json")
    with pytest.raises(TypeError):
        S.wallet_auth_header(PAYER, body, timestamp=1_700_000_000)  # the v1 call (body only) is gone


def test_wallet_sign_in_body() -> None:
    sign_in, wallet = CONTRACTS["sign_in"], fixture_key("wallet")
    challenge, host = sign_in["challenge"], sign_in["expected_host"]
    body = S.wallet_sign_in_body(wallet, challenge, host, name="agent")
    assert body == {"address": wallet.address, "nonce": challenge["nonce"], "signature": sign_in["signature"], "message": challenge["message"], "name": "agent"}
    assert "timestamp" not in body and S.verify_signature(wallet.address, challenge["message"].encode(), body["signature"])
    assert "name" not in S.wallet_sign_in_body(wallet, challenge, f"https://{host}/api/v1")
    fields = S.parse_wallet_sign_in_message(challenge["message"])
    assert (fields.domain, fields.address, fields.nonce, fields.uri, fields.chain_id) == (host, wallet.address, challenge["nonce"], challenge["uri"], challenge["chain_id"])
    with pytest.raises(S.SolanaError, match="another wallet"):
        S.wallet_sign_in_body(PAYER, challenge, host)  # the message's second line is not the signer
    with pytest.raises(S.SolanaError, match="refusing to sign"):
        S.wallet_sign_in_body(wallet, challenge, ROUTER)  # issued by a router other than the one being talked to
    with pytest.raises(TypeError):
        S.wallet_sign_in_body(wallet, challenge["nonce"], timestamp=1_700_000_000)  # the v1 call: a nonce and a client clock
    assert not hasattr(S, "wallet_sign_in_message")  # no client-built sign-in text any more


# ---- x402 parsing and headers -------------------------------------------------------------------------------------------


def test_parse_payment_required_v1_body_and_v2_header() -> None:
    body = {"x402Version": 1, "error": "Payment of 0.012345 USDC required", "accepts": [requirement()], "price_usdc": "0.012345", "model": "example/model"}
    v2 = {"x402Version": 2, "error": body["error"], "resource": {"url": requirement()["resource"], "description": "Pay-per-call inference", "mimeType": "application/json"}, "accepts": [{"scheme": "exact", "network": S.MAINNET, "amount": "12345", "asset": S.USDC_MINT, "payTo": PAY_TO, "maxTimeoutSeconds": 60, "extra": {"feePayer": FEE_PAYER, "decimals": 6}}]}
    response = httpx.Response(402, json=body, headers={"payment-required": b64json(v2)})
    parsed = S.parse_payment_required(response)
    r = parsed.exact()
    assert parsed.x402_version == 1 and parsed.price_usdc == "0.012345" and parsed.model == "example/model" and parsed.payment_error is None
    assert (r.scheme, r.network, r.max_amount_required, r.pay_to, r.asset, r.fee_payer, r.decimals) == ("exact", S.MAINNET, 12345, PAY_TO, S.USDC_MINT, FEE_PAYER, 6)
    assert r.amount_usdc == "0.012345" and r.destination == S.associated_token_address(PAY_TO) and r.to_v1() == requirement()
    # the v2 header alone yields the same requirement
    only_header = S.parse_payment_required(httpx.Response(402, content=b"", headers={"PAYMENT-REQUIRED": b64json(v2)}))
    assert only_header.x402_version == 2 and only_header.error == body["error"] and only_header.exact().to_v1() == requirement()
    assert S.parse_payment_required(body=body).exact(S.MAINNET).pay_to == PAY_TO
    assert S.parse_payment_required(headers={"Payment-Required": b64json(v2)}).exact().fee_payer == FEE_PAYER
    rejected = S.parse_payment_required(body={**body, "payment_error": "invalid_exact_svm_payload_transaction_blockhash_expired"})
    assert rejected.payment_error == "invalid_exact_svm_payload_transaction_blockhash_expired"
    with pytest.raises(S.SolanaError):
        S.parse_payment_required(httpx.Response(402, json={"error": "no accepts"}))
    with pytest.raises(S.SolanaError):
        parsed.exact(S.DEVNET)


def test_payment_header_and_response_encoding() -> None:
    header = S.x402_payment_header("dHg=", S.MAINNET)
    assert json.loads(base64.b64decode(header)) == {"x402Version": 1, "scheme": "exact", "network": S.MAINNET, "payload": {"transaction": "dHg="}}
    settled = {"success": True, "transaction": "5" * 87, "network": S.MAINNET, "payer": PAYER.address}
    assert S.parse_payment_response(httpx.Headers({"x-payment-response": b64json(settled)})) == settled
    assert S.parse_payment_response({"PAYMENT-RESPONSE": b64json(settled)}) == settled
    assert S.parse_payment_response({}) is None


def test_build_exact_payment_refuses_without_fee_payer_or_amount() -> None:
    with pytest.raises(S.SolanaError, match="fee payer"):
        S.build_exact_payment(S.PaymentRequirement.from_v1(requirement(fee_payer=None)), PAYER, BLOCKHASH)
    with pytest.raises(S.SolanaError, match="maxAmountRequired"):
        S.build_exact_payment(S.PaymentRequirement.from_v1(requirement()), PAYER, BLOCKHASH, amount=1)
    with pytest.raises(S.SolanaError, match="recent_blockhash"):
        S.compile_transaction([], FEE_PAYER, None)


def test_transfer_checked_instruction_bytes() -> None:
    ix = S.transfer_checked_instruction(S.associated_token_address(P1), S.USDC_MINT, S.associated_token_address(P3), P1, 12345)
    assert ix.program == S.TOKEN_PROGRAM and ix.data == bytes([12]) + (12345).to_bytes(8, "little") + bytes([6]) and len(ix.data) == 10
    assert [(a.address, a.is_signer, a.is_writable) for a in ix.accounts] == [(S.associated_token_address(P1), False, True), (S.USDC_MINT, False, False), (S.associated_token_address(P3), False, True), (S.b58encode(P1), True, False)]
    ata = S.create_ata_idempotent_instruction(P1, PAY_TO, S.USDC_MINT)
    assert ata.program == S.ASSOCIATED_TOKEN_PROGRAM and ata.data == b"\1"
    assert [a.address for a in ata.accounts] == [S.b58encode(P1), S.associated_token_address(P3), PAY_TO, S.USDC_MINT, S.SYSTEM_PROGRAM, S.TOKEN_PROGRAM]
    limit, price = S.set_compute_unit_limit_instruction(60_000), S.set_compute_unit_price_instruction(100_000)
    assert limit.program == price.program == S.COMPUTE_BUDGET_PROGRAM and not limit.accounts and not price.accounts
    assert limit.data == b"\2" + (60_000).to_bytes(4, "little") and price.data == b"\3" + (100_000).to_bytes(8, "little")
    with pytest.raises(S.SolanaError):
        S.transfer_checked_instruction(P1, S.USDC_MINT, P3, P1, 0)


def test_exact_payment_stays_inside_what_the_fee_payer_signs() -> None:
    req = S.PaymentRequirement.from_v1(requirement())
    tx = S.parse_transaction(S.build_exact_payment(req, PAYER, BLOCKHASH, create_destination_ata=True, compute_unit_limit=60_000, compute_unit_price_micro_lamports=100_000))
    # the fee payer first with an empty slot, the payer second with a valid signature, and nobody else
    assert tx.version is None and tx.signers == [FEE_PAYER, PAYER.address] and tx.fee_payer == FEE_PAYER and tx.recent_blockhash == BLOCKHASH
    assert tx.signatures[0] == bytes(64) and tx.signature_of(FEE_PAYER) is None and S.verify_signature(PAYER.address, tx.message, tx.signature_of(PAYER))
    limit, price, ata, transfer = tx.instructions
    assert (limit.program, limit.data) == (S.COMPUTE_BUDGET_PROGRAM, b"\2" + (60_000).to_bytes(4, "little")) and (price.program, price.data) == (S.COMPUTE_BUDGET_PROGRAM, b"\3" + (100_000).to_bytes(8, "little"))
    # payTo's token account is created with the payer's own lamports, never the fee payer's
    assert ata.program == S.ASSOCIATED_TOKEN_PROGRAM and [(a.address, a.is_signer, a.is_writable) for a in ata.accounts][0] == (PAYER.address, True, True)
    assert [a.address for a in ata.accounts] == [PAYER.address, S.associated_token_address(PAY_TO), PAY_TO, S.USDC_MINT, S.SYSTEM_PROGRAM, S.TOKEN_PROGRAM]
    assert transfer.program == S.TOKEN_PROGRAM and transfer.data == bytes([12]) + (12345).to_bytes(8, "little") + bytes([6])
    assert all(a.address != FEE_PAYER for ix in tx.instructions for a in ix.accounts) and all(ix.program != FEE_PAYER for ix in tx.instructions)
    # outside the fee payer's bounds nothing is built
    for options in ({"compute_unit_limit": S.MAX_COMPUTE_UNIT_LIMIT + 1}, {"compute_unit_limit": 1_000, "compute_unit_price_micro_lamports": S.MAX_COMPUTE_UNIT_PRICE_MICRO_LAMPORTS + 1}, {"compute_unit_limit": 200_000, "compute_unit_price_micro_lamports": 50_001}, {"compute_unit_price_micro_lamports": 50_001}, {"create_destination_ata": True, "compute_unit_price_micro_lamports": 25_001}, {"compute_unit_limit": 0}, {"compute_unit_limit": "60000"}, {"token_program": S.SYSTEM_PROGRAM}):
        with pytest.raises(S.SolanaError):
            S.build_exact_payment(req, PAYER, BLOCKHASH, **options)
    S.build_exact_payment(req, PAYER, BLOCKHASH, compute_unit_price_micro_lamports=50_000)  # 200,000 units by default: 10,000 lamports
    assert S.priority_fee_lamports(200_000, 50_000) == S.MAX_PRIORITY_FEE_LAMPORTS and S.priority_fee_lamports(1, 1) == 1
    with pytest.raises(S.SolanaError, match="fee payer"):
        S.build_exact_payment(S.PaymentRequirement.from_v1(requirement(fee_payer=PAYER.address)), PAYER, BLOCKHASH)  # the fee payer cannot be the payer


def test_sign_transaction_adds_one_signature_and_keeps_the_others() -> None:
    other = S.Signer.from_seed(P2)
    ix = S.Instruction(S.to_pubkey(PROGRAM), (S.AccountMeta(PAYER.public_key, True, True), S.AccountMeta(other.public_key, True, False), S.AccountMeta(P3, False, True)), b"\x09")
    half = base64.b64encode(S.compile_transaction([ix], PAYER, BLOCKHASH, [other])).decode()
    before = S.parse_transaction(half)
    assert before.signers == [PAYER.address, other.address] and before.signature_of(PAYER) is None and S.verify_signature(other.address, before.message, before.signature_of(other))
    assert (before.num_required_signatures, before.num_readonly_signed, before.num_readonly_unsigned) == (2, 1, 1) and before.instructions == (ix,)
    after = S.parse_transaction(S.sign_transaction(half, PAYER))
    assert after.message == before.message and after.signatures[1] == before.signatures[1] and S.verify_signature(PAYER.address, after.message, after.signatures[0])
    assert S.sign_transaction(base64.b64decode(half), PAYER) == S.sign_transaction(half, PAYER) == base64.b64encode(S.compile_transaction([ix], PAYER, BLOCKHASH, [PAYER, other])).decode()
    with pytest.raises(S.SolanaError, match="not a required signer"):
        S.sign_transaction(half, S.Signer.from_seed(P4))
    for nothing in (None, "", "not base64 !", base64.b64encode(b"\1" + bytes(70)).decode()):
        with pytest.raises(S.SolanaError):
            S.sign_transaction(nothing, PAYER)


def test_solders_is_optional_and_missing_is_a_clear_import_error(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in [m for m in sys.modules if m == "solders" or m.startswith("solders.")]:
        monkeypatch.delitem(sys.modules, name)
    for name in ("solders", "solders.instruction", "solders.pubkey"):
        monkeypatch.setitem(sys.modules, name, None)
    # transactions are compiled and signed without it
    tx = S.parse_transaction(S.build_exact_payment(S.PaymentRequirement.from_v1(requirement()), PAYER, BLOCKHASH))
    assert tx.signers == [FEE_PAYER, PAYER.address] and S.verify_signature(PAYER.address, tx.message, tx.signatures[1])
    with pytest.raises(S.SoldersMissing, match="solana"):
        tx.instructions[0].to_solders()
    # the pure-Python derivation keeps working
    assert S.tab_address(PROGRAM, P1, P4, 42) == TAB and S.associated_token_address(P3) == "GewoiTtgmMFV5vERJqe64UJXUW2ygmxtAxZ8mhpju1dH"


def test_usdc_amounts() -> None:
    assert S.parse_usdc("12.50") == 12_500_000 and S.parse_usdc("0.000001") == 1 and S.parse_usdc(7) == 7 and S.parse_usdc("3") == 3_000_000
    assert S.format_usdc(12_500_000) == "12.5" and S.format_usdc(1) == "0.000001" and S.format_usdc(0) == "0" and S.format_usdc(3_000_000) == "3"
    assert S.deposit_tx_body("12.50", PAYER) == {"amount": "12.50", "payer": PAYER.address}
    assert S.deposit_tx_body(12_500_000, P1)["amount"] == "12.5"
    for bad in ("0.0000001", "-1", "abc", True):
        with pytest.raises(S.SolanaError):
            S.parse_usdc(bad)


# ---- the 402 -> X-PAYMENT retry (stub transport) ----------------------------------------------------------------------


class PaidRouter:
    """A router that asks for an x402 payment once and serves the retry; also the RPC's getLatestBlockhash."""

    def __init__(self, reject: bool = False) -> None:
        self.requests: list[httpx.Request] = []
        self.reject = reject

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if str(request.url) == RPC:
            assert json.loads(request.content)["method"] == "getLatestBlockhash"
            return httpx.Response(200, json={"jsonrpc": "2.0", "id": 1, "result": {"context": {"slot": 1}, "value": {"blockhash": BLOCKHASH, "lastValidBlockHeight": 100}}})
        body = {"x402Version": 1, "error": "Payment of 0.012345 USDC required", "accepts": [requirement()], "price_usdc": "0.012345", "model": "example/model"}
        payment = request.headers.get("x-payment")
        if not payment or self.reject:
            if payment:
                body["payment_error"] = "invalid_exact_svm_payload_transaction_amount_mismatch"
            return httpx.Response(402, json=body, headers={"payment-required": b64json({"x402Version": 2, "error": body["error"], "resource": {}, "accepts": []})})
        decoded = json.loads(base64.b64decode(payment))
        assert decoded["x402Version"] == 1 and decoded["scheme"] == "exact" and decoded["network"] == S.MAINNET
        settled = {"success": True, "transaction": "4" * 87, "network": S.MAINNET, "payer": PAYER.address}
        return httpx.Response(200, json={"id": "gen-1", "choices": [{"message": {"content": "paid"}}], "paid_tx": decoded["payload"]["transaction"]}, headers={"x-payment-response": b64json(settled), "payment-response": b64json(settled)})


def chat_request() -> httpx.Request:
    return httpx.Request("POST", f"{ROUTER}/api/v1/chat/completions", json={"model": "example/model", "messages": [{"role": "user", "content": "hi"}]})


def test_pay_per_call_retries_once_with_x_payment(monkeypatch: pytest.MonkeyPatch) -> None:
    built: dict = {}

    def fake_build(req, signer, blockhash, *, create_destination_ata=False, **kw):
        built.update(req=req, signer=S.as_signer(signer).address, blockhash=blockhash, ata=create_destination_ata)
        return "c3R1Yg=="  # the transaction bytes are solders' job; see test_pay_per_call_with_solders

    monkeypatch.setattr(S, "build_exact_payment", fake_build)
    router = PaidRouter()
    with httpx.Client(transport=httpx.MockTransport(router)) as http:
        response = S.pay_per_call(http, chat_request(), PAYER, RPC, create_destination_ata=True)
    assert response.status_code == 200 and response.json()["paid_tx"] == "c3R1Yg=="
    assert [str(r.url) for r in router.requests] == [f"{ROUTER}/api/v1/chat/completions", RPC, f"{ROUTER}/api/v1/chat/completions"]
    first, _, retry = router.requests
    assert "x-payment" not in first.headers and retry.content == first.content and retry.headers["content-type"] == "application/json"
    assert built["req"].pay_to == PAY_TO and built["signer"] == PAYER.address and built["blockhash"] == BLOCKHASH and built["ata"] is True
    assert S.parse_payment_response(response.headers)["payer"] == PAYER.address
    # a rejected payment comes back as the second 402 with its reason
    rejecting = PaidRouter(reject=True)
    with httpx.Client(transport=httpx.MockTransport(rejecting)) as http:
        response = S.pay_per_call(http, chat_request(), PAYER, blockhash=BLOCKHASH)
    assert response.status_code == 402 and S.parse_payment_required(response).payment_error == "invalid_exact_svm_payload_transaction_amount_mismatch"
    assert len(rejecting.requests) == 2  # no blockhash fetch, one retry only
    with pytest.raises(S.SolanaError, match="rpc_url"):
        with httpx.Client(transport=httpx.MockTransport(PaidRouter())) as http:
            S.pay_per_call(http, chat_request(), PAYER)


def test_pay_per_call_does_not_resend_a_spent_wallet_header(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(S, "build_exact_payment", lambda req, signer, blockhash, **kw: "c3R1Yg==")
    router = PaidRouter()
    with httpx.Client(transport=httpx.MockTransport(router)) as http:
        response = S.pay_per_call(http, S.with_wallet_auth(chat_request(), PAYER), PAYER, blockhash=BLOCKHASH, compute_unit_limit=60_000)
    first, retry = router.requests
    # X-Wallet-Auth is single use: the signed x402 payload of the retry needs none
    assert response.status_code == 200 and "x-wallet-auth" in first.headers and "x-wallet-auth" not in retry.headers and "x-payment" in retry.headers


def test_pay_per_call_passes_a_served_call_through() -> None:
    def served(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"ok": True})

    with httpx.Client(transport=httpx.MockTransport(served)) as http:
        assert S.pay_per_call(http, chat_request(), PAYER, RPC).json() == {"ok": True}


def test_fetch_blockhash_error() -> None:
    with httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(500, text="down"))) as http:
        with pytest.raises(S.SolanaError, match="getLatestBlockhash"):
            S.fetch_blockhash(RPC, http)


# ---- with solders: real transactions ------------------------------------------------------------------------------------


def test_exact_payment_transaction_shape() -> None:
    solders = pytest.importorskip("solders")
    from solders.transaction import VersionedTransaction

    req = S.PaymentRequirement.from_v1(requirement())
    tx = VersionedTransaction.from_bytes(base64.b64decode(S.build_exact_payment(req, PAYER, BLOCKHASH, create_destination_ata=True)))
    msg = tx.message
    keys = [str(k) for k in msg.account_keys]
    assert keys[0] == FEE_PAYER and keys[1] == PAYER.address and msg.header.num_required_signatures == 2
    assert str(msg.recent_blockhash) == BLOCKHASH and type(msg).__name__ == "Message"  # legacy: no lookup tables
    # the fee payer slot is empty, the payer has signed the message
    assert bytes(tx.signatures[0]) == bytes(64) and S.verify_signature(PAYER.public_key, bytes(msg), bytes(tx.signatures[1]))
    ata, transfer = msg.instructions
    assert keys[ata.program_id_index] == S.ASSOCIATED_TOKEN_PROGRAM and bytes(ata.data) == b"\1"
    assert [keys[i] for i in ata.accounts] == [PAYER.address, S.associated_token_address(PAY_TO), PAY_TO, S.USDC_MINT, S.SYSTEM_PROGRAM, S.TOKEN_PROGRAM]
    assert all(keys[i] != FEE_PAYER for ix in msg.instructions for i in ix.accounts)  # the fee payer funds nothing
    assert keys[transfer.program_id_index] == S.TOKEN_PROGRAM and bytes(transfer.data) == bytes([12]) + (12345).to_bytes(8, "little") + bytes([6])
    assert [keys[i] for i in transfer.accounts] == [S.associated_token_address(PAYER.public_key), S.USDC_MINT, S.associated_token_address(PAY_TO), PAYER.address]
    # without the ATA creation there is exactly one instruction; a larger amount is allowed
    only = VersionedTransaction.from_bytes(base64.b64decode(S.build_exact_payment(req, PAYER, BLOCKHASH, amount=20000)))
    assert len(only.message.instructions) == 1 and bytes(only.message.instructions[0].data)[1:9] == (20000).to_bytes(8, "little")
    # a solders Keypair is accepted as the payer
    from solders.keypair import Keypair

    kp = Keypair.from_seed(P1)
    assert S.as_signer(kp).address == PAYER.address
    assert S.build_exact_payment(req, kp, BLOCKHASH) == S.build_exact_payment(req, PAYER, BLOCKHASH)
    # an Instruction converts to a solders one, and solders reads the pure-Python transaction the same way
    converted = S.transfer_checked_instruction(S.associated_token_address(PAYER.public_key), S.USDC_MINT, S.associated_token_address(PAY_TO), PAYER.public_key, 12345).to_solders()
    assert str(converted.program_id) == S.TOKEN_PROGRAM and bytes(converted.data) == bytes(transfer.data) and [str(a.pubkey) for a in converted.accounts] == [keys[i] for i in transfer.accounts]
    assert bytes(msg) == S.parse_transaction(bytes(tx)).message


def test_open_tab_and_top_up_transactions() -> None:
    pytest.importorskip("solders")
    from solders.transaction import VersionedTransaction

    session_key = S.Signer.from_seed(P2)
    opened = S.open_tab_transaction(PROGRAM, PAYER, PAYEE, 5_000_000, EXPIRY, session_key, tab_id=42, recent_blockhash=BLOCKHASH, now=NOW)
    assert opened.tab == S.tab_address(PROGRAM, PAYER.public_key, PAYEE, 42) and opened.tab_id == 42 and opened.signed and opened.session_key == session_key.address
    assert opened.program_id == PROGRAM and opened.escrow == S.tab_escrow_address(PROGRAM, opened.tab)
    tx = VersionedTransaction.from_bytes(base64.b64decode(opened.transaction))
    keys = [str(k) for k in tx.message.account_keys]
    assert keys[0] == PAYER.address and tx.message.header.num_required_signatures == 1 and tx.verify_with_results() == [True]
    ix = tx.message.instructions[0]
    expect = S.open_tab_instruction(PROGRAM, PAYER.public_key, PAYEE, 5_000_000, EXPIRY, session_key, 42, now=NOW)
    assert bytes(ix.data) == expect.data and keys[ix.program_id_index] == PROGRAM and [keys[i] for i in ix.accounts] == [a.address for a in expect.accounts]
    # vouchers need the tab's created_at, which the payer reads from the chain once the tab is open
    session = opened.session(session_key, CREATED_AT)
    first = session.voucher(10)
    assert first.tab == opened.tab and (first.program_id, first.created_at) == (PROGRAM, CREATED_AT) and first.verify()
    with pytest.raises(TypeError):
        opened.session(session_key)
    # a random tab id when none is given; an address instead of a signer gives an unsigned transaction for a wallet
    unsigned = S.open_tab_transaction(PROGRAM, PAYER.address, PAYEE, 1, EXPIRY, session_key.address, recent_blockhash=BLOCKHASH, now=NOW)
    assert not unsigned.signed and 0 <= unsigned.tab_id < 1 << 64
    assert bytes(VersionedTransaction.from_bytes(base64.b64decode(unsigned.transaction)).signatures[0]) == bytes(64)
    assert VersionedTransaction.from_bytes(base64.b64decode(S.sign_transaction(unsigned.transaction, PAYER))).verify_with_results() == [True]
    with pytest.raises(S.SolanaError, match="30 days"):
        S.open_tab_transaction(PROGRAM, PAYER, PAYEE, 1, NOW + S.MAX_TAB_LIFETIME_SECONDS + 1, session_key, recent_blockhash=BLOCKHASH, now=NOW)
    top = VersionedTransaction.from_bytes(base64.b64decode(S.top_up_transaction(PROGRAM, PAYER, opened.tab, 250_000, recent_blockhash=BLOCKHASH)))
    assert top.verify_with_results() == [True] and bytes(top.message.instructions[0].data) == S.TOP_UP_DISCRIMINATOR + (250_000).to_bytes(8, "little")
    # anyone may send a reclaim: the fee payer is the only signer, the tab's payer signs nothing
    sender = S.Signer.from_seed(P3)
    reclaim = VersionedTransaction.from_bytes(base64.b64decode(S.reclaim_transaction(PROGRAM, PAYER.address, PAYEE, opened.tab, sender, recent_blockhash=BLOCKHASH)))
    assert reclaim.verify_with_results() == [True] and reclaim.message.header.num_required_signatures == 1 and str(reclaim.message.account_keys[0]) == sender.address


def test_pda_parity_with_solders() -> None:
    pytest.importorskip("solders")
    from solders.pubkey import Pubkey

    for _ in range(100):
        seeds, program = [os.urandom(n) for n in (4, 32, 8)], os.urandom(32)
        pda, bump = Pubkey.find_program_address(seeds, Pubkey.from_bytes(program))
        assert S._find_program_address_py(seeds, program) == (bytes(pda), bump)
    for _ in range(500):
        raw = os.urandom(32)
        assert S._on_curve(raw) == Pubkey.from_bytes(raw).is_on_curve()


def test_pay_per_call_with_solders() -> None:
    pytest.importorskip("solders")
    from solders.transaction import VersionedTransaction

    router = PaidRouter()
    with httpx.Client(transport=httpx.MockTransport(router)) as http:
        response = S.pay_per_call(http, chat_request(), PAYER, RPC)
    assert response.status_code == 200
    tx = VersionedTransaction.from_bytes(base64.b64decode(response.json()["paid_tx"]))
    assert str(tx.message.account_keys[0]) == FEE_PAYER and str(tx.message.recent_blockhash) == BLOCKHASH and tx.verify_with_results() == [False, True]


# ---- the Trellis clients: credits, X-Wallet-Auth and pay_per_call -----------------------------------------------------

from trellis import AsyncTrellis, BadRequestError, Trellis

API_KEY = "sk-test-123"


class CreditsRouter:
    def __init__(self) -> None:
        self.requests: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if request.headers.get("authorization") != f"Bearer {API_KEY}":
            return httpx.Response(401, json={"error": {"code": 401, "message": "Missing or invalid API key.", "type": "unauthorized"}})
        path, body = request.url.path, (json.loads(request.content) if request.content else None)
        if path == "/api/v1/credits/deposit-tx" and request.method == "POST":
            if body["amount"] == "999999":
                return httpx.Response(400, json={"error": {"code": 400, "message": "deposit above the per-key cap", "type": "deposit_refused"}})
            return httpx.Response(200, json={"data": {"transaction": "dHg=", "message": "Deposit 12.50 USDC", "network": S.MAINNET, "amount_usdc": body["amount"], "amount_units": str(S.parse_usdc(body["amount"])), "accounts": {"depositor": body["payer"]}, "expires_at_block_height": 100, "key_hash": "0x" + "ab" * 32}})
        if path == "/api/v1/credits/close" and request.method == "POST":
            if set(body) != {"payer"}:  # a closure names no destination: the router refuses one that does
                return httpx.Response(400, json={"error": {"code": 400, "message": "Send only { payer }.", "type": "refund_destination_fixed"}})
            payer = body["payer"]  # the wallet that pays the fee; the key has already signed
            refunds = [{"depositor": PAYER.address, "refund_to": S.associated_token_address(PAYER), "deposited_units": "12500000", "refunded_units": "0"}]
            return httpx.Response(201, json={"data": {"id": "close_1", "status": "queued", "payer": payer, "authority": payer, "payable_at": "2026-10-13T00:00:00.000Z", "transaction": "Y2xvc2U=", "message": "Close", "accounts": {}, "expires_at_block_height": 100, "signed_by_key": True, "refunds": refunds, "note": "Sign with the payer wallet."}})
        if path == "/api/v1/credits/close/cancel" and request.method == "POST":
            return httpx.Response(200, json={"data": {"transaction": "Y2FuY2Vs", "message": "Cancel", "accounts": {}, "payer": body["payer"], "expires_at_block_height": 100, "signed_by_key": True, "note": "Sign with the payer wallet."}})
        if path == "/api/v1/credits/close" and request.method == "GET":
            return httpx.Response(200, json={"data": [{"id": "close_1", "status": "queued", "reason": None, "refund_to": None, "refunds": [], "amount_units": None, "requested_at": "2026-10-10T00:00:00.000Z", "payable_at": "2026-10-13T00:00:00.000Z", "paid_at": None, "register_tx": None, "pay_tx": None, "cancel_tx": None, "released_at": None}]})
        return httpx.Response(404, json={"error": {"code": 404, "message": "no route", "type": "not_found"}})


def test_credits_deposit_tx_and_close() -> None:
    router = CreditsRouter()
    with Trellis(API_KEY, base_url=ROUTER, http_client=httpx.Client(transport=httpx.MockTransport(router))) as client:
        deposit = client.credits.deposit_tx("12.50", PAYER)
        assert deposit["transaction"] == "dHg=" and deposit["amount_units"] == "12500000" and deposit["accounts"]["depositor"] == PAYER.address
        sent = router.requests[-1]
        assert sent.method == "POST" and sent.url.path == "/api/v1/credits/deposit-tx" and json.loads(sent.content) == {"amount": "12.50", "payer": PAYER.address}
        assert json.loads(router.requests[-1].content) == json.loads(sent.content)
        assert client.credits.deposit_tx(12_500_000, PAYER.address)["amount_usdc"] == "12.5"
        with pytest.raises(BadRequestError, match="cap") as info:
            client.credits.deposit_tx("999999", PAYER)
        assert info.value.type == "deposit_refused"
        closed = client.credits.close(payer=PAY_TO)
        assert closed["id"] == "close_1" and closed["transaction"] == "Y2xvc2U=" and json.loads(router.requests[-1].content) == {"payer": PAY_TO}
        assert closed["signed_by_key"] is True and closed["payer"] == PAY_TO  # any wallet pays the fee: the one named, nothing is defaulted
        assert "refund_to" not in closed and [r["depositor"] for r in closed["refunds"]] == [PAYER.address]  # the refund returns to who paid in
        paid_by = client.credits.close(payer=PAYER)
        assert json.loads(router.requests[-1].content) == {"payer": PAYER.address} and paid_by["payer"] == PAYER.address
        # a call written for the earlier contract raises and is not sent as something else
        sent_so_far = len(router.requests)
        for old_style in (lambda: client.credits.close(PAY_TO), lambda: client.credits.close(PAY_TO, payer=PAYER), lambda: client.credits.close(refund_to=PAY_TO), lambda: client.credits.close()):
            with pytest.raises(S.SolanaError, match="names no destination.*wallets that funded the key.*only payer="):
                old_style()
        assert len(router.requests) == sent_so_far
        cancelled = client.credits.cancel_close(payer=PAYER)
        assert cancelled["transaction"] == "Y2FuY2Vs" and router.requests[-1].url.path == "/api/v1/credits/close/cancel" and json.loads(router.requests[-1].content) == {"payer": PAYER.address}
        assert router.requests[-1].headers["authorization"] == f"Bearer {API_KEY}"  # asked with the key itself
        closures = client.credits.closures()
        assert router.requests[-1].method == "GET" and len(closures) == 1 and closures[0]["status"] == "queued"


def test_client_wallet_auth_header_and_request() -> None:
    body, url = b'{"model":"example/model"}', f"{ROUTER}/api/v1/chat/completions"
    header = Trellis.wallet_auth_header(PAYER, "POST", url, body, timestamp=1_700_000_000)
    assert header == S.wallet_auth_header(PAYER, "POST", url, body, timestamp=1_700_000_000)
    seen: list[httpx.Request] = []
    with Trellis(None, base_url=ROUTER, http_client=httpx.Client(transport=httpx.MockTransport(lambda r: seen.append(r) or httpx.Response(200)))) as client:
        # the header is computed from the request the client built: its method, its URL, its body
        request = S.with_wallet_auth(client.request("POST", "/chat/completions", json_body={"model": "example/model"}), PAYER, timestamp=1_700_000_000)
        assert client.send(request).status_code == 200
    assert str(request.url) == url and request.content == body and "authorization" not in request.headers
    assert seen[0].headers["x-wallet-auth"] == header


def test_pay_per_call_with_a_trellis_client(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(S, "build_exact_payment", lambda req, signer, blockhash, **kw: "c3R1Yg==")
    router = PaidRouter()
    with Trellis(None, base_url=ROUTER, http_client=httpx.Client(transport=httpx.MockTransport(router))) as client:
        request = client.request("POST", "/chat/completions", json_body={"model": "example/model", "messages": []})
        response = S.pay_per_call(client, request, PAYER, RPC)
    assert response.status_code == 200 and response.json()["paid_tx"] == "c3R1Yg==" and len(router.requests) == 3
    assert router.requests[-1].headers["user-agent"].startswith("trellis-python/")


@pytest.mark.anyio
async def test_async_credits_and_pay_per_call(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(S, "build_exact_payment", lambda req, signer, blockhash, **kw: "c3R1Yg==")
    credits, paid = CreditsRouter(), PaidRouter()
    async with AsyncTrellis(API_KEY, base_url=ROUTER, http_client=httpx.AsyncClient(transport=httpx.MockTransport(credits))) as client:
        deposit = await client.credits.deposit_tx("1", PAYER)
        assert deposit["amount_units"] == "1000000"
        assert (await client.credits.close(payer=PAY_TO))["status"] == "queued" and len(await client.credits.closures()) == 1
        assert json.loads(credits.requests[-2].content) == {"payer": PAY_TO}
        assert (await client.credits.close(payer=PAYER))["payer"] == PAYER.address
        sent_so_far = len(credits.requests)
        for old_style in (lambda: client.credits.close(PAY_TO), lambda: client.credits.close(PAY_TO, payer=PAYER), lambda: client.credits.close(refund_to=PAY_TO)):
            with pytest.raises(S.SolanaError, match="names no destination"):
                await old_style()
        assert len(credits.requests) == sent_so_far
        assert (await client.credits.cancel_close(payer=PAYER))["signed_by_key"] is True and json.loads(credits.requests[-1].content) == {"payer": PAYER.address}
        assert client.wallet_auth_header(PAYER, "GET", f"{ROUTER}/api/v1/refunds", timestamp=1) == S.wallet_auth_header(PAYER, "GET", f"{ROUTER}/api/v1/refunds", timestamp=1)
    async with AsyncTrellis(None, base_url=ROUTER, http_client=httpx.AsyncClient(transport=httpx.MockTransport(paid))) as client:
        response = await S.async_pay_per_call(client, client.request("POST", "/chat/completions", json_body={"model": "example/model"}), PAYER, RPC)
    assert response.status_code == 200 and [str(r.url) for r in paid.requests][1] == RPC


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"
