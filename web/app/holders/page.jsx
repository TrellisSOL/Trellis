import PageFrame from '../../components/PageFrame';
import Holders from './Holders';

export const metadata = {
  title: 'Holder tiers — Trellis',
  description: 'Membership levels for $TRLS holders: fixed thresholds that give access and priority. No tier changes a price.',
};

export default function HoldersPage() {
  return <PageFrame><main className="page-main" id="content">
    <div className="page-title" data-reveal>
      <span className="eyebrow">$TRLS / MEMBERSHIP LEVELS</span>
      <h1>Holder tiers.</h1>
      <p>A tier is a membership level with a fixed threshold. It gives access and priority: higher limits, a place in the sealed-lane queue, earlier access to newly listed models, an advisory vote, credits that do not expire while the wallet holds the tier, and an optional profile badge. No tier changes a price: every caller pays the host’s price. This page shows what the router returns today, and it can change.</p>
    </div>
    <div className="page-body"><Holders /></div>
  </main></PageFrame>;
}
