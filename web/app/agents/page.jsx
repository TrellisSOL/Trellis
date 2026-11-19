import PageFrame from '../../components/PageFrame';
import Agents from './Agents';

export const metadata = { title: 'Agents — Trellis', description: 'Give your agent a budget and a rulebook. Enforced by Trellis’s router for requests through Trellis.' };

export default function AgentsPage() {
  // On the core launch surface with the agent keys update released. Where the router has not released it, the page says
  // so once a key is connected (its routes answer 404 not_enabled); it asks for nothing a core router does not serve.
  return <PageFrame><main id="content" className="page-main">
    <div className="page-title"><h1>Agent spending rules</h1><p>Enforced by Trellis's router for requests through Trellis.</p></div>
    <Agents/>
  </main></PageFrame>;
}
