import PageFrame from '../../../components/PageFrame';
export const metadata={title:'Privacy notice (draft) — Trellis'};
// DRAFT placeholder. A privacy notice is planned before any public deposit is accepted. The data inventory at /keep/ is the current factual record. No promises, no guarantees.
export default function Privacy(){return <PageFrame><main className="page-main" id="content">
  <div className="page-title" data-reveal><h1>Privacy notice (draft)</h1><p>This page is a placeholder, not a notice, an offer or a guarantee. A published notice is planned to replace it before any public deposit is accepted.</p></div>
  <div className="side-layout">
    <nav className="side-nav" aria-label="Legal pages" data-reveal="fade"><span className="side-nav-label">Legal</span><a href="/legal/privacy/" aria-current="page">Privacy notice (draft)</a><a href="/legal/terms/">Terms (draft)</a><a href="/keep/">What we keep</a></nav>
    <article className="page-body prose legal-body" data-reveal>
      <div className="note"><strong>Draft.</strong> A privacy notice is planned for this page before Trellis accepts any public deposit. Until then, the <a className="inline-link" href="/keep/">data inventory</a> is the factual description of what the router stores and reads: the router does not store prompt or output text; request logs keep hashes, sizes, timing buckets and cost.</div>
      <h2>What a published notice is planned to cover</h2>
      <ul>
        <li><strong>Operator entity.</strong> Who is responsible for the data and how to reach them.</li>
        <li><strong>What is stored.</strong> The records the router keeps to route and account for calls, by category, as listed in the data inventory.</li>
        <li><strong>Where prompts go.</strong> Which provider serves each call and under which provider policy; what the attested and unlinkable lanes change.</li>
        <li><strong>Retention.</strong> How long each category of record is kept and why.</li>
        <li><strong>Deletion process.</strong> How to ask for records to be removed, what can be removed and how long it takes.</li>
        <li><strong>Public records.</strong> Which facts (deposits, receipt anchors) are written to Solana and cannot be withdrawn.</li>
        <li><strong>Your controls.</strong> Signing out of a browser, exports and the dashboard settings that affect what is kept.</li>
        <li><strong>Dispute and complaint process.</strong> How to raise a privacy concern and how it is handled.</li>
      </ul>
      {/* TODO(solana): replace this placeholder with the published privacy notice before public deposits open. */}
      <a className="inline-link" href="/dashboard/#settings">Open workspace settings →</a>
    </article>
  </div>
</main></PageFrame>}
