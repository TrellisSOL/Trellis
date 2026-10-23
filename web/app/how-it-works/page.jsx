import PageFrame from '../../components/PageFrame';
import TaskMap from '../../components/nav/TaskMap';
import Stats from '../../components/Stats';
import FeatureGrid from '../../components/FeatureGrid';
import RouteModes from '../../components/RouteModes';
import HowItWorks from '../../components/HowItWorks';
import Accountability from '../../components/Accountability';
import Gateway from '../../components/Gateway';
import Privacy from '../../components/Privacy';
import {Roadmap,About,Developers} from '../../components/Extensions';
export const metadata={title:'How it works — Trellis'};
// The long-form tour that used to be the homepage: every tool, the route types, the rulebook, the network, the privacy
// routes and their limits, the roadmap. Sections outside the core launch surface hide themselves on a core router.
export default function HowItWorksPage(){return <PageFrame><main className="page-main" id="content"><div className="page-title" data-reveal><span className="eyebrow">How it works</span><h1>Everything Trellis does, and where it stops.</h1><p>The routes, the receipts, the balance, the agent rulebook, the host network and the privacy routes, with the limits of each.</p></div><TaskMap/><Stats/><FeatureGrid/><RouteModes/><HowItWorks/><Accountability/><Gateway/><Privacy/><Roadmap/><About/><Developers/></main></PageFrame>}
