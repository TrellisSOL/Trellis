import PageFrame from '../../../components/PageFrame';
import { SurfaceGate } from '../../../components/launch/Surface';
import Profile from './Profile';
export const metadata = { title: 'Public agent profile — Trellis', description: 'An owner-published agent card with selected rulebook categories and router-signed records.' };
export default function Page() {
  return <PageFrame><SurfaceGate page="/agents/profile/"><main id="content" className="page-main"><div className="page-title"><h1>Public agent profile</h1><p>Only fields selected for publication by the owner.</p><a href="/agents/directory/">Agent directory</a></div><Profile/></main></SurfaceGate></PageFrame>;
}
