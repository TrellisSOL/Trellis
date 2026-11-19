import PageFrame from '../../components/PageFrame';
import CostEstimator from '../../components/CostEstimator';

export const metadata = { title: 'Estimate model costs — Trellis', description: 'Compare input, output, per-request and monthly costs using the live model catalogue. Estimate tokens in your browser before signing in.' };
export default function CostPage() {
  return <PageFrame><main className="page-main" id="content">
    <div className="page-title"><h1>Cost estimator</h1><p>Compare the cost of one request or a month of usage.</p></div>
    <div className="page-body catalog-body"><CostEstimator /></div>
  </main></PageFrame>;
}
