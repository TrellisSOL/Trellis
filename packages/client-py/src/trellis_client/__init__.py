"""Trellis client: receipt verification and verify-before-send for attested providers."""

from .attestation import ATTEST_SAN_SUFFIX, attest_san_for, digest_hex, evaluate_attestation, fetch_router_attestation, verify_provider
from .canonical import canonical_bytes, canonical_json
from .gpu import GPU_EVIDENCE_LIMITS, NRAS_DEFAULT_URL, GpuVerification, fetch_nras_jwks, verify_gpu_evidence
from .agent import AgentPolicy, AgentLane, AgentRouteDefault, AgentIntent, AgentReason, AgentDecision, AgentRemaining, AgentRulebook, AgentReplay, AgentReplayExample, AgentPayInput, AgentPayDecision, AgentPayment
from .agent_errors import AgentPolicyDenied, AgentKilled, AgentApprovalRequired
from .playbooks import Playbook, PlaybookChange
from . import solana
from .client import Trellis
from .decision_tag import DECISION_TAG_HEADER, check_decision_tag, decision_tag, receipt_decision_tag, with_decision_tag
from .errors import TrellisError, AttestationRefused, CreditsClosing, PaymentNotBound, ReceiptInvalid
from .receipts import RECEIPT_KEYS_PATH, fetch_receipt_keys, key_id_of, parse_key_set, receipt_leaf, sha256d, verify_merkle_proof, verify_receipt, verify_sidecar_receipt
from .tdx import TdxFields, parse_tdx_quote
from .types import BoundIdentity, Check, ExpectedDigests, ProviderVerification, ReceiptVerification

__all__ = [
    "AgentPolicy", "AgentLane", "AgentRouteDefault", "AgentIntent", "AgentReason", "AgentDecision", "AgentRemaining", "AgentRulebook", "AgentReplay", "AgentReplayExample",
    "AgentPayInput", "AgentPayDecision", "AgentPayment",
    "AgentPolicyDenied", "AgentKilled", "AgentApprovalRequired",
    "Playbook", "PlaybookChange",
    "ATTEST_SAN_SUFFIX",
    "Trellis",
    "solana",
    "TrellisError",
    "AttestationRefused",
    "CreditsClosing",
    "PaymentNotBound",
    "BoundIdentity",
    "Check",
    "DECISION_TAG_HEADER",
    "ExpectedDigests",
    "ProviderVerification",
    "RECEIPT_KEYS_PATH",
    "ReceiptInvalid",
    "ReceiptVerification",
    "TdxFields",
    "attest_san_for",
    "canonical_bytes",
    "canonical_json",
    "check_decision_tag",
    "decision_tag",
    "digest_hex",
    "evaluate_attestation",
    "GPU_EVIDENCE_LIMITS",
    "NRAS_DEFAULT_URL",
    "GpuVerification",
    "fetch_nras_jwks",
    "verify_gpu_evidence",
    "fetch_receipt_keys",
    "fetch_router_attestation",
    "key_id_of",
    "parse_key_set",
    "parse_tdx_quote",
    "receipt_decision_tag",
    "receipt_leaf",
    "sha256d",
    "verify_merkle_proof",
    "verify_provider",
    "verify_receipt",
    "verify_sidecar_receipt",
    "with_decision_tag",
]
__version__ = "0.1.0"
