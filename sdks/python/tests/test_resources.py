from __future__ import annotations

import json

import pytest

from trellis import Trellis, BadRequestError, Batch, BatchResults, Embeddings, Model, NotFoundError, Rerank

from .conftest import FakeRouter

MSG = [{"role": "user", "content": "hi"}]


def test_embeddings(client: Trellis, router: FakeRouter) -> None:
    out = client.embeddings.create(model="example/embed", input=["a", "b"], dimensions=3)
    assert isinstance(out, Embeddings)
    assert out.vectors == [[0.1, 0.2, 0.3], [0.2, 0.2, 0.3]]
    assert out.receipt is not None and out.trellis.receipt_id is not None
    assert json.loads(router.last.content) == {"model": "example/embed", "input": ["a", "b"], "dimensions": 3}
    assert client.receipts.verify(out.receipt).valid  # a v1 only receipt


def test_rerank(client: Trellis, router: FakeRouter) -> None:
    out = client.rerank.create(model="example/reranker", query="cat", documents=["a cat", "dog", {"text": "the cat sat"}], top_n=2, return_documents=True)
    assert isinstance(out, Rerank)
    assert len(out.results) == 2
    assert out.results[0]["relevance_score"] >= out.results[1]["relevance_score"]
    assert "document" in out.results[0]
    assert out.usage["search_units"] == 1
    body = json.loads(router.last.content)
    assert router.last.url.path == "/api/v1/rerank"
    assert body["top_n"] == 2 and body["return_documents"] is True and body["documents"][2] == {"text": "the cat sat"}


def test_batches_create_wait_results(client: Trellis, router: FakeRouter) -> None:
    batch = client.batches.create(
        [
            {"custom_id": "q1", "body": {"model": "example/chat", "messages": MSG}},
            {"custom_id": "q2", "body": {"model": "example/chat", "messages": MSG}},
            {"custom_id": "bad-1", "body": {"model": "nope", "messages": MSG}},
        ],
        metadata={"job": "nightly"},
    )
    assert isinstance(batch, Batch) and batch.status == "validating" and not batch.is_terminal
    sent = json.loads(router.last_to("/api/v1/batches").content)
    assert sent["requests"][0] == {"custom_id": "q1", "method": "POST", "url": "/v1/chat/completions", "body": {"model": "example/chat", "messages": MSG}}
    assert sent["metadata"] == {"job": "nightly"}

    done = client.batches.wait(batch.id, poll_interval=0)
    assert done.status == "completed" and done.is_terminal
    assert done.request_counts == {"total": 3, "completed": 2, "failed": 1}

    results = client.batches.results(batch.id)
    assert isinstance(results, BatchResults) and len(results) == 3
    assert [r["custom_id"] for r in results.output] == ["q1", "q2"]
    assert results.errors[0]["error"]["code"] == "model_not_found"
    assert results.bodies()["q2"]["choices"][0]["message"]["content"] == "answer 1"
    assert set(results.by_custom_id()) == {"q1", "q2", "bad-1"}


def test_batches_list_retrieve_cancel_and_timeout(client: Trellis) -> None:
    ids = [client.batches.create([{"custom_id": "x", "body": {"model": "m", "messages": MSG}}]).id for _ in range(3)]
    page = client.batches.list(limit=2)
    assert [b.id for b in page] == [ids[2], ids[1]] and page.has_more is True and page.last_id == ids[1]
    rest = client.batches.list(after=page.last_id)
    assert [b.id for b in rest] == [ids[0]] and rest.has_more is False
    assert client.batches.cancel(ids[0]).status == "cancelled"
    assert client.batches.wait(ids[0], poll_interval=0).status == "cancelled"
    with pytest.raises(TimeoutError):
        client.batches.wait(ids[1], poll_interval=0.01, timeout=0)
    with pytest.raises(NotFoundError):
        client.batches.retrieve("batch_missing")
    with pytest.raises(ValueError):
        client.batches.create()


def test_batches_input_jsonl(client: Trellis, router: FakeRouter) -> None:
    line = json.dumps({"custom_id": "j1", "method": "POST", "url": "/v1/chat/completions", "body": {"model": "m", "messages": MSG}})
    with pytest.raises(BadRequestError):
        client.batches.create(input_jsonl=line)  # the fake router only takes inline requests
    assert json.loads(router.last.content) == {"input_jsonl": line}


