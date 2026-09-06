"""The asynchronous client. It mirrors _client.py method for method; every I/O call is awaited."""

from __future__ import annotations

import asyncio
import time
from typing import Any, Mapping, Optional, Sequence, Union

import httpx

from . import _base
from ._base import BaseClient, KeyCache, drop_none, seg
from ._streaming import AsyncChatStream
from .errors import NotFoundError, error_from_response
from .receipts import Keys, ReceiptVerification, verify_receipt
from .types import TrellisMeta, Batch, BatchResults, ChatCompletion, DataList, Embeddings, Model, Rerank, APIResponse

__all__ = ["AsyncTrellis"]


class AsyncTrellis(BaseClient):
    """The Trellis client (asynchronous, on ``httpx.AsyncClient``).

    ``api_key`` defaults to ``$TRELLIS_API_KEY`` and ``base_url`` to ``$TRELLIS_BASE_URL`` or the public router.
    ``lane`` / ``disclosure`` apply to every request (a per-call value can only make them stricter).
    Pass ``http_client`` to reuse your own ``httpx.AsyncClient`` (proxies, transports, test doubles).
    """

    def __init__(
        self,
        api_key: Optional[str] = None,
        *,
        base_url: Optional[str] = None,
        lane: Optional[str] = None,
        disclosure: Optional[str] = None,
        timeout: Union[float, httpx.Timeout, None] = None,
        http_client: Optional[httpx.AsyncClient] = None,
        default_headers: Optional[Mapping[str, str]] = None,
    ) -> None:
        super().__init__(api_key=api_key, base_url=base_url, lane=lane, disclosure=disclosure, timeout=timeout, default_headers=default_headers)
        self._owns_http = http_client is None
        self._http = http_client or httpx.AsyncClient(timeout=timeout if timeout is not None else _base.DEFAULT_TIMEOUT)
        self.chat = Chat(self)
        self.embeddings = EmbeddingsResource(self)
        self.rerank = RerankResource(self)
        self.batches = Batches(self)
        self.presets = Presets(self)
        self.models = Models(self)
        self.receipts = Receipts(self)
        self.credits = Credits(self)
        self.holders = Holders(self)

    # ---- lifecycle -------------------------------------------------------------------------------------------------

    async def close(self) -> None:
        if self._owns_http:
            await self._http.aclose()

    aclose = close

    async def __aenter__(self) -> "AsyncTrellis":
        return self

    async def __aexit__(self, *exc: Any) -> None:
        await self.close()

    def copy(self, **overrides: Any) -> "AsyncTrellis":
        """A new client with some settings changed. It shares this client's connection pool and key cache."""
        opts = dict(api_key=self.api_key, base_url=self.base_url, lane=self.lane, disclosure=self.disclosure, timeout=self.timeout, default_headers=self.default_headers)
        opts.update(overrides)
        clone = AsyncTrellis(http_client=self._http, **opts)
        clone._keys = self._keys if opts["base_url"] == self.base_url else KeyCache()
        return clone

    def with_lane(self, lane: Optional[str], disclosure: Optional[str] = None) -> "AsyncTrellis":
        """A copy of this client that sends every request on ``lane`` (and, if given, under ``disclosure``)."""
        return self.copy(lane=lane, disclosure=disclosure if disclosure is not None else self.disclosure)

    # ---- wallets ---------------------------------------------------------------------------------------------------

    @staticmethod
    def wallet_auth_header(signer: Any, method: str, url: Any, body: Any = None, *, host: Optional[str] = None, timestamp: Optional[int] = None) -> str:
        """The ``X-Wallet-Auth`` value for one request (its method, its full URL and the JSON body it sends), signed
        by the wallet ``signer``: it lets a wallet spend its per-call change without an API key. ``host`` is the
        router's public host[:port] when it differs from the URL's. To sign a request this client built, use
        ``trellis.solana.with_wallet_auth(client.request(...), signer)``. See ``trellis.solana.wallet_auth_header``."""
        from .solana import wallet_auth_header

        return wallet_auth_header(signer, method, url, body, host=host, timestamp=timestamp)

    async def wallet_sign_in(self, signer: Any, *, name: Optional[str] = None, expected_domain: Optional[str] = None) -> APIResponse:
        """Sign in with a wallet: fetch a challenge (``POST /api/v1/auth/wallet/challenge``), check it, sign its
        ``message`` exactly as returned and post it (``POST /api/v1/auth/wallet``). The answer holds the new API key
        in ``key`` (shown once) and its record in ``data``.

        Nothing is signed unless the challenge is this router's own: its ``domain`` must be the host[:port] of this
        client's ``base_url`` (or ``expected_domain``, the router's public host, when you reach it under another
        name), and the message must name that domain and the signer's own address. Otherwise
        ``trellis.solana.SolanaError`` is raised and nothing is posted. This client's API key is not sent."""
        from .solana import as_signer, wallet_sign_in_body

        wallet = as_signer(signer)
        challenge = _base.unwrap(await self._send(self._keyless("POST", "/auth/wallet/challenge", {"address": wallet.address})))
        body = wallet_sign_in_body(wallet, challenge, expected_domain or self.base_url, name=name)
        return _base.sign_in_response(await self._send(self._keyless("POST", "/auth/wallet", body)))

    def _keyless(self, method: str, path: str, json_body: Any) -> httpx.Request:
        request = self._build(self._http, method, path, json_body=json_body)
        request.headers.pop("authorization", None)
        return request

    def request(self, method: str, path: str, *, json_body: Any = None, params: Optional[Mapping[str, Any]] = None, extra_headers: Optional[Mapping[str, str]] = None, root: bool = False) -> httpx.Request:
        """An unsent ``httpx.Request`` with this client's headers (``path`` under ``/api/v1`` unless ``root``), for
        ``trellis.solana.async_pay_per_call`` and other hand-driven sends."""
        return self._build(self._http, method, path, json_body=json_body, params=params, extra_headers=extra_headers, root=root)

    async def send(self, request: httpx.Request) -> httpx.Response:
        """Send a request built with ``request()`` (signed with ``trellis.solana.with_wallet_auth`` or
        ``with_payment_signature`` when a wallet is acting) and return the response as it came. An HTTP error raises
        the same classes as every other call; nothing is retried."""
        return await self._send(request)

    # ---- transport -------------------------------------------------------------------------------------------------

    async def _send(self, request: httpx.Request, *, stream: bool = False) -> httpx.Response:
        try:
            response = await self._http.send(request, stream=stream)
        except httpx.TransportError as e:
            raise _base.wrap_transport_error(e) from e
        if response.status_code >= 400:
            if stream:
                try:
                    await response.aread()
                finally:
                    await response.aclose()
            raise error_from_response(response)
        return response

    async def _request(self, method: str, path: str, **kwargs: Any) -> httpx.Response:
        return await self._send(self._build(self._http, method, path, **kwargs))

    async def _stream(self, method: str, path: str, **kwargs: Any) -> httpx.Response:
        return await self._send(self._build(self._http, method, path, accept="text/event-stream", **kwargs), stream=True)


