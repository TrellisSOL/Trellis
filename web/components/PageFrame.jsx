import {Header,MotionManager} from './UI';
import Footer from './Footer';

export default function PageFrame({children,footer=true,app=false,header=true}){return <div className="trellis garden garden-interior">{header?<Header app={app}/>:<a className="skip" href="#harness-input">Skip to the message box</a>}{children}{footer&&<Footer/>}<MotionManager/></div>}