def test_presets_crud(client: Trellis) -> None:
    p = client.presets.put("support", models=["example/chat", "example/attested-chat"], description="Support bot", system_prompt="Be brief.", provider={"lane": "attested"})
    assert p.name == "support" and p.model == "@preset/support" and p.version == 1 and p.changed is True
    same = client.presets.upsert("support", models=["example/chat", "example/attested-chat"], description="Support bot", system_prompt="Be brief.", provider={"lane": "attested"})
    assert same.changed is False and same.version == 1
    v2 = client.presets.put("support", models=["example/chat"], description="Support bot", system_prompt="Be very brief.")
    assert v2.version == 2

    listed = client.presets.list()
    assert [x["name"] for x in listed] == ["support"] and listed.limits["presets"] == 100
    assert client.presets.get("support").latest_version == 2
    assert client.presets.get("support", version=1).config["system_prompt"] == "Be brief."

    versions = client.presets.versions("support")
    assert [v["version"] for v in versions] == [2, 1] and versions.latest == 2

    diff = client.presets.diff("support", from_=1, to=2)
    assert diff.identical is False
    assert {c["path"] for c in diff.changes} >= {"models", "system_prompt", "provider"}

    rolled = client.presets.rollback("support", 1)
    assert rolled.version == 3 and rolled.restored_from == 1 and rolled.config["system_prompt"] == "Be brief."

    gone = client.presets.delete("support")
    assert gone.deleted is True and gone.versions == 3
    with pytest.raises(NotFoundError) as e:
        client.presets.get("support")
    assert e.value.type == "preset_not_found"


def test_models_and_lane_filter(client: Trellis, router: FakeRouter) -> None:
    every = client.models.list()
    assert len(every) == 4 and all(isinstance(m, Model) for m in every)
    attested = client.models.list(lane="attested")
    assert [m.id for m in attested] == ["example/private-chat", "example/attested-chat"]
    assert [m.id for m in client.models.list(lane="unlinkable")] == ["example/private-chat"]
    assert attested[0].supports_lane("unlinkable") and not every[0].supports_lane("attested")
    rerankers = client.models.list(output_modalities="rerank")
    assert router.last.url.params["output_modalities"] == "rerank"
    assert [m.id for m in rerankers] == ["example/reranker"]
    client.models.list(output_modalities=["rerank", "embeddings"])
    assert router.last.url.params["output_modalities"] == "rerank,embeddings"
    assert client.models.retrieve("example/chat").name == "Chat"
    with pytest.raises(NotFoundError):
        client.models.retrieve("example/none")
    assert Model({"id": "x"}).lanes == ["public"]


# ---- holder tiers: membership levels that give access and priority ------------------------------------------------------


def test_holders_tiers_me_and_polls(client: Trellis, router: FakeRouter) -> None:
    tiers = client.holders.tiers()
    assert tiers["enabled"] is True and tiers["token"]["program"] == "token-2022" and tiers["cache_s"] == 3600
    assert [t["name"] for t in tiers["tiers"]] == ["Seed"] and tiers["tiers"][0]["min"] == "10000"
    me = client.holders.me()
    assert router.last.url.path == "/api/v1/holders/me" and router.last.headers["authorization"].startswith("Bearer ")
    assert me["tier"]["name"] == "Seed" and me["next_tier"] == {"name": "Vine", "min": "100000", "remaining": "75000"}
    assert me["perks"]["limits"]["rpm"] == 120 and me["perks"]["vote_weight"] == 1
    polls = client.holders.polls()
    assert [p["status"] for p in polls] == ["open", "closed"] and all(p["advisory"] is True for p in polls)
    closed = client.holders.polls(status="closed")
    assert router.last.url.params["status"] == "closed" and [p["id"] for p in closed] == ["poll_done1"]
    poll = client.holders.poll("poll_open1")
    assert poll["results"]["final"] is False and poll["options"] == ["example/one", "example/two"]
    with pytest.raises(NotFoundError):
        client.holders.poll("poll_nope")


def test_holders_vote_is_signed_by_the_wallet_and_sends_no_key(client: Trellis, router: FakeRouter) -> None:
    import hashlib

    from trellis import APIError, solana as S

    wallet = S.Signer.from_seed(bytes([21] * 32))  # a throwaway key derived from a fixed seed
    vote = client.holders.vote("poll_open1", "example/one", wallet, timestamp=1_760_000_000)
    assert dict(vote) == {"poll_id": "poll_open1", "option": "example/one", "tier": "Seed", "weight": 1, "voted_at": "2026-10-12T12:00:00.000Z"}
    sent = router.last
    assert sent.url.path == "/api/v1/holders/polls/poll_open1/vote" and json.loads(sent.content) == {"poll_id": "poll_open1", "option": "example/one"}
    assert "authorization" not in sent.headers
    address, ts, sig = sent.headers["x-wallet-auth"].split(":")
    digest = hashlib.sha256(b'{"option":"example/one","poll_id":"poll_open1"}').hexdigest()
    signed = f"trellis:wallet-auth:v2\nPOST\nrouter.test\n/api/v1/holders/polls/poll_open1/vote\n1760000000\n{digest}"
    assert address == wallet.address and ts == "1760000000" and S.verify_signature(address, signed.encode(), sig)
    assert not S.verify_signature(address, f"trellis:1760000000:{digest}".encode(), sig)  # the retired v1 message
    assert client.holders.poll("poll_open1")["results"]["total_votes"] == 1

    with pytest.raises(APIError) as again:
        client.holders.vote("poll_open1", "example/two", wallet)
    assert again.value.status == 409 and again.value.type == "already_voted"
    with pytest.raises(APIError) as closed:
        client.holders.vote("poll_done1", "example/one", wallet)
    assert closed.value.status == 409 and closed.value.type == "poll_closed"
