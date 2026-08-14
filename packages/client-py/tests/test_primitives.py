from __future__ import annotations

import hashlib

import pytest

from trellis_client import canonical_bytes, canonical_json, parse_tdx_quote, sha256d
from trellis_client.canonical import js_number

from .conftest import Real, load_json


def test_canonical_json_matches_the_javascript_vectors():
    # Expected strings were produced by the router's own canonicalJson (src/lib/util.ts) from the same input text.
    import json

    for case in load_json("canonical-vectors.json"):
        assert canonical_json(json.loads(case["input"])) == case["expected"], case["input"]


def test_key_order_is_by_utf16_code_unit_not_code_point():
    # U+FFFF sorts before the surrogate pair of U+1F600 in JavaScript, after it by Python code point order.
    assert canonical_json({"\U0001f600": 1, "￿": 2}) == '{"\U0001f600":1,"￿":2}'


def test_numbers_are_formatted_like_javascript():
    assert [js_number(x) for x in (1e21, 1e20, 1e-7, 1e-6, 100.0, 0.1, 5e-324, -2.5e-10)] == ["1e+21", "100000000000000000000", "1e-7", "0.000001", "100", "0.1", "5e-324", "-2.5e-10"]
    assert canonical_json({"a": 2**60}) == '{"a":1152921504606847000}'  # beyond 2**53 a JS number is a double
    assert canonical_json({"a": 2**53 + 1}) == '{"a":9007199254740992}'


def test_unsupported_types_are_refused():
    with pytest.raises(TypeError):
        canonical_json({"a": object()})


def test_sha256d_is_the_double_sha256():
    # The TypeScript client, the sidecar and the router's Merkle code must all produce these.
    assert sha256d(b"") == hashlib.sha256(bytes.fromhex("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")).digest()
    assert sha256d(b"abc").hex() == "4f8b42c22dd3729b519ba6f68d2da7cc5b2d606d05daed5ad5128cc03e6c6358"
    assert sha256d(b"abc") != hashlib.sha256(b"abc").digest()


def test_canonical_bindings_digest_is_what_the_sidecar_committed():
    boot = Real.boot()
    assert hashlib.sha256(canonical_bytes(boot["bindings"])).hexdigest() == boot["report_data"]["bindings_digest"]


def test_quote_fields_match_the_document():
    boot = Real.boot()
    f = parse_tdx_quote(bytes.fromhex(Real.quote_hex()))
    assert (f.version, f.tee_type) == (4, 0x81)
    assert f.mrtd == boot["evidence"]["measurements"]["mrtd"]
    assert f.rtmr3 == boot["evidence"]["measurements"]["rtmr3"]
    assert f.report_data == boot["evidence"]["report_data"]
    assert boot["evidence"]["quote"] == Real.quote_hex()


def test_quote_reader_rejects_short_or_foreign_quotes():
    with pytest.raises(ValueError, match="too short"):
        parse_tdx_quote(b"\x00" * 100)
    q = bytearray(bytes.fromhex(Real.quote_hex()))
    q[0] = 3
    with pytest.raises(ValueError, match="version"):
        parse_tdx_quote(bytes(q))
