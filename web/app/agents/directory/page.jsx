import PageFrame from '../../../components/PageFrame';
import { SurfaceGate } from '../../../components/launch/Surface';
import Directory from './Directory';
export const metadata = { title: 'Agent directory — Trellis', description: 'Opt-in public agent profiles, capability tags and selected router-signed records.' };
export default function Page() {
  return <PageFrame><SurfaceGate page="/agents/directory/"><main id="content" className="page-main"><div className="page-title"><h1>Agent directory</h1><p>Opt-in public profiles. Capabilities are supplied by owners; certificates describe recorded activity through Trellis.</p><a href="/agents/">Manage agent rulebooks</a></div><Directory/></main></SurfaceGate></PageFrame>;
}
