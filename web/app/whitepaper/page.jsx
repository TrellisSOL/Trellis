import Publication from '../../components/Publication';

const summary = 'How Trellis routes a model request, collects a per-call payment on Solana, and gives the caller a signed record to inspect.';
export const metadata = {title: 'Inference, payments and receipts | Trellis whitepaper', description: summary};

const sections = [
  {id: 'abstract', heading: 'Abstract', body: <>
    <p>A model answer usually arrives through the same interface regardless of who served it, what it cost, or which systems saw the prompt. Those details matter when an application reconciles a bill or handles confidential material. Trellis brings the model catalog, payment terms and execution record into a single request flow.</p>
    <p>The caller chooses a model and reviews a price before authorizing payment. The router selects an eligible endpoint and signs a receipt for the call. A reader can check who signed that record and, once a proof exists, whether the record belongs to a published batch.</p>
  </>},
  {id: 'routing', heading: 'From model to endpoint', body: <>
    <p>A model ID names the requested model. An endpoint is a place that can serve it. Clients read the catalog for supported inputs, context length, pricing and available routes. A catalog entry describes an offer at the time of lookup. Endpoint availability can change before dispatch.</p>
    <p>The router filters candidates using the request requirements and available supply, then considers signals including price and uptime. On the public route, both the router and the selected inference service process the prompt. Applications handling confidential material should establish that the route meets their disclosure requirements before sending the request.</p>
  </>},
  {id: 'payment', heading: 'A quote for one call', body: <>
    <p>An unpaid chat request can return HTTP 402 with machine-readable payment terms. An x402 client checks the network, asset, amount, recipient and requested resource against its own spending policy. The payer authorizes the transaction and the client presents the signed payment with the matching request.</p>
    <p>For example, a research tool can cap the output length and ask for a quote on one short summary. The tool can decline the quote without paying. If the user approves it, the tool can retain the payment response and receipt ID together so a later reviewer can reconcile the wallet activity with the model call.</p>
    <p>Solana transfers expose transaction details, including account addresses and amounts. A public wallet address can link payments over time. Keep wallet signing credentials inside the wallet or signing service.</p>
  </>},
  {id: 'receipts', heading: 'What a receipt establishes', body: <>
    <p>The router signs the receipt with Ed25519. A verifier checks the signed bytes against the public key identified by the receipt. A changed claim fails the signature check. The signature establishes that the holder of that key made the claim. Assessing the answer’s accuracy or proving which hardware ran the model requires separate evidence.</p>
    <p>Trellis groups receipt hashes into a Merkle tree. An inclusion proof combines a receipt’s hash with sibling hashes to reconstruct the batch root. At launch, the anchor process publishes roots in Solana memos. Checking final publication requires verifying the transaction, its signer and the root on the expected network. A newly issued receipt may precede its batch anchor.</p>
    <p>For an expense review, keep the signed receipt, its key ID, and the payment reference. Check the signature first. When inclusion matters, check the proof and the finalized chain record as separate steps. <a className="inline-link" href="/verify/">Open the receipt verifier</a>.</p>
  </>},
  {id: 'privacy', heading: 'Disclosure and retention', body: <>
    <p>Transport encryption protects data in transit. The systems performing public-route inference can read the request. Model and route disclosures, the router’s accounting records and the inference service’s own retention practices each answer a different privacy question.</p>
    <p>Recovery also matters. A lost connection can leave the caller with a settled payment and no answer. Eligible non-streamed responses can be retained temporarily for wallet-authorized recovery. Review recovery limits before deciding what to send, and treat receipt IDs and payment references as shareable metadata. <a className="inline-link" href="/keep/">Read the data inventory</a>.</p>
  </>},
  {id: 'availability', heading: 'Launch scope', body: <>
    <p>The November launch supports public-route inference with per-call USDC payments. Prepaid balances, capped tabs, third-party settlement, sealed inference and program-based receipt roots have separate milestones. A client that requires a particular route should check current model supply and decline the call when its requirements cannot be met.</p>
    <p><a className="inline-link" href="/roadmap/">Read the roadmap</a> for the evidence that distinguishes each milestone.</p>
  </>},
];

export default function Whitepaper() {
  return <Publication title="Trellis whitepaper" summary={summary} sections={sections}/>;
}