class _Resource:
    def __init__(self, client: AsyncTrellis) -> None:
        self._client = client


class Completions(_Resource):
    async def create(
        self,
        *,
        model: Optional[str] = None,
        messages: Sequence[Mapping[str, Any]],
        stream: bool = False,
        provider: Optional[Mapping[str, Any]] = None,
        lane: Optional[str] = None,
        disclosure: Optional[str] = None,
        extra_headers: Optional[Mapping[str, str]] = None,
        extra_body: Optional[Mapping[str, Any]] = None,
        timeout: Union[float, httpx.Timeout, None] = None,
        **params: Any,
    ) -> Union[ChatCompletion, AsyncChatStream]:
        """``POST /api/v1/chat/completions``. Any OpenAI parameter goes through as a keyword (temperature, tools, ...).
        With ``stream=True`` this returns a ``AsyncChatStream`` (same as ``stream()``)."""
        if stream:
            return await self.stream(model=model, messages=messages, provider=provider, lane=lane, disclosure=disclosure, extra_headers=extra_headers, extra_body=extra_body, timeout=timeout, **params)
        body = _base.chat_body(model, messages, provider, params, extra_body)
        r = await self._client._request("POST", "/chat/completions", json_body=body, lane=lane, disclosure=disclosure, merge_body=True, extra_headers=extra_headers, timeout=timeout)
        data = _base.json_body(r)
        return ChatCompletion(data, meta=TrellisMeta.from_response(r.headers, data))

    async def stream(
        self,
        *,
        model: Optional[str] = None,
        messages: Sequence[Mapping[str, Any]],
        provider: Optional[Mapping[str, Any]] = None,
        lane: Optional[str] = None,
        disclosure: Optional[str] = None,
        extra_headers: Optional[Mapping[str, str]] = None,
        extra_body: Optional[Mapping[str, Any]] = None,
        timeout: Union[float, httpx.Timeout, None] = None,
        **params: Any,
    ) -> AsyncChatStream:
        """Stream a chat completion. The request is sent now (HTTP errors raise here); iterate the result for chunks."""
        params.pop("stream", None)
        body = _base.chat_body(model, messages, provider, {**params, "stream": True}, extra_body)
        r = await self._client._stream("POST", "/chat/completions", json_body=body, lane=lane, disclosure=disclosure, merge_body=True, extra_headers=extra_headers, timeout=timeout)
        return AsyncChatStream(r, self._client)


