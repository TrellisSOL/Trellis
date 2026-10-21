import PageFrame from '../../../components/PageFrame';
import { SurfaceGate } from '../../../components/launch/Surface';
import Webhooks from '../../../components/account/Webhooks';
export const metadata = { title: 'Webhooks — Trellis', description: 'Inspect account event destinations and signing availability.' };
export default function Page() { return <PageFrame><SurfaceGate page="/dashboard/webhooks/"><main id="content" className="page-main"><div className="page-title"><h1>Webhooks</h1><p>Send account event notices to your HTTPS endpoint where signing is enabled.</p></div><Webhooks/></main></SurfaceGate></PageFrame>; }
