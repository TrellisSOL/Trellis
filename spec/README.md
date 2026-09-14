# Graft: the Trellis privacy protocol

Graft is the protocol Trellis uses to serve open-weight models privately and prove it. A graft joins a small attested
gateway (the sidecar) onto any OpenAI-compatible model server inside a confidential VM; everything else in the protocol
is about letting a client trust that graft without trusting its operator. It has five parts:

* **Attestation.** The sidecar publishes hardware evidence of what it runs: the served weights are hashed at boot, and
  an Intel TDX quote binds the TLS, receipt and HPKE keys and the image, compose and model digests.
* **Transport.** Requests are encrypted end to end to the attested enclave (HPKE), and can reach the router through an
  Oblivious HTTP relay or Tor so nobody on the path learns both who asked and what was asked.
* **Blind credits.** Requests on the private lane are paid with credentials the issuer signed blindly, so a purchase
  cannot be linked to a redemption.
* **Receipts.** Every response carries a signed receipt over the exact request and response bytes; receipt roots are
  anchored on chain.
* **Measured policy.** What the enclave blocks is defined by a measured policy document whose hash is public; nothing
  else is filtered and no content is logged.

This folder is the specification: RFC-style documents a third party can implement or verify against without reading
the Trellis code. The specification derives from an earlier Apache-2.0 protocol specification, adapted for Trellis;
the "Differences planned for Trellis" sections at the top of 0003 and 0004 say where Trellis departs from it.

| Document | Covers |
| :--- | :--- |
| [0001-attestation.md](0001-attestation.md) | Evidence, key binding, measurements, transparency of keys and manifests |
| [0002-transport.md](0002-transport.md) | Inner HPKE end-to-end encryption, outer (chunked) Oblivious HTTP, lanes |
| [0003-credits.md](0003-credits.md) | Blind credits: BDHKE e-cash with DLEQ proofs (planned for Trellis), blind RSA (earlier format) |
| [0004-receipts.md](0004-receipts.md) | Receipt claims, chunk hash chain, sha256 Merkle anchoring on Solana, verification order |
| [0005-policy.md](0005-policy.md) | Measured content policy, refusal receipts, privacy-safe stats, disputes without logs |
| [CHANGELOG.md](CHANGELOG.md) | Versions of this specification |