class Chat(_Resource):
    def __init__(self, client: AsyncTrellis) -> None:
        super().__init__(client)
        self.completions = Completions(client)


class EmbeddingsResource(_Resource):
    async def create(
        self,
        *,
        model: str,
        input: Union[str, Sequence[str], Sequence[int], Sequence[Sequence[int]]],
        provider: Optional[Mapping[str, Any]] = None,
        lane: Optional[str] = None,
        disclosure: Optional[str] = None,
        extra_headers: Optional[Mapping[str, str]] = None,
        timeout: Union[float, httpx.Timeout, None] = None,
        **params: Any,
    ) -> Embeddings:
        """``POST /api/v1/embeddings`` (OpenAI shape, plus ``receipt``)."""
        body = drop_none({"model": model, "input": input, "provider": provider, **params})
        r = await self._client._request("POST", "/embeddings", json_body=body, lane=lane, disclosure=disclosure, merge_body=True, extra_headers=extra_headers, timeout=timeout)
        data = _base.json_body(r)
        return Embeddings(data, meta=TrellisMeta.from_response(r.headers, data))


class RerankResource(_Resource):
    async def create(
        self,
        *,
        model: str,
        query: str,
        documents: Sequence[Union[str, Mapping[str, Any]]],
        top_n: Optional[int] = None,
        return_documents: Optional[bool] = None,
        provider: Optional[Mapping[str, Any]] = None,
        lane: Optional[str] = None,
        disclosure: Optional[str] = None,
        extra_headers: Optional[Mapping[str, str]] = None,
        timeout: Union[float, httpx.Timeout, None] = None,
        **params: Any,
    ) -> Rerank:
        """``POST /api/v1/rerank``: score ``documents`` against ``query``; ``results`` come sorted by relevance."""
        body = drop_none({"model": model, "query": query, "documents": list(documents), "top_n": top_n, "return_documents": return_documents, "provider": provider, **params})
        r = await self._client._request("POST", "/rerank", json_body=body, lane=lane, disclosure=disclosure, merge_body=True, extra_headers=extra_headers, timeout=timeout)
        data = _base.json_body(r)
        return Rerank(data, meta=TrellisMeta.from_response(r.headers, data))


