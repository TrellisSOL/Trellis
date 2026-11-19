import PageFrame from '../components/PageFrame';
import { Button } from '../components/UI';

export const metadata = {title: 'Page not found — Trellis'};
export default function NotFound() {
  return <PageFrame><main className="page-main" id="content">
    <header className="page-title">
      <span className="eyebrow">404</span>
      <h1>Page not found</h1>
      <div className="button-row"><Button href="/">Trellis home</Button><Button href="/docs/" secondary>Documentation</Button></div>
    </header>
  </main></PageFrame>;
}
