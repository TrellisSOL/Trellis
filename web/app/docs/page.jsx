// Developer documentation hub. It keeps every documented anchor other pages link to, renders the documentation
// sections that live in components/*Docs.jsx, and holds the shorter sections (API shims, batches, characters, teams,
// tracing, the transparency log and the data inventory) inline.
import LaunchSurfaceDocs, { NotAtLaunch } from "../../components/LaunchSurfaceDocs";
import PageFrame from "../../components/PageFrame";
import { Code } from "../../components/UI";
import { sampleRequest } from "../../components/Extensions";
import OnionAddress from "../../components/OnionAddress";
import DocsFeatureIndex, { DocsFeatureLinks } from "../../components/DocsFeatureIndex";
import FirstCallDocs from "../../components/FirstCallDocs";
import GetUsdcDocs from "../../components/GetUsdcDocs";
import PaymentsDocs from "../../components/PaymentsDocs";
import TabsDocs from "../../components/TabsDocs";
import FacilitatorDocs from "../../components/FacilitatorDocs";
import HostBondDocs from "../../components/HostBondDocs";
import FastCreditDocs from "../../components/FastCreditDocs";
import DepositCountdownDocs from "../../components/DepositCountdownDocs";
import AutoTopupDocs from "../../components/AutoTopupDocs";
import RunwayDocs from "../../components/RunwayDocs";
import MakeGoodDocs from "../../components/MakeGoodDocs";
import StatementDocs from "../../components/StatementDocs";
import LaneReportDocs from "../../components/LaneReportDocs";
import ProofPackDocs from "../../components/ProofPackDocs";
import PrivateProxyDocs from "../../components/PrivateProxyDocs";
import ClaudeUnlinkableDocs from "../../components/ClaudeUnlinkableDocs";
import E2eeDocs from "../../components/E2eeDocs";
import GraftEncryptedChatDocs from "../../components/GraftEncryptedChatDocs";
import KeyProvisioningDocs from "../../components/KeyProvisioningDocs";
import UnusedKeysDocs from "../../components/UnusedKeysDocs";
import ModelAlternativesDocs from "../../components/ModelAlternativesDocs";
import StructuredOutputDocs from "../../components/StructuredOutputDocs";
import RouteExplanationDocs from "../../components/RouteExplanationDocs";
import WebhookDocs from "../../components/WebhookDocs";
import ToolsMarketDocs from "../../components/ToolsMarketDocs";
import DecisionTagDocs from "../../components/DecisionTagDocs";
import AgentRulebookDocs from "../../components/AgentRulebookDocs";
import AgentRulebookClientDocs from "../../components/AgentRulebookClientDocs";
import SpendingLimitsDocs from "../../components/SpendingLimitsDocs";
import DefaultRouteDocs from "../../components/DefaultRouteDocs";
import StarterSetupsDocs from "../../components/StarterSetupsDocs";
import ReplayRulesDocs from "../../components/ReplayRulesDocs";
import PlaybooksDocs from "../../components/PlaybooksDocs";
import RulebookWordsDocs from "../../components/RulebookWordsDocs";
import AgentApprovalDocs from "../../components/AgentApprovalDocs";
import ApproveAndAllowDocs from "../../components/ApproveAndAllowDocs";
import AgentGuardDocs from "../../components/AgentGuardDocs";
import AgentPayDocs from "../../components/AgentPayDocs";
import AgentBreakersDocs from "../../components/AgentBreakersDocs";
import AgentAutonomyDocs from "../../components/AgentAutonomyDocs";
import StopUntilDocs from "../../components/StopUntilDocs";
import AgentLedgerDocs from "../../components/AgentLedgerDocs";
import AgentAlertDocs from "../../components/AgentAlertDocs";
import WeeklySummaryDocs from "../../components/WeeklySummaryDocs";
import AgentCertificateDocs from "../../components/AgentCertificateDocs";
import AgentProfileDocs from "../../components/AgentProfileDocs";
import GraftedAgentDocs from "../../components/GraftedAgentDocs";
import GraftNetworkDocs from "../../components/GraftNetworkDocs";
import NetworkHostsDocs from "../../components/NetworkHostsDocs";
import NetworkPolicyDocs from "../../components/NetworkPolicyDocs";
import NetworkPayoutDocs from "../../components/NetworkPayoutDocs";
import NetworkStatsDocs from "../../components/NetworkStatsDocs";
import HostsDocs from "../../components/HostsDocs";
import HoldersDocs from "../../components/HoldersDocs";
import { DocsSurfaceMarks } from "../../components/launch/Surface";

export const metadata = { title: "Developer documentation — Trellis", description: "Quickstart, payments on Solana, lanes, keys, the API shims, agent rulebooks, the transparency log and the network." };

const routingExample = `curl https://<router>/api/v1/chat/completions \\
  -H "Authorization: Bearer $TRELLIS_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "qwen/qwen3-32b",
    "models": ["deepseek/deepseek-v3"],
    "provider": { "lane": "attested", "sort": "price", "max_price": { "completion": 2 }, "allow_fallbacks": true },
    "messages": [{ "role": "user", "content": "Hello" }]
  }'`;

const anthropicSetup = `# Claude Code and the Anthropic SDKs: point them at the router.
export ANTHROPIC_BASE_URL=https://<router>
export ANTHROPIC_AUTH_TOKEN=$TRELLIS_API_KEY        # or ANTHROPIC_API_KEY: the router reads x-api-key too
export ANTHROPIC_MODEL=qwen/qwen3-32b               # a catalog id from GET /v1/models
export ANTHROPIC_DEFAULT_HAIKU_MODEL=qwen/qwen3-8b  # the small model Claude Code uses for quick tasks
export ANTHROPIC_CUSTOM_HEADERS="X-Trellis-Lane: attested"  # optional: refuse anything but a verified enclave
claude`;

