import PageFrame from '../components/PageFrame';
import Hero from '../components/Hero';
import Landing from '../components/Landing';
// The homepage stays short: the hero and five quiet sections. Everything the old long page said lives on /how-it-works/.
export default function Home(){return <PageFrame><main id="content"><Hero/><Landing/></main></PageFrame>}
