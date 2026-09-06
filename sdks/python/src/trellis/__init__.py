"""The official Python SDK for Trellis, an OpenRouter compatible AI router with signed receipts and privacy lanes.

    from trellis import Trellis

    client = Trellis()  # reads TRELLIS_API_KEY
    reply = client.chat.completions.create(model="meta-llama/llama-3.3-70b-instruct",messages=[{"role": "user", "content": "Hi"}])
    print(reply.content, reply.trellis.receipt_id)
"""

from __future__ import annotations

from . import receipts, solana
from ._async_client import AsyncTrellis
from ._base import DEFAULT_BASE_URL
from ._client import Trellis
from ._streaming import AsyncChatStream, ChatStream
from ._version import __version__
from .errors import (
    TrellisError,
    APIConnectionError,
    APIError,
    APITimeoutError,
    AuthenticationError,
    BadRequestError,
    CreditsClosingError,
    NotFoundError,
    PaymentNotBoundError,
    RateLimitError,
    ReceiptInvalid,
)
from .lanes import DISCLOSURE_HEADER, DISCLOSURES, LANE_HEADER, LANES, merge_provider, stricter_disclosure, stricter_lane
from .receipts import (
    ChainCheck,
    ChainedEvent,
    Check,
    ReceiptVerification,
    VerificationResult,
    check_chain,
    chunk_chain,
    decode_receipt_v2,
    verify_merkle_proof,
    verify_receipt,
    verify_receipt_v1,
    verify_receipt_v2,
)
from .types import TrellisMeta, APIResponse, Batch, BatchResults, ChatCompletion, DataList, Embeddings, Model, Rerank

__all__ = [
    "__version__",
    "Trellis",
    "AsyncTrellis",
    "ChatStream",
    "AsyncChatStream",
    "DEFAULT_BASE_URL",
    "LANES",
    "DISCLOSURES",
    "LANE_HEADER",
    "DISCLOSURE_HEADER",
    "merge_provider",
    "stricter_lane",
    "stricter_disclosure",
    "TrellisError",
    "APIError",
    "APIConnectionError",
    "APITimeoutError",
    "AuthenticationError",
    "BadRequestError",
    "NotFoundError",
    "RateLimitError",
    "CreditsClosingError",
    "PaymentNotBoundError",
    "ReceiptInvalid",
    "receipts",
    "solana",
    "Check",
    "ChainCheck",
    "ChainedEvent",
    "ReceiptVerification",
    "VerificationResult",
    "check_chain",
    "chunk_chain",
    "decode_receipt_v2",
    "verify_merkle_proof",
    "verify_receipt",
    "verify_receipt_v1",
    "verify_receipt_v2",
    "TrellisMeta",
    "APIResponse",
    "Batch",
    "BatchResults",
    "ChatCompletion",
    "DataList",
    "Embeddings",
    "Model",
    "Rerank",
]