const anthropicCall = `POST /v1/messages
x-api-key: $TRELLIS_API_KEY
anthropic-version: 2023-06-01

{ "model": "qwen/qwen3-32b", "max_tokens": 256, "messages": [{ "role": "user", "content": "Hello" }] }

# Count tokens without a call (no charge):
POST /v1/messages/count_tokens`;

const ollamaSetup = `# Any Ollama client: set its host to the router's /ollama path and send the key as a bearer token.
export OLLAMA_HOST=https://<router>/ollama
curl $OLLAMA_HOST/api/chat \\
  -H "Authorization: Bearer $TRELLIS_API_KEY" \\
  -H "X-Trellis-Lane: attested" \\
  -d '{ "model": "qwen/qwen3-32b", "messages": [{ "role": "user", "content": "Hello" }], "options": { "num_predict": 200 } }'`;

const responsesSetup = `# OpenAI Agents SDK (Python)
from agents import set_default_openai_client
from openai import AsyncOpenAI
set_default_openai_client(AsyncOpenAI(base_url="https://<router>/api/v1", api_key=TRELLIS_API_KEY,
                                      default_headers={"X-Trellis-Lane": "attested"}))

# Codex CLI (~/.codex/config.toml)
[model_providers.trellis]
name = "Trellis"
base_url = "https://<router>/api/v1"
env_key = "TRELLIS_API_KEY"
wire_api = "responses"`;

const batchExample = `POST /api/v1/batches
Authorization: Bearer $TRELLIS_API_KEY

{
  "endpoint": "/v1/chat/completions",
  "requests": [
    { "custom_id": "q-1", "method": "POST", "url": "/v1/chat/completions",
      "body": { "model": "qwen/qwen3-32b", "messages": [{ "role": "user", "content": "Summarise ..." }] } }
  ]
}`;

const characterSetup = `SillyTavern
  API: Chat Completion
  Chat Completion Source: Custom (OpenAI-compatible)
  Custom Endpoint: https://<router>/api/v1
  Custom API Key: <your Trellis key>
  Model ID: @character/<id>`;

const tracingExample = `PATCH /api/v1/keys/<hash>
{ "tracing": { "type": "otlp", "endpoint": "https://api.honeycomb.io/v1/traces",
               "headers": { "x-honeycomb-team": "<Honeycomb key>" }, "include_content": false, "enabled": true } }`;

const badgeExample = `<script src="https://<router>/badge.js" data-endpoint="<provider id or author/model>" data-theme="auto" async></script>

<!-- or a plain image, rendered by the router -->
<img src="https://<router>/api/v1/badge/<provider id>.svg" alt="Trellis attestation status">`;

const mcpConfig = `{ "mcpServers": { "trellis": { "url": "https://<router>/mcp", "headers": { "Authorization": "Bearer <your Trellis key>" } } } }`;

const ragExample = `POST /api/v1/rag
Authorization: Bearer $TRELLIS_API_KEY

{ "model": "qwen/qwen3-32b", "question": "What does clause 4 require?",
  "documents": [{ "id": "contract", "text": "..." }, "a second document as a plain string"], "top_k": 6 }`;

