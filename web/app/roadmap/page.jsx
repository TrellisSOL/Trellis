import Publication from '../../components/Publication';

const summary = 'Per-call payments and signed receipts are live. Next come new ways to fund requests and verify where a model ran.';
export const metadata = {title: 'Product roadmap | Trellis', description: summary};
const sections = [
  {id: 'launch', heading: 'Available at launch', body: <>
    <p>Discover models and prices in the catalog, request an x402 quote for a chat call, and authorize a per-call USDC payment on Solana. A signed receipt can be checked with the router’s published keys. The launch uses memo transactions for receipt roots.</p>
    <p><a className="inline-link" href="/docs/#quickstart">Try the quote walkthrough</a> or <a className="inline-link" href="/models/">browse the catalog</a>.</p>
  </>},
  {id: 'credits', group: 'Planned milestones', heading: 'Prepaid credits', body: <p>Fund repeated calls from a single deposit. A caller should be able to trace a deposit into the balance, reconcile each charge and verify that an eligible closure refund reaches the depositing wallet.</p>},
  {id: 'tabs', heading: 'Capped tabs', body: <p>Authorize a maximum spend for a session. Individual calls would draw against that ceiling using signed vouchers. The user should be able to inspect cumulative usage, close the tab and account for the unused amount.</p>},
  {id: 'facilitator', heading: 'Seller payments', body: <p>Let another seller use Trellis to verify and settle an x402 payment. Verification and settlement are distinct steps. A seller should be able to identify the accepted terms and reconcile the settled transfer before fulfilling an order.</p>},
  {id: 'sealed', heading: 'Sealed inference', body: <p>Offer eligible models on hardware with verifiable attestation. The milestone requires actual model supply, a checked measurement and evidence tied to the request. Applications must be able to refuse an ordinary public route when their policy requires sealed inference.</p>},
  {id: 'roots', heading: 'On-chain receipt roots', body: <p>Make each hourly root readable from a dedicated program account. A verifier should be able to locate the root for a receipt’s hour and compare the inclusion proof with finalized program state. Historical memo proofs retain their original verification method.</p>},
  {id: 'availability', heading: 'Checking availability', body: <p>The status response lists enabled payment modes and how receipt roots are published. Check the model catalog for route availability. <a className="inline-link" href="/api/v1/status">Inspect the status response</a>.</p>},
];
export default function Roadmap() {
  return <Publication kind="roadmap" title="Roadmap" summary={summary} sections={sections}/>;
}