class Batches(_Resource):
    """OpenAI compatible batches at half price. Requests go inline (there is no files endpoint)."""

    async def create(
        self,
        requests: Optional[Sequence[Mapping[str, Any]]] = None,
        *,
        input_jsonl: Optional[str] = None,
        endpoint: Optional[str] = None,
        completion_window: Optional[str] = None,
        metadata: Optional[Mapping[str, Any]] = None,
        lane: Optional[str] = None,
        disclosure: Optional[str] = None,
        extra_headers: Optional[Mapping[str, str]] = None,
    ) -> Batch:
        """Each request is ``{custom_id, body}`` (``method`` defaults to POST, ``url`` to ``endpoint`` or
        ``/v1/chat/completions``). A lane or disclosure is merged into every body's ``provider``."""
        from .lanes import check_disclosure, check_lane, stricter_disclosure, stricter_lane

        eff_lane = stricter_lane(self._client.lane, check_lane(lane))
        eff_disc = stricter_disclosure(self._client.disclosure, check_disclosure(disclosure))
        body = _base.batch_body(requests, input_jsonl, endpoint, completion_window, metadata, eff_lane, eff_disc)
        r = await self._client._request("POST", "/batches", json_body=body, lane=lane, disclosure=disclosure, extra_headers=extra_headers)
        return _base.unwrap(r, Batch)

    async def retrieve(self, batch_id: str) -> Batch:
        return _base.unwrap(await self._client._request("GET", f"/batches/{seg(batch_id)}"), Batch)

    async def list(self, *, limit: Optional[int] = None, after: Optional[str] = None) -> DataList:
        """One page: a list of batches with ``has_more``, ``first_id`` and ``last_id`` attributes."""
        return _base.unwrap(await self._client._request("GET", "/batches", params={"limit": limit, "after": after}), Batch)

    async def cancel(self, batch_id: str) -> Batch:
        return _base.unwrap(await self._client._request("POST", f"/batches/{seg(batch_id)}/cancel"), Batch)

    async def output(self, batch_id: str) -> list[dict[str, Any]]:
        """The answers as parsed JSONL lines."""
        r = await self._client._request("GET", f"/batches/{seg(batch_id)}/output", accept="application/x-ndjson, application/jsonl, */*")
        return _base.parse_jsonl(r.text)

    async def errors(self, batch_id: str) -> list[dict[str, Any]]:
        """The failed requests as parsed JSONL lines."""
        r = await self._client._request("GET", f"/batches/{seg(batch_id)}/errors", accept="application/x-ndjson, application/jsonl, */*")
        return _base.parse_jsonl(r.text)

    async def wait(self, batch_id: str, *, poll_interval: float = 5.0, timeout: Optional[float] = None) -> Batch:
        """Poll until the batch is completed, failed, expired or cancelled. Raises ``TimeoutError`` after ``timeout``
        seconds (None waits forever)."""
        deadline = None if timeout is None else time.monotonic() + timeout
        while True:
            batch = await self.retrieve(batch_id)
            if batch.is_terminal:
                return batch
            if deadline is not None and time.monotonic() + poll_interval > deadline:
                raise TimeoutError(f"batch {batch_id} is still {batch.get('status')} after {timeout}s")
            await asyncio.sleep(poll_interval)

    async def results(self, batch_id: str) -> BatchResults:
        """Both JSONL files of a batch, parsed. A missing errors file counts as no errors."""
        output = await self.output(batch_id)
        try:
            errors = await self.errors(batch_id)
        except NotFoundError:
            errors = []
        return BatchResults(batch_id, output, errors)


class Presets(_Resource):
    """Named, versioned routing configs. Use one as ``model="@preset/<name>"`` (or ``@preset/<name>@<version>``)."""

    async def list(self) -> DataList:
        return _base.unwrap(await self._client._request("GET", "/presets"))

    async def get(self, name: str, *, version: Union[int, str, None] = None) -> APIResponse:
        return _base.unwrap(await self._client._request("GET", f"/presets/{seg(name)}", params={"version": version}))

    async def put(
        self,
        name: str,
        *,
        models: Sequence[str],
        description: Optional[str] = None,
        provider: Optional[Mapping[str, Any]] = None,
        params: Optional[Mapping[str, Any]] = None,
        system_prompt: Optional[str] = None,
        response_format: Optional[Mapping[str, Any]] = None,
        tools: Optional[Sequence[Mapping[str, Any]]] = None,
        tool_choice: Any = None,
        extra: Optional[Mapping[str, Any]] = None,
    ) -> APIResponse:
        """Create or update (a change that alters the config makes a new version; ``changed`` says whether it did)."""
        body = _base.preset_body(models=list(models), description=description, provider=provider, params=params, system_prompt=system_prompt, response_format=response_format, tools=tools, tool_choice=tool_choice, extra=extra)
        return _base.unwrap(await self._client._request("PUT", f"/presets/{seg(name)}", json_body=body))

    upsert = put

    async def delete(self, name: str) -> APIResponse:
        return _base.unwrap(await self._client._request("DELETE", f"/presets/{seg(name)}"))

    async def versions(self, name: str) -> DataList:
        return _base.unwrap(await self._client._request("GET", f"/presets/{seg(name)}/versions"))

    async def diff(self, name: str, *, from_: Union[int, str, None] = None, to: Union[int, str, None] = None) -> APIResponse:
        return _base.unwrap(await self._client._request("GET", f"/presets/{seg(name)}/diff", params={"from": from_, "to": to}))

    async def rollback(self, name: str, version: Union[int, str]) -> APIResponse:
        return _base.unwrap(await self._client._request("POST", f"/presets/{seg(name)}/rollback", json_body={"version": version}))


