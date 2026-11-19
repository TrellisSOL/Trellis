import Dashboard from '../../components/Dashboard';
import { MotionManager } from '../../components/UI';
export const metadata={title:'Your account — Trellis'};
// The account dashboard as a workspace (components/account/AccountShell.jsx, `app`): its own bar, menus and dock,
// no site header.
export default function DashboardPage(){return <div className="trellis garden garden-app"><Dashboard/><MotionManager/></div>}
