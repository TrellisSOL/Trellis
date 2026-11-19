import PageFrame from '../../components/PageFrame';
import { SurfaceGate } from '../../components/launch/Surface';
import Agents from './Agents';

export const metadata = { title: 'Agents — Trellis', description: 'Give your agent a budget and a rulebook. Enforced by Trellis’s router for requests through Trellis.' };

export default function AgentsPage() {
  return <PageFrame><SurfaceGate page="/agents/"><main id="content" className="page-main">
    <div className="page-title"><h1>Agent spending rules</h1><p>Enforced by Trellis's router for requests through Trellis.</p></div>
    <Agents/>
  </main></SurfaceGate></PageFrame>;
}
