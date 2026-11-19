import PageFrame from '../../components/PageFrame';
import RouteModes from '../../components/RouteModes';
import Gateway from '../../components/Gateway';
import Privacy from '../../components/Privacy';
import TaskMap from '../../components/nav/TaskMap';
import ReferenceAnchors from '../../components/ReferenceAnchors';
import s from './tour.module.css';

export const metadata = {
  title: 'How it works — Trellis',
  description: 'Follow a model request from route selection and payment to its signed receipt.',
};

export default function HowItWorksPage() {
  return <PageFrame><main className={`page-main ${s.tour}`} id="content" data-reference-groups>
    <header className="page-title" id="about">
      <h1>How a call works</h1>
      <p>Trellis routes a model request, quotes the payment in USDC and signs a record of the call.</p>
    </header>
    <ol className={s.steps} id="how-it-works">
      <li><h2>Choose a route</h2><p>Start with a model ID. The router considers eligible endpoints and the routing preferences in your request.</p><a href="/models/">Model catalog</a></li>
      <li><h2>Approve the quote</h2><p>An unpaid request returns HTTP 402. Review the network, recipient and amount before your wallet signs.</p><a href="/docs/#quickstart">Request a quote</a></li>
      <li><h2>Check the receipt</h2><p>Use the receipt ID to check the router’s signature. An inclusion proof can tie the record to its hourly batch.</p><a href="/verify/">Receipt verifier</a></li>
    </ol>
    <RouteModes/>
    <div className={s.more}>
      <details><summary>What the router and provider can see</summary><Privacy/></details>
      <details data-surface-extra=""><summary>Explore agent key settings</summary><Gateway/></details>
      <details id="features"><summary>Browse tools by task</summary><TaskMap/></details>
    </div>
    <nav className={s.reading} aria-label="Further reading">
      <a id="accountability" href="/trust/">Trust center</a>
      <a id="developers" href="/docs/">Developer guide</a>
      <a id="roadmap" href="/roadmap/">Product roadmap</a>
    </nav>
    <ReferenceAnchors/>
  </main></PageFrame>;
}
