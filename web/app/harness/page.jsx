import PageFrame from '../../components/PageFrame';
import Harness from '../../components/Harness';
export const metadata={title:'Chat — Trellis',description:'Every model and the tools it supports on one page: streaming chat, reasoning, function tools, JSON output, attachments, compare mode and a signed receipt for every reply.'};
export default function HarnessPage(){return <PageFrame footer={false} header={false} app><Harness/></PageFrame>}
