"""NVIDIA GPU attestation evidence in a provider's attestation document.

A port of the TypeScript client's ``src/gpu.ts`` (the sidecar's ``gpu-verify.ts``): the same checks in the same order,
with the same failure codes, so both clients judge one document alike. ``tests/test_gpu.py`` runs both over one
recorded synthetic document.

What is verified is the answer of the NVIDIA Remote Attestation Service (NRAS): one overall JWT plus one JWT per GPU,
signed ES384 by a key NRAS publishes as a JWKS. NRAS is the party that checked the GPU's own attestation report; this
code checks NRAS's signature, what NRAS said, and how that statement is tied to one enclave (a nonce derived from the
keys the TDX quote commits to, and a hash of the evidence in the quote-bound bindings). The caller must already have
checked that the quote's report_data commits to the document's bindings; ``evaluate_attestation`` does.

The issuer and its keys are the caller's trust anchor. The ``nras_url`` a document names is never used.
"""

from __future__ import annotations

import base64
import hashlib
import json
import re
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from functools import cmp_to_key
from typing import Any

import httpx
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from cryptography.hazmat.primitives.asymmetric.utils import encode_dss_signature

from .canonical import canonical_json

NRAS_DEFAULT_URL = "https://nras.attestation.nvidia.com"
GPU_NONCE_DOMAIN = "trellis-gpu-nonce/v1"
GPU_EVIDENCE_DOMAIN = "trellis-gpu-evidence/v1"
GPU_EVIDENCE_TYPE = "trellis.gpu.evidence"

# What a successful result still does not establish. The same text as the TypeScript verifier's GPU_EVIDENCE_LIMITS.
GPU_EVIDENCE_LIMITS = [
    "NRAS attests that a genuine NVIDIA GPU signed a report over this nonce and that its firmware and driver measurements match NVIDIA's reference values. Trust rests on NVIDIA's device keys, reference values and the NRAS signing key.",
    "Nothing hardware-enforced ties the GPU to this TD (there is no TDISP binding on these parts). The tie is the nonce, which only the measured sidecar derives from keys the TDX quote commits to, and the measured guest software that talks to the GPU.",
    "cc_state, devtools_mode and multi_gpu_mode are read from the in-guest NVIDIA driver (nvidia-smi) by the sidecar. They are committed in the evidence summary but are not signed by the GPU or by NRAS.",
    "The evidence covers the GPUs visible to the sidecar at the moment of each attestation. It does not show which GPU served a given request, nor anything between two attestations.",
    "With several GPUs in protected-PCIe mode, NVLink traffic between them is not encrypted; this evidence says nothing about the links.",
]


@dataclass
class GpuVerification:
    """``absent``: the document carries no GPU evidence and its bindings commit to none. ``verified``: every check passed."""

    status: str
    failures: list[tuple[str, str]] = field(default_factory=list)
    not_checked: list[str] = field(default_factory=list)
    gpus: list[dict[str, Any]] = field(default_factory=list)
    verified_at: str | None = None
    expires_at: str | None = None
    nonce: str | None = None
    evidence_sha256: str | None = None

    @property
    def ok(self) -> bool:
        return self.status == "verified"


def _sha256_hex(data: str | bytes) -> str:
    return hashlib.sha256(data.encode() if isinstance(data, str) else data).hexdigest()


def _b64(s: str) -> bytes:
    std = s.replace("-", "+").replace("_", "/")
    return base64.b64decode(std + "=" * (-len(std) % 4), validate=True)