class Models(_Resource):
    async def list(self, *, lane: Optional[str] = None, output_modalities: Union[str, Sequence[str], None] = None) -> DataList:
        """Every model, or only those that can serve ``lane`` (checked with ``Model.supports_lane``)."""
        r = await self._client._request("GET", "/models", params={"output_modalities": _base.modalities_param(output_modalities)})
        return _base.filter_models(_base.unwrap(r, Model), lane)

    async def retrieve(self, model_id: str) -> Model:
        for m in await self.list():
            if m.get("id") == model_id:
                return m
        raise NotFoundError(f"model {model_id} is not listed", status=404, type="model_not_found")


class Receipts(_Resource):
    async def get(self, receipt_id: str) -> APIResponse:
        """``GET /api/v1/receipts/{id}``: the stored receipt (v1 fields and, for newer ones, ``v2``)."""
        return _base.unwrap(await self._client._request("GET", f"/receipts/{seg(receipt_id)}"))

    async def proof(self, receipt_id: str) -> APIResponse:
        """``GET /api/v1/receipts/{id}/proof``: the Merkle inclusion proof once the hourly root is built."""
        return _base.unwrap(await self._client._request("GET", f"/receipts/{seg(receipt_id)}/proof"))

    async def keys(self, *, refresh: bool = False) -> list[dict[str, Any]]:
        """The router's published Ed25519 receipt keys (cached for an hour)."""
        cache = self._client._keys
        if not refresh and (keys := cache.fresh()) is not None:
            return keys
        r = await self._client._request("GET", _base.RECEIPT_KEYS_PATH, root=True)
        return cache.store(_base.json_body(r))

    async def verify(
        self,
        receipt: Union[Mapping[str, Any], bytes, str],
        *,
        keys: Keys = None,
        public_key_hex: Optional[str] = None,
        chunks: Optional[Sequence[str]] = None,
        proof: Optional[Mapping[str, Any]] = None,
        request_sha256: Optional[str] = None,
        response_sha256: Optional[str] = None,
        raise_on_invalid: bool = False,
    ) -> ReceiptVerification:
        """Verify v1 and/or v2 (whatever the receipt carries) against the published keys, fetched and cached.
        If the receipt names a key the cache lacks, the keys are fetched again once."""
        if keys is None and public_key_hex is None:
            keys = await self.keys()
            wanted = _base.receipt_key_ids(receipt)
            if wanted - {k.get("kid") for k in keys}:
                keys = await self.keys(refresh=True)
        result = verify_receipt(receipt, keys, public_key_hex=public_key_hex, chunks=chunks, proof=proof, request_sha256=request_sha256, response_sha256=response_sha256)
        return result.raise_if_invalid() if raise_on_invalid else result

    async def verify_id(self, receipt_id: str, *, with_proof: bool = True, raise_on_invalid: bool = False) -> ReceiptVerification:
        """Fetch a stored receipt (and its inclusion proof, when there is one) and verify both."""
        receipt = await self.get(receipt_id)
        proof = None
        if with_proof:
            try:
                proof = await self.proof(receipt_id)
            except NotFoundError:
                proof = None
        return await self.verify(receipt, proof=proof, raise_on_invalid=raise_on_invalid)