export default function Docs() {
  return <PageFrame><main className="page-main" id="content">
    <div className="page-title" data-reveal><span className="eyebrow">Docs / Developer documentation</span><h1>Build on<br/>one API.</h1><p>Choose a model, inspect a payment quote and check a receipt. Start here for the public API, read the <a className="inline-link" href="/whitepaper/">whitepaper</a> for the protocol, or see the <a className="inline-link" href="/roadmap/">roadmap</a> for upcoming capabilities.</p></div>
    <div className="side-layout">
      <nav className="side-nav" aria-label="Documentation sections" data-reveal="fade">
        <span className="side-nav-label">On this page</span>
        <a href="#quickstart">Quickstart</a>
        <a href="#payments">Payments</a>
        <a href="#get-usdc">Get USDC</a>
        <a href="#tabs">Tabs</a>
        <a href="#facilitator">Facilitator</a>
        <a href="#make-good-refunds">Refunds</a>
        <a href="#routing">Routing</a>
        <a href="#lanes">Lanes</a>
        <a href="#unlinkable-tor">Unlinkable lane</a>
        <a href="#private">Private proxy</a>
        <a href="#private-tokens">Blind tokens</a>
        <a href="#e2ee-gateway">Encrypted chat</a>
        <a href="#key-management">Keys</a>
        <a href="#key-log">Key log</a>
        <a href="#keep">What we keep</a>
        <a href="#errors">Errors</a>
        <a href="#structured-output">Structured output</a>
        <a href="#anthropic">Anthropic Messages</a>
        <a href="#ollama">Ollama</a>
        <a href="#responses">Responses API</a>
        <a href="#batches">Batches</a>
        <a href="#characters">Characters</a>
        <a href="#rag">Files and RAG</a>
        <a href="#mcp">MCP</a>
        <a href="#sdk">SDKs</a>
        <a href="#signed-webhooks">Webhooks</a>
        <a href="#tracing">Tracing</a>
        <a href="#teams">Teams</a>
        <a href="#paid-tools">Paid tools</a>
        <a href="#agent-rulebook">Agent rulebook</a>
        <a href="#sealed-agents">Sealed agents</a>
        <a href="#open-network">Network</a>
        <a href="#host-bonds">Host bonds</a>
        <a href="#holders">Holder tiers</a>
        <a href="#run-a-provider">Run a provider</a>
        <a href="#badge">Badge</a>
        <a href="#whats-new">What’s new</a>
        <span className="side-nav-label">Features</span><DocsFeatureLinks />
      </nav>
      {/* No scroll reveal here: the article is far taller than any window, so the reveal's 14% visibility threshold could never be met and the text stayed transparent. */}
      <article className="page-body prose docs-body">
        {/* Launch surface: the hub stays fully readable. The note says what a router serves at launch and, once the page has the router's status, what this router reports. Sections outside core carry a "Built, not enabled at launch" line, which on a core router is replaced by the router's own marker (lib/launch-surface.js docs lists). */}
        <LaunchSurfaceDocs />
        <DocsSurfaceMarks />
        <section id="quickstart" className="docs-section">
          <h2>Quickstart</h2>
          <p>Use <code>https://trellischat.app/api/v1</code> as the base URL. Read the catalog and copy a chat model’s exact ID. This request only reads public information.</p>
          <Code label="List models">{'curl -sS https://trellischat.app/api/v1/models'}</Code>
          <p>Replace <code>MODEL_ID</code> below with that ID. Send this request without payment credentials to see the quote. HTTP 402 is the expected result. Read the accepted network, asset, amount and recipient before approving anything in a wallet.</p>
          <Code label="Request a quote">{`curl -i https://trellischat.app/api/v1/chat/completions \\
  -H 'Content-Type: application/json' \\
  -d '{"model":"MODEL_ID","messages":[{"role":"user","content":"Say hello."}],"max_tokens":12,"stream":false}'`}</Code>
          <p>To proceed, have an x402-compatible wallet client sign the accepted terms and retry the matching request with its payment payload. Keep the <code>PAYMENT-RESPONSE</code> and <code>X-Receipt-Id</code> headers when returned. Open <a className="inline-link" href="/verify/">Verify</a> with the receipt ID. If a paid response is interrupted, check payment recovery before authorizing another transfer.</p>
          <p>For account-based integrations, check the <a className="inline-link" href="/status/">current payment modes</a> before using a bearer-key example.</p>
          <Code label="Two lines change">{sampleRequest}</Code>
          <FirstCallDocs />
        </section>
        <PaymentsDocs />
        <GetUsdcDocs />
        <TabsDocs />
        <FacilitatorDocs />
        <section id="fast-credit" className="docs-section"><h2>Early credit</h2><NotAtLaunch /><FastCreditDocs /></section>
        <DepositCountdownDocs />
        <RunwayDocs />
        <MakeGoodDocs />
        <StatementDocs />
        <ProofPackDocs />
        <LaneReportDocs />

        <section id="routing" className="docs-section">
          <h2>Routing</h2>
          <p>A request names a model and, optionally, how to choose among the providers that serve it. Model ids are <code>author/model</code>, with the suffixes <code>:nitro</code> (sort by throughput), <code>:floor</code> (sort by price) and <code>:free</code>. <code>models</code> is an ordered fallback list tried when the first model cannot be served.</p>
          <p>The <code>provider</code> object narrows the choice: <code>order</code>, <code>only</code> and <code>ignore</code> name providers; <code>allow_fallbacks</code> (default true) lets the router move down the list when a provider fails without producing tokens (a 5xx, a refused or reset connection, a stream that breaks before any content, an empty 200 that reports no usage), and such an attempt is not charged; when the router’s own timeout cuts off a provider that had accepted the request, the call ends there with <code>504 provider_timeout</code> and is charged as <a href="#calls-that-end-early">Calls that end early</a> says; <code>require_parameters</code> keeps providers that do not support a parameter you sent out of the running; <code>quantizations</code>, <code>max_price</code> (per million prompt and completion tokens), <code>sort</code> (<code>price</code>, <code>throughput</code> or <code>latency</code>), <code>data_collection</code> and <code>zdr</code> route on the provider’s documented data handling; <code>lane</code> is the floor described under <a href="#lanes">Lanes</a>.</p>
          <p>Among the candidates left, the router drops any provider with an outage in the last 30 seconds and weights the rest by <code>uptime × quality × attested_bonus / price²</code> (<code>GET /api/v1/status</code> reports the formula it is running). A request never falls back off an attested lane. A <a href="/dashboard/#saved-routes">saved route</a> stores a <code>provider</code> object and a model list under a name, and a key can carry a <a href="#default-route">default route</a>. With route explanations on, the receipt says which providers were eligible and why one was chosen (<a href="#why-this-route">Why this route?</a>).</p>
          <Code label="Routing options">{routingExample}</Code>
        </section>

        <section id="lanes" className="docs-section">
          <h2>Lanes</h2>
          <p>A lane says what the router may do with a request. Set it with <code>provider.lane</code> in the body or the <code>X-Trellis-Lane</code> header; a key or a saved route can carry a default. A lane is a floor: the router never serves a request below the lane it asked for, and says why when it cannot (<code>no_attested_endpoint</code>, <code>lane_requires_anonymous_auth</code>). The lane that served a call comes back in the <code>X-Trellis-Lane</code> header and in the signed receipt.</p>
          <table>
            <thead><tr><th>Lane</th><th>Path</th><th>Who can run it</th><th>Payment</th></tr></thead>
            <tbody>
              <tr><td><code>public</code></td><td>TLS to the router, then to any provider</td><td>Any provider</td><td>API key, credits, per-call payment or blind token</td></tr>
              <tr><td><code>attested</code></td><td>TLS to the router, then to an enclave whose attestation the router verified recently</td><td>Attested providers only</td><td>API key, credits, per-call payment or blind token</td></tr>
              <tr><td><code>unlinkable</code></td><td>Oblivious HTTP through an independent relay, or Tor to the router’s onion service; then to an attested enclave</td><td>Attested providers only</td><td>Blind tokens only; an API key or a wallet is refused</td></tr>
            </tbody>
          </table>
          <p>Two kinds of provider serve the attested and unlinkable lanes. An <strong>attested gateway</strong> is a provider that runs the confidential hardware and exposes an attested, OpenAI-compatible endpoint: the router verifies the gateway’s attestation on every attestor pass, forwards the request (or ciphertext, on the <a href="#e2ee-gateway">encrypted chat</a> path) and pays per token at the gateway’s own price with no markup, so the lane costs nothing while it is idle. A <strong>Graft host</strong> is an operator’s own confidential VM running the Graft sidecar, whose measurements and model digest the router pins itself (<a href="#run-a-provider">Run a provider</a>). The receipt says which kind served a call: a gateway call carries the gateway’s own signed receipt and its claims as <code>upstream_attestation</code>.</p>
          <p>The two do not prove the same thing. With a gateway, the proof covers the gateway enclave and what its receipt asserts about the model servers behind it, not a container Trellis controls. The router does not appraise the gateway’s source itself: in production it attests a gateway only against a measurement allow-list its operator configured, naming both the MRTD and the RTMR3 of a release the operator accepted, and a gateway with no such list, or on a release that is not listed, fails attestation. It checks platform patch level (TCB status) only when a DCAP or Intel Trust Authority verifier is configured, and takes model-weights provenance as the gateway reports it. A gateway that fails attestation is dropped from the lane until it verifies again.</p>
          <p>On every lane the router reads ordinary chat text in memory to route and bill it; what it does not do is keep it. Only the <a href="#e2ee-gateway">encrypted chat</a> path forwards ciphertext. The <a href="/dashboard/#statements">lane report</a> counts how many of a key’s calls ran on each lane.</p>
        </section>

        <section id="unlinkable-tor" className="docs-section">
          <h2>Unlinkable lane over Tor</h2><NotAtLaunch />
          <p>The <code>unlinkable</code> lane hides who is asking from the router. The client either sends through an Oblivious HTTP relay run by another operator (<code>GET /api/v1/ohttp/keys</code> publishes the gateway key configuration, <code>/api/v1/ohttp/key-list</code> the signed history of it) or reaches the router’s Tor onion service, where Tor takes the relay’s place: an onion service is never given the client’s address. Either way the request is paid with a <a href="#private-tokens">blind token</a>; an API key or a wallet is refused on this lane, because both would name the payer.</p>
          <OnionAddress />
          <p>What stays visible: request size and timing, the model asked for and the destination host. An observer watching both the client’s entry into Tor and the router can match them by timing, and requests sent on one Tor circuit can be linked to each other. The <a href="#private">private proxy</a> sets up a Tor client, buys tokens and sends through the onion service in one command. Both paths are off by default on a self-hosted router; <code>GET /api/v1/status</code> reports <code>lanes.unlinkable.available</code> and <code>onion.address</code>.</p>
        </section>

        <PrivateProxyDocs />
        <ClaudeUnlinkableDocs />

        <section id="private-tokens" className="docs-section">
          <h2>Blind tokens</h2><NotAtLaunch />
          <p>A blind token is paid access that the router cannot link to a purchase: Privacy Pass tokens (RFC 9578 type 0x0002, blind RSA signatures per RFC 9474). <code>GET /api/v1/blind/keys</code> lists one 2048-bit issuer key per denomination (1,000, 10,000 and 100,000 token-units) per weekly epoch, published before the epoch starts. <code>POST /api/v1/blind/purchase</code> debits the key’s credits and returns one blind signature per blinded message; the client blinds the inputs and unblinds the signatures locally, and the router stores counts only, never the blinded messages or the tokens. Spending a token on the <code>unlinkable</code> lane reveals nothing about which purchase it came from.</p>
          <p>The <a className="inline-link" href="/tokens/">blind tokens page</a> runs the flow in the browser and keeps the tokens in a file you hold; the <a href="#private">private proxy</a> buys and spends them from the command line. Blind tokens are present only when the router enables them (<code>GET /api/v1/status</code> reports it); the protocol specification (<a href="/spec/0003-credits/">0003</a>) describes the e-cash format that will replace this one.</p>
        </section>

        <span id="e2ee-tee-cloud" aria-hidden="true" />{/* the router's capability module still links the encrypted-chat section by this older anchor */}
        <E2eeDocs />
        <GraftEncryptedChatDocs />
        <KeyProvisioningDocs />
        <UnusedKeysDocs />

        <section className="docs-section">
          <h2 id="key-log">Signing-key transparency log</h2><NotAtLaunch />
          <p>Every key a client encrypts to or verifies against is written to an append-only log (C2SP tlog-tiles, RFC 6962 hashing): receipt signing keys (<code>receipt_key</code>), Oblivious HTTP key configurations (<code>ohttp_key_config</code>), blind-token issuer keys (<code>blind_issuer_key</code>), measurement bundles (<code>measurement_bundle</code>), sidecar key bindings (<code>attestation_binding</code>), the <a href="#keep">data inventory</a> (<code>data_inventory</code>) and the signed host policy (<code>host_policy</code>). Checkpoints are signed notes that independent witnesses cosign. <code>GET /api/v1/tlog</code> names the entry kinds and the witnesses; <code>/api/v1/tlog/proof?kind=&amp;sha256=</code> returns an inclusion proof for one key, <code>/api/v1/tlog/consistency</code> a consistency proof between two checkpoints, and <code>/tlog/checkpoint</code> and <code>/tlog/tile/…</code> serve the raw log. Pin the log’s verifier key and the witness keys from a source other than the log.</p>
          <p>The client check is opt-in: <code>@trellis/client</code> exports <code>TransparencyLog</code>, which refuses a receipt key, gateway key or issuer key that has no inclusion proof and throws <code>SplitViewDetected</code>, carrying both signed notes, when two checkpoints it saw cannot be reconciled by a consistency proof. Anyone can run a witness with <code>scripts/tlog-witness.ts</code>.</p>
          <p>As an alternative to witnesses, the router can anchor each new checkpoint in the public Sigstore Rekor log (<code>TLOG_REKOR_ENABLED</code>): <code>GET /api/v1/tlog/rekor</code> lists every anchored checkpoint with its Rekor entry and inclusion proof, <code>/api/v1/tlog/rekor/key</code> publishes the anchoring key, and <code>/api/v1/tlog/rekor/{"{size}"}</code> returns the anchor for one checkpoint size. Compare the entries that key has at <code>search.sigstore.dev</code> with the router’s list: an entry the list does not explain, or two anchored checkpoints of one size with different roots, is evidence of a split view. The log is off by default on a self-hosted router (<code>TLOG_ENABLED</code>) and <code>GET /api/v1/tlog</code> answers 404 until it is on.</p>
        </section>

        <section className="docs-section">
          <h2 id="keep">What we keep</h2>
          <p>The <a className="inline-link" href="/keep/">What we keep</a> page is generated from the router’s data inventory: every category of data the router stores, with its purpose, retention and who can read it. <code>GET /keep/inventory.json</code> serves the same inventory as canonical JSON (keys sorted, no whitespace), and the page shows its SHA-256; <code>curl -s https://&lt;this site&gt;/keep/inventory.json | sha256sum</code> reproduces it.</p>
          <p>With <code>TLOG_DATA_INVENTORY</code> on, the router appends that hash to its <a href="#key-log">transparency log</a> as a <code>data_inventory</code> entry when it starts, so a changed inventory leaves a dated record. <code>GET /api/v1/tlog/proof?kind=data_inventory&amp;sha256=&lt;hash&gt;</code> returns the entry and its inclusion proof; the page runs that lookup in the browser and says when the log does not hold the hash.</p>
        </section>

        <ModelAlternativesDocs />
        <StructuredOutputDocs />

        <section id="anthropic" className="docs-section">
          <h2>Anthropic Messages API</h2><NotAtLaunch />
          <p><code>POST /v1/messages</code> (also at <code>/api/v1/messages</code>) is the Anthropic Messages API, for the Anthropic SDKs and Claude Code. The request is converted to a chat completion and sent through <code>/api/v1/chat/completions</code> inside the router, so the key, balance, limits, lane, signed receipt and response headers are those of a chat call. Authenticate with <code>x-api-key</code> or <code>Authorization: Bearer</code>. The model is a catalog id from <code>GET /v1/models</code>, or a name the operator mapped with <code>ANTHROPIC_MODEL_MAP</code>; an unmapped <code>claude-*</code> name is a 404 that says the router serves open models.</p>
          <Code label="Claude Code">{anthropicSetup}</Code>
          <p>Text, image, <code>tool_use</code> and <code>tool_result</code> blocks, <code>tools</code>, <code>tool_choice</code>, <code>stop_sequences</code>, <code>top_k</code> and <code>metadata.user_id</code> are converted; <code>max_tokens</code> above the model’s output limit is lowered to it. The resulting cap is always sent to the provider, and the hold for a call is priced at the prompt bound plus that cap; a call is charged its actual usage and never more than its hold. Tools hosted by Anthropic, thinking and <code>service_tier</code> are accepted and not acted on, and named in the <code>X-Trellis-Ignored</code> header; PDF documents, <code>mcp_servers</code> and <code>container</code> are refused with a 400. <code>POST /v1/messages/count_tokens</code> counts without a call and without a charge. The count is the router’s prompt bound, the figure a hold is priced at: the UTF-8 bytes of the text and tool schemas plus fixed template allowances, and for an image the per-image token limit the model declares (<code>input_token_limits</code> in <code>GET /v1/models</code>). It is an upper bound, several times a tokenizer’s count for English text. An image sent to a model that declares no limit is refused with a 400 (<code>unboundable_input</code>), on a count and on a call.</p>
          <Code label="Request and token count">{anthropicCall}</Code>
          <p>The reply’s <code>id</code> is the receipt id, repeated in the <code>X-Receipt-Id</code> and <code>Inference-Id</code> headers, and its <code>trellis</code> object carries the lane, the disclosure class, the provider, the cost and the signed receipt. <code>X-Trellis-Lane: attested</code> (or <code>ANTHROPIC_CUSTOM_HEADERS</code> in Claude Code) refuses anything but a verified enclave. Errors use Anthropic’s shape, with <code>billing_error</code> for an empty balance.</p>
        </section>

        <section id="ollama" className="docs-section">
          <h2>Ollama API</h2><NotAtLaunch />
          <p>The Ollama API is served under <code>/ollama</code> for Ollama clients: Open WebUI, Continue, the ollama libraries and LangChain's ChatOllama. Set the client's host (<code>OLLAMA_HOST</code>) to <code>https://&lt;router&gt;/ollama</code> and send the key as <code>Authorization: Bearer</code>. Chat, generate and embed calls run on the same keys, lanes and signed receipts as chat completions; <code>/api/tags</code>, <code>/api/show</code> and <code>/api/ps</code> read the catalog, and <code>/api/pull</code> answers as if the model were already present.</p>
          <Code label="Ollama host">{ollamaSetup}</Code>
          <p>Streams are <code>application/x-ndjson</code>: lines with <code>done</code> false, tool calls whole in one line, then a closing line with <code>done</code> true, <code>done_reason</code>, the counts and durations and a <code>trellis</code> object with the receipt id. Options map to the chat parameters where one exists (<code>num_predict</code> to <code>max_tokens</code>, <code>repeat_penalty</code> to <code>repetition_penalty</code>; with <code>num_predict</code> -1, -2 or absent the router still sends the provider an explicit cap, the model’s output limit); options that tune a local runtime are named in <code>X-Trellis-Ignored</code>. <code>X-Trellis-Lane: attested</code> works here as on every route.</p>
        </section>

        <section id="responses" className="docs-section">
          <h2>Responses API</h2><NotAtLaunch />
          <p><code>POST /v1/responses</code> (also <code>/api/v1/responses</code>) is the OpenAI Responses API, for the OpenAI Agents SDK, the Codex CLI and other Responses clients. It is an adapter over the chat route: keys, per-call payment, blind tokens, limits, lanes (<code>X-Trellis-Lane</code>) and signed receipts are the chat route’s own, and the answer comes back in the Responses shape, as a JSON body or as the Responses event stream.</p>
          <Code label="Agents SDK and Codex">{responsesSetup}</Code>
          <p>The route is stateless: nothing is stored, so store must be false (the default; <code>store: true</code> is refused), and <code>previous_response_id</code>, <code>conversation</code>, <code>background</code>, stored prompts and file or item references are refused with a 400 that names the field. Send the whole conversation in <code>input</code> on every request, including <code>function_call</code> and <code>function_call_output</code> items for tool round trips. Function tools and custom (freeform) tools run; hosted tools are refused, because Trellis hosts none. A custom tool such as Codex's <code>apply_patch</code> is offered to the model as a function with one string argument, <code>input</code>; a call to it comes back as a <code>custom_tool_call</code> item, and a <code>custom_tool_call_output</code> item is its result on the next turn. The tool's description and its grammar, if it has one, become the function's description as guidance only: nothing checks or enforces it.</p>
        </section>

        <section id="batches" className="docs-section">
          <h2>Batches</h2><NotAtLaunch />
          <p><code>POST /api/v1/batches</code> (also <code>/v1/batches</code>) takes many chat completion or embeddings requests in one call and runs them in the background on the router’s worker. A batch line costs what the same call costs: there is no batch discount by default (<code>BATCH_DISCOUNT_BPS</code> is 0, and a router refuses to start with a discount that no margin funds). It is the OpenAI Batch API shape without files: send the lines inline as <code>requests</code> or as <code>input_jsonl</code>, one request per line with a unique <code>custom_id</code>; <code>input_file_id</code> is refused, because there is no files endpoint. Needs a prepaid key. Every line’s prompt bound is checked before the batch is accepted: a line whose input cannot be bounded (an image for a model that declares no per-image token limit, a tool the provider runs itself) makes the whole batch a 400 that lists the line with code <code>unboundable_input</code>, and one that batches too many prompts with <code>prompt_batch_too_large</code>.</p>
          <Code label="Create a batch">{batchExample}</Code>
          <p><code>GET /api/v1/batches</code> lists batches, <code>GET /api/v1/batches/{"{id}"}</code> shows one, <code>POST /api/v1/batches/{"{id}"}/cancel</code> stops it, and <code>/output</code> and <code>/errors</code> return JSON Lines for 24 hours after the batch finishes (<code>410 batch_results_expired</code> afterwards). The request lines and answers are never written to the database: until the results expire they are kept sealed (AES-256-GCM) in Redis, or in the router's memory without Redis, and then deleted; the database keeps only counts, costs, statuses and generation ids. Each line is billed, limited by the key's budget and rate limits, routed by its lane and receipted as the call it is; a failed line is not charged, and lines not run within the 24-hour completion window expire unrun and are not charged.</p>
        </section>

        <section id="characters" className="docs-section">
          <h2>Characters</h2><NotAtLaunch />
          <p>A character is a Tavern card (V2 or V3, as JSON or a PNG that carries one) called as the model <code>@character/&lt;id&gt;</code>. <code>POST /api/v1/characters</code> creates one as <code>public</code>, <code>unlisted</code> (the default) or <code>private</code>; a private card is encrypted on the client with <code>sealCard</code> from <code>@trellis/client/characters</code>, and the router keeps only the ciphertext and its hash. <code>POST /api/v1/characters/{"{id}"}/chat</code> is a chat completion with the card as the prompt; the lane defaults to <code>attested</code> when the model has an attested provider, and budgets, rulebooks and signed receipts apply as on any call. <code>/greetings</code>, <code>/export</code>, <code>/usage</code> and <code>/characters/group/next</code> (turn order in a group) complete the set.</p>
          <Code label="SillyTavern">{characterSetup}</Code>
          <p>Memory (<code>/api/v1/memory</code>) is a ledger of summaries, facts, lorebook entries and state, encrypted on the client: the router stores ciphertext under a scope it cannot link to a character, and stores an embedding for search only with <code>embedding_opt_in: true</code>, because a vector derived from the text can leak its topic. Memory sent inline with a chat call is used for that call only and never stored. Creator attribution is counts and cost only.</p>
        </section>

        <section id="rag" className="docs-section">
          <h2>Files and retrieval</h2><NotAtLaunch />
          <p><code>POST /api/v1/rag</code> answers a question from documents sent with it, keeping nothing. The router cuts the documents into overlapping chunks, embeds the chunks and the question through <code>POST /api/v1/embeddings</code>, ranks the chunks by cosine similarity in memory and answers from the best <code>top_k</code> through <code>POST /api/v1/chat/completions</code>, citing numbered sources. Every step is an ordinary call of your key: billed, limited, routed by lane and receipted, and the response lists every receipt id with its lane. <code>POST /api/v1/rerank</code> orders passages against a query on its own. Needs a prepaid key.</p>
          <Code label="Ask over documents">{ragExample}</Code>
          <p>The <a className="inline-link" href="/ask/">Ask page</a> runs the same flow in the browser, reading PDFs locally before anything is sent.</p>
        </section>

        <section id="mcp" className="docs-section">
          <h2>MCP</h2><NotAtLaunch />
          <p><code>POST /mcp</code> is a remote Model Context Protocol server: one JSON-RPC 2.0 message per request (<code>initialize</code>, <code>ping</code>, <code>tools/list</code>, <code>tools/call</code>), replies as JSON, no sessions. Its tools are <code>list_models</code>, <code>list_attested_models</code>, <code>chat</code>, <code>verify_provider</code>, <code>get_receipt</code> and <code>verify_receipt</code>; only <code>chat</code> needs an API key, which it spends like a chat completion. <code>chat</code> takes <code>lane</code> (<code>public</code> or <code>attested</code>) and <code>disclosure</code>, and on the attested lane returns an error rather than a downgraded answer when no verified enclave can serve the model (nothing sent, nothing charged). With the <a href="#paid-tools">paid tools market</a> on, <code>trellis_tools_search</code> and <code>trellis_tools_call</code> are added.</p>
          <Code label="Claude Desktop, Cursor or any MCP client">{mcpConfig}</Code>
        </section>

        <section id="sdk" className="docs-section">
          <h2>SDKs</h2>
          <p>Every SDK speaks the same router API and surfaces the signed receipt of each call. None is published to a package registry yet; each installs from the repository's <code>sdks/</code> folder as its README shows.</p>
          <table>
            <thead><tr><th>Package</th><th>Language</th><th>Covers</th></tr></thead>
            <tbody>
              <tr><td><code>@trellis/sdk</code></td><td>TypeScript (ESM and CJS)</td><td>chat, streaming with the chunk chain, embeddings, rerank, batches, presets, models with lanes, receipts v1 and v2</td></tr>
              <tr><td><code>trellis</code></td><td>Python 3.10+ (sync and async)</td><td>the same surface; receipts verified with <code>cryptography</code></td></tr>
              <tr><td><code>trellis-go</code></td><td>Go 1.22+</td><td>chat, streaming, embeddings, rerank, batches, models, receipt verification</td></tr>
              <tr><td><code>@trellis/langchain</code>, <code>langchain-trellis</code></td><td>TypeScript, Python</td><td><code>ChatTrellis</code> and <code>TrellisEmbeddings</code>; receipt in <code>response_metadata</code></td></tr>
              <tr><td><code>llama-index-llms-trellis</code></td><td>Python</td><td><code>Trellis</code> LLM; <code>receipt_of(response)</code></td></tr>
            </tbody>
          </table>
          <p>Each reads <code>TRELLIS_BASE_URL</code> and <code>TRELLIS_API_KEY</code>, sends the lane as <code>X-Trellis-Lane</code> and <code>provider.lane</code> (never loosening a stricter lane already in the request), and turns the router’s <code>{"{ error: { code, message, type } }"}</code> into a typed error with <code>Retry-After</code>. The TypeScript SDK wraps <code>@trellis/client</code>, which holds the receipt, attestation, transparency-log and blind-token checks. The HTTP API is described in OpenAPI 3.1 at <a className="inline-link" href="/openapi.json">/openapi.json</a>.</p>
        </section>

        <RouteExplanationDocs />
        <WebhookDocs />

        <section id="tracing" className="docs-section">
          <h2>Tracing</h2><NotAtLaunch />
          <p>A key can send spans of its public-lane calls to your own observability backend: <code>PATCH /api/v1/keys/{"{hash}"}</code> with a <code>tracing</code> object of type <code>otlp</code> (any OpenTelemetry collector over OTLP/HTTP JSON), <code>langfuse</code> or <code>helicone</code>. Spans follow the OpenTelemetry GenAI semantic conventions and add <code>trellis.cost_usd</code>, <code>trellis.receipt_id</code>, <code>trellis.lane</code> and <code>trellis.provider</code>. Prompt and completion text is included only with <code>include_content: true</code>. Attested and unlinkable lane calls are never exported. The API keys tab in your account edits the same setting and shows the export count, failures and whether delivery is paused after repeated failures; the secret is write-only and never returned.</p>
          <Code label="Point a key at a collector">{tracingExample}</Code>
          <ul>
            <li>Honeycomb (OTLP): endpoint <code>https://api.honeycomb.io/v1/traces</code>, header <code>x-honeycomb-team</code>.</li>
            <li>Grafana Cloud Tempo (OTLP): the stack's OTLP endpoint with its basic-auth <code>Authorization</code> header.</li>
            <li>Langfuse: type <code>langfuse</code>, the host and the project's public and secret keys.</li>
            <li>Helicone: type <code>helicone</code> and the Helicone API key; spans arrive as Helicone requests.</li>
          </ul>
        </section>

        <section id="teams" className="docs-section">
          <h2>Teams</h2><NotAtLaunch />
          <p>A team is a pseudonymous organisation: an owner, members who join by passkey or wallet, roles (<code>owner</code>, <code>admin</code>, <code>dev</code>, <code>viewer</code>, <code>agent</code>), an organisation budget and a hash-chained audit log. <code>POST /api/v1/teams</code> creates one; <code>/invites</code> issues an invitation for a role, <code>/join/challenge</code> and <code>/join</code> let a member accept it, <code>/sign-in/challenge</code> and <code>/sign-in</code> mint a key for a member, and <code>/members/{"{hash}"}</code> and <code>/principals/{"{pid}"}</code> change or remove roles.</p>
          <p>Owner binding: <code>POST /api/v1/teams/{"{id}"}/owner/challenge</code> returns a one-time message for the wallet to sign, and <code>POST /api/v1/teams/{"{id}"}/owner</code> takes the base58 Solana address and the wallet's ed25519 signature over that message, which the router verifies against the address. The bound wallet then signs in as owner. A multisig vault cannot sign a message, so it is not bindable yet; the page labels an owner as <code>wallet</code> or <code>multisig</code> accordingly.</p>
          <p>The audit log (<code>GET /api/v1/teams/{"{id}"}/audit</code>) records every change with the previous entry's hash; <code>/audit/roots</code> publishes hourly roots and <code>/audit/export</code> returns the log as JSON Lines or CSV. Verify an export offline with <code>node scripts/verify-audit.mjs &lt;file&gt;</code>, which recomputes the chain and compares it with the roots.</p>
        </section>

        <ToolsMarketDocs />
        <DecisionTagDocs />
        <AgentRulebookDocs />
        <AgentRulebookClientDocs />
        <SpendingLimitsDocs /><DefaultRouteDocs /><StarterSetupsDocs /><AutoTopupDocs /><ReplayRulesDocs /><PlaybooksDocs /><RulebookWordsDocs />
        <AgentApprovalDocs />
        <ApproveAndAllowDocs />
        <AgentGuardDocs />
        <AgentPayDocs />
        <AgentBreakersDocs />
        <AgentAutonomyDocs />
        <StopUntilDocs />
        <AgentLedgerDocs />
        <AgentAlertDocs />
        <WeeklySummaryDocs />
        <AgentCertificateDocs />
        <AgentProfileDocs />
        <GraftedAgentDocs />
        <GraftNetworkDocs />
        <NetworkHostsDocs />
        <NetworkPolicyDocs />
        <NetworkPayoutDocs />
        <NetworkStatsDocs />
        <HostsDocs />
        <HostBondDocs />
        <HoldersDocs />

        <section id="run-a-provider" className="docs-section">
          <h2>Run a provider</h2><NotAtLaunch />
          <p>Most routers do not need a host of their own for the attested lane: an attested gateway serves it per token, with no hardware to rent (<a href="#lanes">Lanes</a>). Running a provider is the self-hosted path, for an operator who brings a confidential VM. A small CPU confidential VM with a tiny model is enough to exercise admission; a confidential GPU is only needed to serve a real model on your own host.</p>
          <p>A provider serves an open-weights model behind the Graft sidecar inside a confidential VM (Intel TDX, with the GPU in confidential-computing mode where the hardware supports it). At boot the sidecar hashes the served weights against an allow-list, generates its TLS, receipt and HPKE keys inside the enclave and produces a TDX quote whose report data binds those keys and the image, compose and model digests. The router verifies that quote with a fresh nonce before it routes an attested request to the host, and again on a schedule; the <a href="/status/#proof-time">proof-time panel</a> shows how recent each verification is.</p>
          <p>The install package in <code>deploy/graft/</code> has a one-command installer, a Compose file, a Helm chart and Terraform modules, and the <code>graft</code> CLI (<code>init</code>, <code>add-node</code>, <code>verify</code>, <code>status</code>) checks a node before it is registered. Registration on this router goes through the <a href="#network-host-signup">host signup</a> script with an operator wallet, under the <a href="#network-host-policy">host policy</a>; a <a href="#host-bonds">bond in USDC</a> backs the host’s answers. The approved build for early hosts is <code>deploy/network/approved/tdx-qwen2.5-0.5b</code>. The <a className="inline-link" href="/providers/">providers page</a> lists the hosts the router currently sees and what each one has proven.</p>
        </section>

        <section id="badge" className="docs-section">
          <h2>Attestation badge</h2><NotAtLaunch />
          <p><code>/badge.js</code> shows a provider's or a model's verification status on your own page. It reads the router's public records from the viewer's browser (the attestation record, its history and the catalog), checks that they agree and are current, and shows only what every check backs: <strong>Attested</strong>, <strong>Policy</strong>, <strong>Vendor-forwarded</strong> or <strong>Unverified</strong>, with the first characters of the verified measurement and the share of the last seven days with a fresh attestation. No dependencies, no cookies, no tracking. The hardware quote itself is verified by the router, not in the browser, and the badge says so.</p>
          <Code label="Embed">{badgeExample}</Code>
          <p><code>GET /api/v1/badge/{"{id}"}.svg</code> renders the same status as an image for an <code>&lt;img&gt;</code> tag or a Markdown image, with no script; an unknown id is still an image, reading Unverified.</p>
        </section>

        <DocsFeatureIndex />
      </article>
    </div>
  </main></PageFrame>;
}
