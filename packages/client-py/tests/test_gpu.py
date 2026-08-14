from __future__ import annotations

import copy
import json
from datetime import datetime
from pathlib import Path

import httpx

from trellis_client import GPU_EVIDENCE_LIMITS, evaluate_attestation, verify_gpu_evidence

# One synthetic document with NVIDIA GPU evidence (two GPUs, a boot record and a refresh), the test attestation service's
# public keys, and what the TypeScript verifier said about it. The same file is checked by packages/client/test/gpu.test.ts,
# so the two implementations are held to the same bytes.
FIXTURE = json.loads((Path(__file__).resolve().parents[2] / "client" / "test" / "fixtures" / "gpu-evidence.json").read_text())
NOW_MS = datetime.fromisoformat(FIXTURE["now"].replace("Z", "+00:00")).timestamp() * 1000
ISSUER = FIXTURE["issuer"]
JWKS = FIXTURE["jwks"]["keys"]


def doc():
    return copy.deepcopy(FIXTURE["document"])


def verify(document, **over):
    args = dict(jwks=JWKS, issuer=ISSUER, now_ms=NOW_MS, allowed_models=["GH100"])
    args.update(over)
    return verify_gpu_evidence(document, **args)


def codes(v):
    return [code for code, _ in v.failures]


def router():
    return {"provider": "gpu-provider", "status": "attested", "tee": "tdx", "attested_at": FIXTURE["now"], "attestation_hash": "0x" + "12" * 32, "verifiers": ["dcap"], "measurement": None, "checks": {"quote_verified": True}, "not_checked": ["That prompts stay inside the enclave."]}


class TestSameAnswerAsTheTypeScriptVerifier:
    def test_the_recorded_document_verifies_with_the_same_result(self):
        v = verify(doc())
        want = FIXTURE["expected"]
        assert v.failures == [] and v.ok and v.status == want["status"] == "verified"
        assert (v.evidence_sha256, v.nonce, v.verified_at, v.expires_at) == (want["evidence_sha256"], want["nonce"], want["verified_at"], want["expires_at"])
        assert [g["model"] for g in v.gpus] == want["models"]
        assert [g["token_sha256"] for g in v.gpus] == want["token_sha256"]
        assert v.not_checked == want["not_checked"]
        assert v.not_checked[: len(GPU_EVIDENCE_LIMITS)] == GPU_EVIDENCE_LIMITS

    def test_no_gpu_member_and_no_binding_is_absent_not_a_failure(self):
        d = doc()
        d["gpu"] = None
        del d["bindings"]["gpu_evidence_sha256"]
        v = verify(d)
        assert v.status == "absent" and not v.ok and v.failures == []


class TestItFailsClosed:
    def test_expired_tokens(self):
        v = verify(doc(), now_ms=NOW_MS + 2 * 3_600_000)
        assert not v.ok and "token_expired" in codes(v)

    def test_a_refresh_carries_expired_boot_tokens_but_not_without_its_signature(self):
        d = doc()
        assert verify(d, now_ms=NOW_MS + 30 * 60_000).ok  # the boot tokens are 70 minutes old by then; the refresh is 40
        d["gpu"]["refresh"]["signature"]["sig"] = d["gpu"]["boot"]["signature"]["sig"]
        assert "refresh_signature_invalid" in codes(verify(d))
        d = doc()
        d["gpu"]["refresh"] = None
        assert verify(d).ok and "token_expired" in codes(verify(d, now_ms=NOW_MS + 30 * 60_000))

    def test_another_issuer_or_other_keys(self):
        assert "issuer_mismatch" in codes(verify(doc(), issuer="https://nras.attestation.nvidia.com"))
        other = [dict(JWKS[0], kid="someone-else")]
        assert "unknown_signing_key" in codes(verify(doc(), jwks=other))
        swapped = [dict(JWKS[0], x=JWKS[0]["y"], y=JWKS[0]["x"])]
        assert not verify(doc(), jwks=swapped).ok

    def test_a_tampered_token_a_wrong_binding_and_other_keys_in_the_bindings(self):
        d = doc()
        t = d["gpu"]["refresh"]["tokens"]["gpus"]["GPU-1"]
        d["gpu"]["refresh"]["tokens"]["gpus"]["GPU-1"] = t[:-4] + ("AAAA" if not t.endswith("AAAA") else "BBBB")
        assert not verify(d).ok
        d = doc()
        d["bindings"]["gpu_evidence_sha256"] = "ab" * 32
        assert "evidence_unbound" in codes(verify(d))
        d = doc()
        d["bindings"]["tls_pubkey"] = "04" + "cd" * 64
        assert "nonce_derivation_mismatch" in codes(verify(d))
        d = doc()
        d["gpu"] = None
        assert codes(verify(d)) == ["evidence_missing"]

    def test_driver_state_and_your_own_model_list(self):
        d = doc()
        d["gpu"]["refresh"] = None
        d["gpu"]["boot"]["local"]["cc_state"] = "off"
        # The summary changed, so the binding no longer matches either: both are reported.
        assert {"cc_state_not_on", "evidence_unbound"} <= set(codes(verify(d)))
        assert "model_not_allowed" in codes(verify(doc(), allowed_models=["GB100"]))
        assert "GPU model: no allow-list was supplied" in verify(doc(), allowed_models=None).not_checked


