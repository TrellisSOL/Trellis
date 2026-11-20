import PageFrame from '../../components/PageFrame';
import Burns from './Burns';

export const metadata = {
  title: '$TRLS burned — Trellis',
  description: 'The $TRLS burned for inference on this router: the total, each recent burn with its Solana transaction, and the total over time.',
};

export default function BurnPage() {
  return <PageFrame><main className="page-main" id="content">
    <div className="page-title" data-reveal>
      <h1>$TRLS burned</h1>
      <p>$TRLS paid for inference is burned. This page reads the router’s own record of those burns: the total so far, each recent burn with a link to its Solana transaction, and how the total has grown by day.</p>
    </div>
    <div className="page-body"><Burns /></div>
  </main></PageFrame>;
}