class Credits(_Resource):
    """Prepaid USDC credits on Solana. The router builds every transaction; a wallet signs and sends it.

    A deposit is signed by the wallet that pays. A closure, and taking one back, is asked with the API key and arrives
    signed by it; a wallet only pays the fee. A closure names no destination: what is left returns to the wallets that
    deposited to the key, each at most what it put in, to the token account that wallet named on chain (by default
    the one it paid from). The API key cannot choose or change that. Only a depositor can move its own refund
    destination, with its own wallet (``refund_destination_tx``)."""

    async def deposit_tx(self, amount: Any, payer: Any) -> APIResponse:
        """``POST /api/v1/credits/deposit-tx``: an unsigned deposit transaction (``transaction`` base64, fee payer =
        ``payer``) for ``amount`` USDC (a decimal string; an ``int`` is base units). Sign and send it with the wallet
        (``trellis.solana.sign_transaction(deposit["transaction"], wallet)``); the key is credited once it is
        finalized. Fields: ``transaction``, ``message``, ``network``, ``amount_usdc``, ``amount_units``, ``accounts``
        (``credit``, ``vault``, ``depositorToken``, ``share``: the on-chain record of what this wallet put into the
        key), ``refund_to`` (the token account a closure refund of this deposit returns to: the one it is paid from),
        ``expires_at_block_height``, ``key_hash``, ``note``."""
        from .solana import deposit_tx_body

        return _base.unwrap(await self._client._request("POST", "/credits/deposit-tx", json_body=deposit_tx_body(amount, payer)))

    async def close(self, *args: Any, payer: Any = None, **kwargs: Any) -> APIResponse:
        """``close(*, payer)``: ``POST /api/v1/credits/close`` with ``{"payer": ...}``: queue the closure of this
        key's credits. It must be asked with the key itself. ``payer`` is any wallet: it pays the transaction fee.

        A closure names no destination. The refund returns to the wallets that deposited to the key (``refunds``: one
        row per depositor with ``depositor``, ``refund_to``, ``deposited_units``, ``refunded_units``), after the
        dispute window, and the API key cannot choose or change where it goes. ``refund_to`` is never sent; a
        positional argument (the old ``refund_to`` position), a ``refund_to=`` keyword or a missing ``payer`` raises
        ``trellis.solana.SolanaError`` (a ``ValueError``) and nothing is sent.

        ``transaction`` (base64) is one ``close_account`` instruction that already carries the signature of the key's
        own keypair: the ``payer`` wallet adds its signature as fee payer
        (``trellis.solana.sign_transaction(closure["transaction"], wallet)``, which keeps the key's signature byte for
        byte) and sends it before ``expires_at_block_height``. ``transaction`` is None when the closure is already
        registered: there is nothing to sign. Fields: ``id``, ``status``, ``payer``, ``authority``, ``payable_at``,
        ``transaction``, ``message``, ``accounts`` (``refundRequest``), ``expires_at_block_height``,
        ``signed_by_key``, ``refunds``, ``note``. Once the closure is on chain the key is frozen: calls that would
        spend raise ``CreditsClosingError`` (409 ``credits_closing``); do not retry them. Until anything is paid the
        closure can be taken back with ``cancel_close``."""
        from .solana import close_credits_body

        return _base.unwrap(await self._client._request("POST", "/credits/close", json_body=close_credits_body(*args, payer=payer, **kwargs)))

    async def cancel_close(self, *, payer: Any) -> APIResponse:
        """``POST /api/v1/credits/close/cancel`` with ``{"payer": ...}``: take a closure back while nothing has been
        paid. Asked with the key itself. ``transaction`` is one ``cancel_close`` instruction already signed by the
        key; the ``payer`` wallet finishes it exactly like the closure
        (``trellis.solana.sign_transaction(cancel["transaction"], wallet)``: the payer's signature is added, the
        key's stays byte for byte) and sends it before ``expires_at_block_height``. Once it lands the key is open
        again with its balance. Fields: ``transaction``, ``message``, ``accounts``, ``payer``,
        ``expires_at_block_height``, ``signed_by_key``, ``note``. Refusals: 400 ``nothing_to_cancel`` (no closure on
        chain), 409 ``refund_in_progress`` (part of the refund has already been paid)."""
        from .solana import cancel_close_body

        return _base.unwrap(await self._client._request("POST", "/credits/close/cancel", json_body=cancel_close_body(payer=payer)))

    async def release_close(self, key: str) -> DataList:
        """``POST /api/v1/credits/close/release`` with ``{"key": ...}``: let a closure that is on hold go ahead. For
        an owner or admin of the account. Disabling a key (``DELETE /api/v1/keys/{hash}``) puts the closure it
        started on hold (the answer carries ``closure_held``; the closure row shows ``reason: "key_disabled"``), so
        revoking a leaked key stops a closure it began. Releasing changes nothing about where the money goes: it
        still returns only to the wallets that paid in.

        ``key`` is the key's hash (64 hex characters, as ``GET /api/v1/keys`` lists it), not the API key. Anything
        else raises ``trellis.solana.SolanaError`` before a request is made, so a secret is never posted as a hash.
        Returns the released closures: ``id``, ``status``, ``released``, ``payable_at``. 404 ``not_found`` when the
        key has no open closure."""
        from .solana import release_close_body

        return _base.unwrap(await self._client._request("POST", "/credits/close/release", json_body=release_close_body(key)))

    async def refund_destination_tx(self, depositor: Any, refund_to: Any) -> APIResponse:
        """``POST /api/v1/credits/refund-destination-tx`` with ``{"depositor": ..., "refund_to": ...}``: an UNSIGNED
        ``set_refund_destination`` transaction that moves where ``depositor``'s share of a closure refund of this key
        goes, to the USDC token account of the wallet ``refund_to``. Only the depositor's own wallet can sign it: it
        is the fee payer and the only signer (``trellis.solana.sign_transaction(change["transaction"],
        depositor_wallet)``; any other wallet is refused there). The API key signs nothing and is not in the
        transaction. It moves nothing now. Fields: ``transaction``, ``message``, ``accounts`` (``share``,
        ``refundToToken``), ``depositor``, ``refund_to``, ``current_refund_to``, ``expires_at_block_height``,
        ``note``. 404 ``not_found`` when that wallet never deposited to this key."""
        from .solana import refund_destination_tx_body

        return _base.unwrap(await self._client._request("POST", "/credits/refund-destination-tx", json_body=refund_destination_tx_body(depositor, refund_to)))

    async def closures(self) -> DataList:
        """``GET /api/v1/credits/close``: this key's closure requests, newest first. Each row: ``id``, ``status``
        (``trellis.solana.CLOSURE_STATUSES``: queued, registered, paid, refused, failed, cancelled), ``reason``
        (``CLOSURE_REASONS``; a queued or registered row with a reason is waiting, not failed, and ``key_disabled``
        is on hold until ``release_close``), ``refund_to`` (the wallets paid so far, comma-separated, or None),
        ``refunds`` (the payment plan, one row per depositor: ``depositor``, ``refund_to``, ``owner``,
        ``amount_units``, ``status`` (``REFUND_STATUSES``: planned, paid, refused), ``reason``, ``tx``),
        ``amount_units``, ``requested_at``, ``payable_at``, ``paid_at``, ``register_tx``, ``pay_tx``, ``cancel_tx``,
        ``released_at``."""
        return _base.unwrap(await self._client._request("GET", "/credits/close"))


