import PageFrame from '../../components/PageFrame';
import ModelCatalog from '../../components/ModelCatalog';
export const metadata={title:'Models — Trellis'};
export default function Models(){return <PageFrame><main className="page-main" id="content"><div className="page-title" data-reveal><span className="eyebrow">Model explorer / Live catalog</span><h1>Find your next route.</h1><p>Search one catalog for models, prices and available paths. Call models from one balance and inspect their signed receipts.</p></div><div className="page-body catalog-body"><ModelCatalog/></div></main></PageFrame>}
