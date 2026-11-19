import PageFrame from '../../../components/PageFrame';
export const metadata={title:'Terms (draft) — Trellis'};
// DRAFT placeholder. Terms are planned before any public deposit is accepted. No fee numbers, no promises, no guarantees.
export default function Terms(){return <PageFrame><main className="page-main" id="content">
  <div className="page-title" data-reveal><h1>Terms of service (draft)</h1><p>This page is a placeholder. It is not a contract, an offer or a guarantee, and nothing on it is binding. The documentation describes how Trellis works today; pricing, refund rules and features can change.</p></div>
  <div className="side-layout">
    <nav className="side-nav" aria-label="Legal pages" data-reveal="fade"><span className="side-nav-label">Legal</span><a href="/legal/privacy/">Privacy notice (draft)</a><a href="/legal/terms/" aria-current="page">Terms (draft)</a><a href="/keep/">What we keep</a></nav>
    <article className="page-body prose legal-body" data-reveal>
      <div className="note"><strong>Draft.</strong> Terms of service are planned for this page before Trellis accepts any public deposit. Until then the service is a preview, no deposits are accepted and no commercial terms are offered.</div>
      <h2>What published terms are planned to cover</h2>
      <ul>
        <li><strong>Operator entity.</strong> The legal entity that operates the router, where it is established and how to contact it.</li>
        <li><strong>Scope of the service.</strong> What Trellis does (routes requests to third-party model providers and accounts for them in USDC on Solana) and what it does not do.</li>
        <li><strong>Deposits and balances.</strong> How a prepaid balance is funded, how it is spent, and what happens to an unspent balance.</li>
        <li><strong>Refund rules.</strong> When a failed, cut-off or rerouted call is refunded, following the refund rules (current policy) in the documentation, which describe current behaviour and can change, and how a refund is evidenced by a signed receipt.</li>
        <li><strong>Dispute process.</strong> How to raise a billing or service dispute, how long a reply takes and what records are used to settle it.</li>
        <li><strong>Acceptable use.</strong> Provider policies that pass through to users, prohibited uses and sanctions screening.</li>
        <li><strong>Changes and termination.</strong> How terms change, how notice is given and how an account is closed.</li>
        <li><strong>Liability and governing law.</strong> To be drafted with counsel.</li>
      </ul>
      <h2>References</h2>
      <p>References to Solana, model authors and other services identify compatibility and the network used. They do not imply endorsement or partnership.</p>
      {/* TODO(solana): replace this placeholder with the published terms before public deposits open. */}
      <a className="inline-link" href="/">Return to Trellis →</a>
    </article>
  </div>
</main></PageFrame>}
