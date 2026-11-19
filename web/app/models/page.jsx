import PageFrame from '../../components/PageFrame';
import ModelCatalog from '../../components/ModelCatalog';
export const metadata={title:'Models — Trellis'};
export default function Models(){return <PageFrame><main className="page-main" id="content"><div className="page-title" data-reveal><h1>Model catalog</h1><p>Compare model capabilities, context limits and prices.</p></div><div className="page-body catalog-body"><ModelCatalog/></div></main></PageFrame>}
