import PageFrame from '../../components/PageFrame';
import { SurfaceGate } from '../../components/launch/Surface';
import Agents from './Agents';

export const metadata = { title: 'Agents — Trellis', description: 'Give your agent a budget and a rulebook. Enforced by Trellis’s router for requests through Trellis.' };

export default function AgentsPage() {
  return <PageFrame><SurfaceGate page="/agents/"><main id="content" className="page-main">
    <div className="page-title"><span className="eyebrow">Agent rulebooks</span><h1>Give your agent a budget and a rulebook.</h1><p>Enforced by Trellis's router for requests through Trellis.</p></div>
    <Agents/>
  </main></SurfaceGate></PageFrame>;
}
