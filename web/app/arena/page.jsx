import PageFrame from '../../components/PageFrame';
import { SurfaceGate } from '../../components/launch/Surface';
import Arena from '../../components/Arena';
export const metadata={title:'Model Arena — Trellis',description:'Race one prompt across two to four models, live: time to first token, total time, cost and a signed receipt for every answer.'};
export default function ArenaPage(){return <PageFrame><SurfaceGate page="/arena/"><main id="content"><Arena/></main></SurfaceGate></PageFrame>}