The HTTP API around these documents is described in OpenAPI 3.1 at [`web/public/openapi.json`](../web/public/openapi.json)
(a documented subset of the router's API).

## Lanes

A request chooses a lane (`provider.lane` in the body or the `X-Trellis-Lane` header; a key or a saved route can set a
default). A lane is a floor: the router never serves a request below the lane it asked for, and says why when it cannot
serve it (`no_attested_endpoint`, `lane_requires_anonymous_auth`).

| Lane | Path | Who can run it | Payment |
| :--- | :--- | :--- | :--- |
| `public` | TLS to the router, then to any provider | Any provider | API key, credits, per-call payment or blind credit |
| `attested` | TLS to the router, then to an enclave whose attestation the router verified recently | Attested providers only | API key, credits, per-call payment or blind credit |
| `unlinkable` | Oblivious HTTP through an independent relay to the router's gateway, or Tor to the router's onion service; then to an attested enclave | Attested providers only | Blind credits only; an API key or a wallet is refused |

## Guarantees (design targets)

These are the properties Graft is designed to provide once every part in the status table below is built. They are
targets, not claims about a deployment; the status table says which parts exist.

| | Target |
| :--- | :--- |
| G1 | **Attested execution.** A request is served only by an enclave whose CPU quote and GPU evidence match a publicly logged manifest. |
| G2 | **Weights identity.** The digest of the served weights is measured at boot and named in every receipt. |
| G3 | **Confidentiality.** Plaintext exists only in confidential-VM memory and confidential-GPU memory; requests are encrypted from the client to a key the enclave's evidence binds. |
| G4 | **Unlinkable payment.** The credit issuer cannot link a purchase to a redemption, and a DLEQ proof shows it signed with the published key rather than a per-user one. |
| G5 | **Network privacy.** On the `unlinkable` lane the client's address is hidden from the router by an Oblivious HTTP relay run by another operator, or by Tor when the request reaches the router's onion service. |
| G6 | **Verifiable receipt.** Each response has a signed receipt with request and response hashes, a hash chain over streamed chunks, the execution profile and the policy hash; receipt roots are anchored on Solana. |
| G7 | **Verifiable policy.** What the enclave blocks is defined by a measured policy document whose hash is public; nothing else is filtered and no content is logged. |
| G8 | **No key partitioning.** Every key or configuration a client encrypts to or verifies against is in a witnessed transparency log, and clients refuse keys that are not. |

## Parties

| Symbol | Party | Learns | Does not learn |
| :--- | :--- | :--- | :--- |
| U | User or agent, with the client SDK | Everything about its own requests | |
| R | Oblivious HTTP relay (another operator); on the Tor path, the volunteer relays of U's Tor circuit instead | U's address (on the Tor path only the entry relay, which does not learn the destination), ciphertext sizes and timing | Content, destination host or model, payer |
| G | Trellis gateway and router | That a valid credit was presented, cost, destination host, ciphertext | U's address (behind R), U's identity, plaintext (on the E2EE path) |
| M | Credit issuer (mint) | That someone bought N credits on some rail | Which requests those credits paid for |
| H | Host operator running the sidecar | That its enclave served ciphertext, token counts | Plaintext, U's address, payer |
| E | The enclave (confidential VM and GPU) | Plaintext, in memory only | U's address, payer identity, purchase |
| L, C | Transparency log and chain | Public measurements, keys, receipt roots | Anything about users |

## Honest limits

These hold for the design, not only for the code, and are published with it.

* Trust rests on Intel, AMD and NVIDIA silicon, reproducible builds and witnessed logs. It is not a cryptographic proof of inference.
* GPU attestation on shipping Hopper and Blackwell parts proves a genuine confidential-computing GPU is reachable. It does not bind that GPU to the confidential VM (no TDISP yet). Physical memory-interposer attacks on DDR5 are out of scope.
* AMD SEV-SNP hosts cannot carry confidential-GPU claims yet: SNP has no runtime measurement register to bind GPU evidence into.
* Unlinkability holds against Trellis, against hosts and against any single relay. It does not hold against a relay colluding with the gateway, or against a global network observer correlating timing.
* On the Tor path of `unlinkable`, Tor takes the place of the independent relay. Trellis runs the onion service and never learns the client's address, because a Tor onion service is never given it. Ordinary chat exposes plaintext to the router; the distinct encrypted-chat adapter forwards encrypted content to the gateway enclave. The router sees clear routing metadata and request size and timing directly, with no relay in between. An observer who watches both the client's entry into Tor and the router's side can match them by timing, and requests sent on one Tor circuit can be linked to each other.
* Deterministic (batch-invariant) serving and confidential-computing mode both cost throughput.
* Credits are non-transferable prepaid inference, not money and not an investment.
* A minimal, measured block list runs inside the enclave and its hash is public. Nothing else is filtered.
* Stylometric identification from prompt content is out of scope: the protocol hides the channel, not what you write.

## Status of this repository

"Implemented" means the code and its validation are in this repository. It does not mean it is deployed or switched
on: most privacy features are off by default and need configuration. "Planned" means specified here and not yet in
code. Parts marked TODO(solana) describe planned work on Solana programs.

| Part | Spec | Status | Where |
| :--- | :--- | :--- | :--- |
| Attested sidecar: weights hashed at boot against an allow-list; Intel TDX quote whose report data binds the TLS, receipt and HPKE keys and the image, compose and model digests; opt-in SHA-256 bindings v2 (source archive hash, engine image, model id); quote-pinned TLS certificate | 0001 | Implemented | [`sidecar/`](../sidecar) |
| Host install package: one-command installer (engine detection, `graft.yaml` schema and validator), Compose file, Helm chart, Terraform modules (GCP TDX, Azure SEV-SNP public lane only, dstack cloud skeleton), `graft` CLI (`init`, `add-node`, `verify`, `status`) | 0001 | Implemented; the hosted installer address is planned | [`deploy/graft/`](../deploy/graft), [`scripts/graft-cli.ts`](../scripts/graft-cli.ts) |
| Router verifies provider evidence: fresh nonce-bound quotes, pluggable quote verifiers, NVIDIA remote attestation for GPU evidence a provider reports, quote-pinned TLS, attestation history | 0001 | Implemented | [`src/services/attestor.ts`](../src/services/attestor.ts), [`src/providers/`](../src/providers) |
| Client-side checks of a sidecar's evidence and receipts (quote signature through a caller-supplied verifier) | 0001, 0004 | Implemented; the captured TDX evidence the tests ran against must be re-captured from a Graft deployment | [`packages/client`](../packages/client), [`packages/client-py`](../packages/client-py) |
| Measurement bundles published to a public Sigstore Rekor log; router verifies inclusion | 0001 | Implemented | [`scripts/publish-measurement.ts`](../scripts/publish-measurement.ts), [`src/services/measurements.ts`](../src/services/measurements.ts) |
| On-chain measurement registry (image, compose and model digests, log entry, quote-proof hash) | 0001 | TODO(solana): a `measurement-registry` program replaces the earlier contract | |
| GPU evidence bound into the sidecar's own quote; `policy-hash` and `exec-profile-hash` boot events; RTMR3 replay by clients | 0001 | Planned | |
| In-toto manifests, policy registry program, threshold KMS with on-chain governance | 0001 | Planned | |
| Trellis-run transparency log (tlog-tiles) with witnesses, or with public-log anchoring of checkpoints in Sigstore Rekor; client split-view checks | 0001, 0002 | Implemented, off by default | [`src/tlog/`](../src/tlog), [`packages/client/src/tlog.ts`](../packages/client/src/tlog.ts), [`scripts/tlog-witness.ts`](../scripts/tlog-witness.ts) |
| Signed host admission policy with `host_policy` key-log entries; automatic admission and probation against quote-bound pins and screened operator and payout addresses | 0001 | Implemented, off by default; the approved Intel TDX build's pins are not published yet | [`src/network/`](../src/network/), [`deploy/network/approved/tdx-qwen2.5-0.5b/`](../deploy/network/approved/tdx-qwen2.5-0.5b/) |
| Inner E2EE `trellis-hpke/v1` (single-shot request, framed streaming response) | 0002 | Implemented, off by default | [`sidecar/src/hpke.ts`](../sidecar/src/hpke.ts), [`packages/client/src/hpke.ts`](../packages/client/src/hpke.ts) |
| Encrypted chat adapter through an attested confidential-AI gateway; client-encrypted content reaches the gateway enclave, with routing metadata visible to the router; distinct from sidecar HPKE | 0002 | Implemented, off by default (`E2EE_PASSTHROUGH_ENABLED`) | [`src/e2ee/`](../src/e2ee), [`packages/client/src/e2ee.ts`](../packages/client/src/e2ee.ts) |
| Sidecar `trellis-hpke/v1` ciphertext carried through ordinary router chat routes | 0002 | Planned | |
| Chunked inner E2EE for streamed requests; fixed-size padding and send tick | 0002 | Planned | |
| Oblivious HTTP gateway (RFC 9458, 9292); per-epoch keys; key history as a signed hash chain; relay list with operator independence | 0002 | Implemented, off by default; non-streaming only | [`src/ohttp/`](../src/ohttp) |
| Independent Oblivious HTTP relay | 0002 | Implemented | [`relay/`](../relay) |
| Chunked Oblivious HTTP for streaming responses | 0002 | Implemented, off by default | [`src/ohttp/chunked.ts`](../src/ohttp/chunked.ts), [`relay/`](../relay), [`packages/client/src/ohttp.ts`](../packages/client/src/ohttp.ts) |
| Tor onion service in front of the router | 0002 | Implemented | [`deploy/onion/`](../deploy/onion) |
| Lane `unlinkable` over the onion service: Tor instead of an independent relay, blind credits only | 0002 | Implemented, off by default | [`src/onion/`](../src/onion), [`src/ohttp/lane.ts`](../src/ohttp/lane.ts) |
| Lanes `public`, `attested`, `unlinkable` in the router: per request, per key and per saved route; no fallback off an attested lane; lane-aware selection weight | 0002 | Implemented | [`src/router/disclosure.ts`](../src/router/disclosure.ts), [`src/router/select.ts`](../src/router/select.ts), [`src/ohttp/lane.ts`](../src/ohttp/lane.ts) |
| Blind RSA tokens (Privacy Pass type 0x0002), per-epoch issuer keys | 0003 | Implemented, off by default (earlier format); on-chain key commitments are TODO(solana) | [`src/blind/`](../src/blind) |
| Blinded e-cash credits (BDHKE, DLEQ, P2PK, swap and change); issuer in an enclave; sealed nullifier store; purchase with USDC on Solana | 0003 | Planned (the credential type Trellis will ship) | |
| Receipts v1: Ed25519 over canonical JSON, from the router and from the sidecar; leaf = sha256(sha256(payload ‖ signature)) | 0004 | Implemented | [`src/receipts/`](../src/receipts), [`sidecar/src/receipts.ts`](../sidecar/src/receipts.ts) |
| Hourly sha256 Merkle roots of router receipts, with a proof endpoint; the root is posted on chain only where a cluster is configured (off chain otherwise, and proofs say so) | 0004 | Implemented off chain; the `receipt-anchor` program is TODO(solana) | [`src/services/anchor.ts`](../src/services/anchor.ts) |
| Per-host anchoring of enclave receipts: leaves from each attested sidecar's feed, kept only if signed by the receipt key its verified quote binds, rooted per host and interval, with a proof endpoint and a client check | 0004 | Implemented off chain, off by default; posting is TODO(solana) | [`src/services/host-anchor.ts`](../src/services/host-anchor.ts), [`packages/client/src/host-anchor.ts`](../packages/client/src/host-anchor.ts) |
| Router receipts v2: COSE_Sign1 (EdDSA), chunk hash chain over router streams, bucketed token counts; checks in the SDK, the web verifier and a CLI | 0004 | Implemented | [`src/receipts/v2.ts`](../src/receipts/v2.ts), [`packages/client/src/receipts-v2.ts`](../packages/client/src/receipts-v2.ts), [`packages/client/bin/verify-receipt.ts`](../packages/client/bin/verify-receipt.ts) |
| Node receipts v2: signed in the enclave, execution profile, epoch nullifier | 0004 | Planned | |
| In-enclave classifier: pinned weights, policy hash bound in the quote, one-bit receipt field, signed refusal | 0005 | Implemented, off by default | [`sidecar/src/classifier.ts`](../sidecar/src/classifier.ts) |
| Privacy-safe stats: no per-request logs in the sidecar; hourly counters released with snapped Laplace noise from a CSPRNG, epsilon 1 per family per hour by default, daily budget ledger | 0005 | Implemented | [`sidecar/src/dpstats.ts`](../sidecar/src/dpstats.ts), [`src/services/private-stats.ts`](../src/services/private-stats.ts) |
| Blocks counted by policy category; privacy parameters bound in the attestation | 0005 | Planned | |
| Measured `policy.json` in a boot event; token-streamed output checks; dispute re-run in a second enclave | 0005 | Planned | |

## Versioning

The specification is versioned as a whole with semantic versioning; see [CHANGELOG.md](CHANGELOG.md). Until 1.0.0 any
document may change incompatibly. Wire formats carry their own version strings (`trellis-hpke/v1`, receipt `v`), and a
format that is implemented keeps its version string until it is retired.

## License

The documents in this folder are licensed under the [Apache License, Version 2.0](LICENSE), so anyone can implement
Graft. This applies to `spec/` only; the rest of the repository keeps its own license (see the root [LICENSE](../LICENSE)
and [NOTICE](../NOTICE)). The specification derives from an earlier Apache-2.0 protocol specification and keeps that
license.

Copyright 2026 Trellis contributors.