class TestEvaluateAttestation:
    def test_the_gpu_check_passes_and_lists_its_limits(self):
        v = evaluate_attestation(provider_id="gpu-provider", router=router(), boot=doc(), now_ms=NOW_MS, gpu_issuer=ISSUER, gpu_jwks=JWKS, gpu_allowed_models=["GH100"])
        assert v.failures == [] and v.ok
        assert v.status("gpu") == "pass" and v.gpu.ok
        assert all(limit in v.not_checked for limit in GPU_EVIDENCE_LIMITS)

    def test_without_gpu_evidence_it_is_not_checked_unless_required(self):
        d = doc()
        d["gpu"] = None
        del d["bindings"]["gpu_evidence_sha256"]
        # The bindings changed, so this document's quote no longer commits to them; only the gpu check is looked at here.
        v = evaluate_attestation(provider_id="gpu-provider", router=router(), boot=d, now_ms=NOW_MS, gpu_jwks=JWKS)
        assert v.status("gpu") == "not_checked" and v.gpu is None
        v = evaluate_attestation(provider_id="gpu-provider", router=router(), boot=d, now_ms=NOW_MS, gpu_jwks=JWKS, gpu_require=True)
        assert v.status("gpu") == "fail" and not v.ok

    def test_evidence_the_quote_does_not_commit_to_fails(self):
        d = doc()
        d["bindings"]["model_digest"] = "sha256:" + "44" * 32
        v = evaluate_attestation(provider_id="gpu-provider", router=router(), boot=d, now_ms=NOW_MS, gpu_issuer=ISSUER, gpu_jwks=JWKS)
        assert (v.status("provider.report_data"), v.status("gpu")) == ("fail", "fail") and not v.ok

    def test_the_keys_come_from_your_issuer_never_from_the_document(self):
        seen: list[str] = []

        def handler(request: httpx.Request) -> httpx.Response:
            seen.append(str(request.url))
            return httpx.Response(200, json=FIXTURE["jwks"])

        d = doc()
        d["gpu"]["nras_url"] = "https://rogue.example"
        with httpx.Client(transport=httpx.MockTransport(handler)) as http:
            v = evaluate_attestation(provider_id="gpu-provider", router=router(), boot=d, now_ms=NOW_MS, gpu_issuer=ISSUER, gpu_http=http)
        assert v.status("gpu") == "pass" and seen == [f"{ISSUER}/.well-known/jwks.json"]

        def down(request: httpx.Request) -> httpx.Response:
            return httpx.Response(503)

        with httpx.Client(transport=httpx.MockTransport(down)) as http:
            v = evaluate_attestation(provider_id="gpu-provider", router=router(), boot=doc(), now_ms=NOW_MS, gpu_issuer=ISSUER, gpu_http=http)
        assert v.status("gpu") == "fail" and not v.ok