def _iso(seconds: float) -> str:
    return datetime.fromtimestamp(seconds, tz=timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _issuer(url: str) -> str:
    return url.strip().rstrip("/")


def _is_hex(v: Any, n_bytes: int | None = None) -> bool:
    return isinstance(v, str) and re.fullmatch(r"(?:[0-9a-f]{2})*", v) is not None and (n_bytes is None or len(v) == n_bytes * 2)


def _sorted_ids(gpus: dict[str, Any]) -> list[str]:
    """ "GPU-0", "GPU-1", ... "GPU-10" in numeric order; anything else by name (the TypeScript rule)."""

    def number(i: str) -> float | None:
        rest = re.sub(r"^\D+", "", i)
        return 0.0 if rest == "" else float(rest) if re.fullmatch(r"\d+(?:\.\d+)?", rest) else None

    def compare(a: str, b: str) -> int:
        x, y = number(a), number(b)
        if x is not None and y is not None and x != y:
            return -1 if x < y else 1
        return -1 if a < b else 1 if a > b else 0

    return sorted(gpus, key=cmp_to_key(compare))


def derive_gpu_nonce(bindings: dict[str, Any], nonce_input: dict[str, Any]) -> str:
    """sha256(canonical_json({v, receipt_pubkey, tls_pubkey, [hpke_pubkey], issued_at, salt})): what the GPUs signed."""
    body = {"v": GPU_NONCE_DOMAIN, "receipt_pubkey": str(bindings.get("receipt_pubkey") or ""), "tls_pubkey": str(bindings.get("tls_pubkey") or ""), "issued_at": nonce_input["issued_at"], "salt": nonce_input["salt"]}
    if isinstance(bindings.get("hpke_pubkey"), str) and bindings["hpke_pubkey"]:
        body["hpke_pubkey"] = bindings["hpke_pubkey"]
    return _sha256_hex(canonical_json(body))


def gpu_summary(r: dict[str, Any]) -> dict[str, Any]:
    """The canonical summary of one attestation: everything but the tokens themselves, which enter by hash."""
    local = r["local"]
    return {
        "v": 1,
        "type": GPU_EVIDENCE_TYPE,
        "seq": r["seq"],
        "verified_at": r["verified_at"],
        "nonce": r["nonce"],
        "nonce_input": {"issued_at": r["nonce_input"]["issued_at"], "salt": r["nonce_input"]["salt"]},
        "arch": r["arch"],
        "verifier": {"kind": r["verifier"]["kind"], "issuer": r["verifier"]["issuer"]},
        "local": {"source": local["source"], "cc_state": local["cc_state"], "devtools_mode": local["devtools_mode"], "multi_gpu_mode": local["multi_gpu_mode"], "uuids": list(local["uuids"])},
        "token_sha256": {"overall": _sha256_hex(r["tokens"]["overall"]), "gpus": {i: _sha256_hex(r["tokens"]["gpus"][i]) for i in _sorted_ids(r["tokens"]["gpus"])}},
    }


def fetch_nras_jwks(url: str, http: httpx.Client | None = None, timeout: float = 15.0) -> list[dict[str, Any]]:
    """Fetch a JWKS. The URL must be your own trust anchor, never one named by the evidence being checked."""
    res = (http.get if http else httpx.get)(url, headers={"accept": "application/json"}, timeout=timeout, follow_redirects=False)
    if res.status_code != 200:
        raise ValueError(f"JWKS endpoint answered HTTP {res.status_code}")
    body = res.json()
    keys = [k for k in body.get("keys", []) if isinstance(k, dict)] if isinstance(body, dict) and isinstance(body.get("keys"), list) else []
    if not keys:
        raise ValueError("JWKS endpoint returned no keys")
    return keys


def _parse_jwt(token: Any) -> tuple[dict[str, Any], dict[str, Any], bytes, bytes] | None:
    if not isinstance(token, str):
        return None
    parts = token.split(".")
    if len(parts) != 3 or any(re.fullmatch(r"[A-Za-z0-9_-]+", p) is None for p in parts):
        return None
    try:
        header, claims = json.loads(_b64(parts[0])), json.loads(_b64(parts[1]))
        if not isinstance(header, dict) or not isinstance(claims, dict):
            return None
        return header, claims, f"{parts[0]}.{parts[1]}".encode(), _b64(parts[2])
    except ValueError:
        return None


def _check_signature(header: dict[str, Any], signed: bytes, signature: bytes, jwks: list[dict[str, Any]]) -> tuple[str, str] | None:
    """NRAS signs ES384 (P-384 keys). Nothing else is accepted, whatever the token's header asks for."""
    if header.get("alg") != "ES384":
        return ("unsupported_alg", f"token is signed with {header.get('alg')}; only ES384 is accepted")
    kid = header.get("kid") if isinstance(header.get("kid"), str) else None
    key = next((k for k in jwks if k.get("kid") == kid), None) if kid is not None else None
    if key is None:
        return ("unknown_signing_key", f"token is signed by key {kid or '(no kid)'}, which the verifier's JWKS does not list")
    if key.get("kty") != "EC" or key.get("crv") != "P-384" or not isinstance(key.get("x"), str) or not isinstance(key.get("y"), str):
        return ("unknown_signing_key", f"JWKS key {kid} is not a P-384 public key")
    try:
        if len(signature) != 96:
            raise InvalidSignature
        pub = ec.EllipticCurvePublicNumbers(int.from_bytes(_b64(key["x"]), "big"), int.from_bytes(_b64(key["y"]), "big"), ec.SECP384R1()).public_key()
        pub.verify(encode_dss_signature(int.from_bytes(signature[:48], "big"), int.from_bytes(signature[48:], "big")), signed, ec.ECDSA(hashes.SHA384()))
        return None
    except InvalidSignature:
        return ("signature_invalid", f"token signature does not verify under JWKS key {kid}")
    except ValueError:
        return ("signature_invalid", f"token signature could not be checked under JWKS key {kid}")


def _model_allowed(hwmodel: str, allowed: list[str]) -> bool:
    norm = lambda s: re.sub(r"\s+", " ", s.strip()).upper()  # noqa: E731
    m = norm(hwmodel)
    return any(e and (m == e or m.startswith(e + " ")) for e in map(norm, allowed))


def _compare_dotted(a: str, b: str, radix: int) -> int | None:
    digits = r"[0-9]+" if radix == 10 else r"[0-9a-fA-F]+"

    def parse(s: str) -> list[int] | None:
        parts = s.strip().split(".")
        return [int(p, radix) for p in parts] if all(re.fullmatch(digits, p) for p in parts) else None

    x, y = parse(a), parse(b)
    if x is None or y is None:
        return None
    for i in range(max(len(x), len(y))):
        d = (x[i] if i < len(x) else 0) - (y[i] if i < len(y) else 0)
        if d:
            return -1 if d < 0 else 1
    return 0


def _text(v: Any) -> str | None:
    return v if isinstance(v, str) and v else None


def _is_number(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def verify_nras_tokens(
    tokens: dict[str, Any], *, nonce: str, issuer: str, jwks: list[dict[str, Any]], now_ms: float | None, allowed_models: list[str] | None = None,
    min_driver_version: str | None = None, min_vbios_version: str | None = None, clock_skew_seconds: float = 60,
) -> tuple[list[tuple[str, str]], list[str], list[dict[str, Any]], float | None]:
    """Check a detached EAT from NRAS. Returns (failures, not_checked, gpus, earliest expiry in Unix seconds).

    ``now_ms=None`` skips the validity window (a boot record that has since been refreshed)."""
    failures: list[tuple[str, str]] = []
    not_checked: list[str] = []
    gpus: list[dict[str, Any]] = []
    expires: list[float] = []
    issuer = _issuer(issuer)
    nonce = nonce.lower()

    def note(text: str) -> None:
        if text not in not_checked:
            not_checked.append(text)

    def common(label: str, token: Any, require_window: bool) -> dict[str, Any] | None:
        jwt = _parse_jwt(token)
        if jwt is None:
            failures.append(("token_malformed", f"{label}: not a compact JWT"))
            return None
        header, claims, signed, signature = jwt
        bad = _check_signature(header, signed, signature, jwks)
        if bad:
            failures.append((bad[0], f"{label}: {bad[1]}"))
            return None
        iss = _text(claims.get("iss"))
        if require_window if iss is None else _issuer(iss) != issuer:
            failures.append(("issuer_mismatch", f"{label}: issued by {iss or '(nobody)'}, expected {issuer}"))
        exp = claims.get("exp") if _is_number(claims.get("exp")) else None
        nbf = claims.get("nbf") if _is_number(claims.get("nbf")) else None
        if exp is not None:
            expires.append(exp)
        if now_ms is not None:
            now = now_ms / 1000
            if exp is None and require_window:
                failures.append(("token_expired", f"{label}: carries no expiry"))
            if exp is not None and now > exp + clock_skew_seconds:
                failures.append(("token_expired", f"{label}: expired at {_iso(exp)}"))
            if nbf is not None and now < nbf - clock_skew_seconds:
                failures.append(("token_not_yet_valid", f"{label}: not valid before {_iso(nbf)}"))
        if str(claims.get("eat_nonce") if claims.get("eat_nonce") is not None else "").lower() != nonce:
            failures.append(("nonce_mismatch", f"{label}: eat_nonce is not the nonce this attestation asked the GPU to sign"))
        return claims

    per_gpu = tokens.get("gpus") if isinstance(tokens.get("gpus"), dict) else {}
    ids = _sorted_ids(per_gpu)
    overall = common("overall token", tokens.get("overall"), True)
    if overall is not None:
        if "sub" in overall and overall["sub"] != "NVIDIA-PLATFORM-ATTESTATION":
            failures.append(("claim_failed", f"overall token: unexpected subject {overall['sub']}"))
        if overall.get("x-nvidia-overall-att-result") is not True:
            failures.append(("overall_result_failed", "overall token: x-nvidia-overall-att-result is not true"))
        submods = overall.get("submods") if isinstance(overall.get("submods"), dict) else None
        if submods is None:
            failures.append(("submods_mismatch", "overall token: no submods to tie the per-GPU tokens to it"))
        else:
            if sorted(submods) != sorted(ids):
                failures.append(("submods_mismatch", f"overall token names [{','.join(sorted(submods))}] but the per-GPU tokens are [{','.join(sorted(ids))}]"))
            for i in ids:
                e = submods.get(i)
                ok_shape = isinstance(e, list) and len(e) > 1 and e[0] == "DIGEST" and isinstance(e[1], list) and len(e[1]) > 1 and re.fullmatch(r"SHA-?256", str(e[1][0]), re.I)
                digest = str(e[1][1]).lower() if ok_shape else None
                actual = _sha256_hex(per_gpu[i]) if isinstance(per_gpu[i], str) else ""
                if i in submods and digest != actual:
                    failures.append(("submods_mismatch", f"{i}: the overall token's digest is not the SHA-256 of this GPU's token"))
    if not ids:
        failures.append(("no_gpu_tokens", "the verifier returned no per-GPU token"))

    for i in ids:
        cl = common(i, per_gpu[i], False)
        if cl is None:
            continue
        if cl.get("measres") != "success":
            failures.append(("measurement_failed", f"{i}: measres is {json.dumps(cl.get('measres'))}; the GPU's runtime measurements do not match NVIDIA's reference values"))
        for k in sorted(cl):
            if k.startswith("x-nvidia-gpu-") and cl[k] is False:
                failures.append(("claim_failed", f"{i}: {k} is false"))
        if "x-nvidia-gpu-attestation-report-nonce-match" not in cl:
            note("x-nvidia-gpu-attestation-report-nonce-match is not in the token (eat_nonce was compared instead)")
        if cl.get("secboot") is False:
            failures.append(("secure_boot_off", f"{i}: secboot is false"))
        elif "secboot" not in cl:
            note("secboot is not in the token")
        if "dbgstat" in cl and cl["dbgstat"] != "disabled":
            failures.append(("debug_enabled", f"{i}: dbgstat is {json.dumps(cl['dbgstat'])}"))
        elif "dbgstat" not in cl:
            note("dbgstat is not in the token")

        model = _text(cl.get("hwmodel")) or "unknown"
        if not allowed_models:
            note("GPU model: no allow-list was supplied")
        elif not _model_allowed(model, allowed_models):
            failures.append(("model_not_allowed", f'{i}: hwmodel "{model}" is not on the allow-list ({", ".join(allowed_models)})'))

        driver, vbios = _text(cl.get("x-nvidia-gpu-driver-version")), _text(cl.get("x-nvidia-gpu-vbios-version"))
        for what, code, have, minimum, radix in (("driver", "driver_too_old", driver, min_driver_version, 10), ("vBIOS", "vbios_too_old", vbios, min_vbios_version, 16)):
            if not minimum:
                continue
            cmp = None if have is None else _compare_dotted(have, minimum, radix)
            if cmp is None:
                failures.append((code, f"{i}: {what} version {have or '(not in the token)'} cannot be compared with the minimum {minimum}"))
            elif cmp < 0:
                failures.append((code, f"{i}: {what} version {have} is below the minimum {minimum}"))
        gpus.append({"id": i, "model": model, "ueid": _text(cl.get("ueid")), "driver_version": driver, "vbios_version": vbios, "token_sha256": _sha256_hex(per_gpu[i])})
    return failures, not_checked, gpus, min(expires) if expires else None


def _valid_record(v: Any) -> bool:
    if not isinstance(v, dict) or not all(isinstance(v.get(k), dict) for k in ("nonce_input", "verifier", "local", "tokens", "signature")) or not isinstance(v["tokens"].get("gpus"), dict):
        return False
    local = v["local"]
    return (
        isinstance(v.get("seq"), int) and not isinstance(v["seq"], bool)
        and isinstance(v.get("verified_at"), str)
        and _is_hex(v.get("nonce"), 32)
        and isinstance(v["nonce_input"].get("issued_at"), str)
        and _is_hex(v["nonce_input"].get("salt"))
        and isinstance(v.get("arch"), str)
        and v["verifier"].get("kind") == "nras"
        and isinstance(v["verifier"].get("issuer"), str)
        and all(isinstance(local.get(k), str) for k in ("source", "cc_state", "devtools_mode"))
        and (local.get("multi_gpu_mode") is None or isinstance(local["multi_gpu_mode"], str))
        and isinstance(local.get("uuids"), list)
        and isinstance(v["tokens"].get("overall"), str)
        and all(isinstance(t, str) for t in v["tokens"]["gpus"].values())
        and isinstance(v["signature"].get("sig"), str)
    )


def _receipt_key_signed(record: dict[str, Any], summary: dict[str, Any], receipt_pubkey: str) -> bool:
    try:
        if record["signature"].get("alg") != "Ed25519" or not _is_hex(receipt_pubkey, 32):
            return False
        Ed25519PublicKey.from_public_bytes(bytes.fromhex(receipt_pubkey)).verify(_b64(record["signature"]["sig"]), f"{GPU_EVIDENCE_DOMAIN}\n{canonical_json(summary)}".encode())
        return True
    except (InvalidSignature, ValueError):
        return False


def verify_gpu_evidence(
    document: Any, *, jwks: list[dict[str, Any]], issuer: str = NRAS_DEFAULT_URL, allowed_models: list[str] | None = None,
    min_driver_version: str | None = None, min_vbios_version: str | None = None, now_ms: float | None = None, clock_skew_seconds: float = 60,
) -> GpuVerification:
    """Re-check the GPU evidence in an attestation document. ``jwks`` are the signing keys of the NRAS you trust
    (``fetch_nras_jwks``). The caller must already have verified that the quote commits to ``document["bindings"]``."""
    doc = document if isinstance(document, dict) else {}
    bindings = doc.get("bindings") if isinstance(doc.get("bindings"), dict) else {}
    bound = bindings["gpu_evidence_sha256"].lower() if isinstance(bindings.get("gpu_evidence_sha256"), str) else None
    failures: list[tuple[str, str]] = []
    not_checked = list(GPU_EVIDENCE_LIMITS)

    if doc.get("gpu") is None:
        if not bound:
            return GpuVerification("absent", not_checked=["The document carries no GPU evidence: only the CPU side is attested."])
        return GpuVerification("failed", [("evidence_missing", "the bindings commit to GPU evidence that the document does not publish")], not_checked)
    gpu = doc["gpu"] if isinstance(doc["gpu"], dict) else {}
    boot, refresh = gpu.get("boot"), gpu.get("refresh")
    if not _valid_record(boot) or (refresh is not None and not _valid_record(refresh)):
        return GpuVerification("failed", [("evidence_malformed", "the gpu member is not a GPU evidence document this verifier understands")], not_checked)
    latest = refresh or boot
    issuer = _issuer(issuer)

    # 1. The quote commits to the boot record.
    boot_summary = gpu_summary(boot)
    boot_hash = _sha256_hex(canonical_json(boot_summary))
    if not bound:
        failures.append(("evidence_unbound", "the bindings carry no gpu_evidence_sha256, so the quote does not commit to this GPU evidence"))
    elif bound != boot_hash:
        failures.append(("evidence_unbound", "bindings.gpu_evidence_sha256 is not the hash of the published boot record"))
    if boot["seq"] != 0:
        failures.append(("evidence_malformed", "the boot record is not sequence 0"))

    # 2 and 3. Each record was made for these keys, and a refresh is signed by the bound receipt key.
    for label, rec in (("boot", boot), ("refresh", refresh)):
        if rec is None:
            continue
        if derive_gpu_nonce(bindings, rec["nonce_input"]) != rec["nonce"]:
            failures.append(("nonce_derivation_mismatch", f"{label}: the nonce is not derived from the keys in the bindings"))
        if _issuer(rec["verifier"]["issuer"]) != issuer:
            failures.append(("issuer_mismatch", f"{label}: verified by {rec['verifier']['issuer']}, but this verifier trusts {issuer}"))
        if rec is not boot:
            if rec["seq"] <= 0:
                failures.append(("evidence_malformed", "the refresh record has no positive sequence number"))
            if not _receipt_key_signed(rec, gpu_summary(rec), str(bindings.get("receipt_pubkey") or "")):
                failures.append(("refresh_signature_invalid", "the refresh record is not signed by the receipt key the quote commits to"))

    # 4. The tokens: the newest in full, the boot ones (once refreshed) in everything but their expiry.
    now = now_ms if now_ms is not None else time.time() * 1000
    policy = {"allowed_models": allowed_models, "min_driver_version": min_driver_version, "min_vbios_version": min_vbios_version, "clock_skew_seconds": clock_skew_seconds}
    f, n, verified, expires = verify_nras_tokens(latest["tokens"], nonce=latest["nonce"], issuer=issuer, jwks=jwks, now_ms=now, **policy)
    failures += f
    not_checked += [x for x in n if x not in not_checked]
    if refresh is not None:
        then = verify_nras_tokens(boot["tokens"], nonce=boot["nonce"], issuer=issuer, jwks=jwks, now_ms=None, **policy)[0]
        if then and all(code == "unknown_signing_key" for code, _ in then):
            not_checked.append("The boot tokens are signed by an NRAS key that is no longer published; their signatures were not re-checked (the refresh tokens were).")
        else:
            failures += [(code, f"boot: {message}") for code, message in then]

    # 5. Driver state recorded by the sidecar.
    local = latest["local"]
    if local["cc_state"] != "on":
        failures.append(("cc_state_not_on", f'the driver reported confidential-computing state "{local["cc_state"]}"'))
    if local["devtools_mode"] == "on":
        failures.append(("devtools_mode_on", "the driver reported DevTools mode on"))
    elif local["devtools_mode"] != "off":
        not_checked.append("DevTools mode could not be read from the driver.")

    uuids = local["uuids"]
    described = [{**g, "index": i, "uuid": uuids[i] if i < len(uuids) else None, "cc_state": local["cc_state"]} for i, g in enumerate(verified)]
    return GpuVerification(
        "failed" if failures else "verified",
        failures,
        not_checked,
        described,
        verified_at=latest["verified_at"],
        expires_at=None if expires is None else _iso(expires),
        nonce=latest["nonce"],
        evidence_sha256=bound if bound is not None and bound == boot_hash else None,
    )
