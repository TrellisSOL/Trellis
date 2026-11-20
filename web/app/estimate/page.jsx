import PriceCheck from '../../components/estimate/PriceCheck';
export const metadata={title:'Price check — Trellis',description:'Paste a prompt and see what it would cost on every model, and what the router would hold for it, before you call.'};
// Price check (update 13): a page of the account workspace. It shows "Coming soon" until the router has released the update.
export default function EstimatePage(){return <div className="trellis garden garden-app"><PriceCheck/></div>}