class Holders(_Resource):
    """$TRLS holder tiers: membership levels with fixed thresholds. Their perks are access and priority (higher limits,
    sealed-lane priority, early access to newly listed models, an advisory vote, credits that do not expire while the
    tier is held, an opt-in profile badge). No tier changes a price. This is what the router returns today; it can change."""

    async def tiers(self) -> APIResponse:
        """``GET /api/v1/holders/tiers``: the tier table (``enabled``, ``token``, ``cache_s``, ``tiers``). When
        ``enabled`` is false, holder tiers are not switched on yet and ``tiers`` is empty."""
        return _base.unwrap(await self._client._request("GET", "/holders/tiers"))

    async def me(self) -> APIResponse:
        """``GET /api/v1/holders/me``: the tier of the wallet behind this key, the next threshold (``next_tier``) and
        the perks that apply now. A key with no wallet gets ``wallet: None`` and a ``hint``."""
        return _base.unwrap(await self._client._request("GET", "/holders/me"))

    async def polls(self, *, status: Optional[str] = None) -> DataList:
        """``GET /api/v1/holders/polls``: advisory polls with their tallies, newest first. ``status`` is ``"open"`` or
        ``"closed"``. A result informs a decision and never carries it out."""
        return _base.unwrap(await self._client._request("GET", "/holders/polls", params={"status": status}))

    async def poll(self, poll_id: str) -> APIResponse:
        """``GET /api/v1/holders/polls/{id}``: one poll and its tally."""
        return _base.unwrap(await self._client._request("GET", f"/holders/polls/{seg(poll_id)}"))

    async def vote(self, poll_id: str, option: str, signer: Any, *, timestamp: Optional[int] = None, host: Optional[str] = None) -> APIResponse:
        """``POST /api/v1/holders/polls/{id}/vote``: one advisory vote per wallet, signed by ``signer`` (the wallet that
        holds the tier) with ``X-Wallet-Auth`` over this request: its method, its path, the router's host and the
        canonical JSON of the body. ``host`` is the router's public host[:port] when it differs from this client's
        ``base_url``. The API key is not sent. Refusals keep the router's reason: ``not_a_holder`` (403),
        ``already_voted`` and ``poll_closed`` (409). A vote cannot be changed."""
        from .solana import with_wallet_auth

        request = self._client.request("POST", f"/holders/polls/{seg(poll_id)}/vote", json_body=_base.holder_vote_body(poll_id, option))
        request.headers.pop("authorization", None)
        return _base.unwrap(await self._client._send(with_wallet_auth(request, signer, host=host, timestamp=timestamp)))
