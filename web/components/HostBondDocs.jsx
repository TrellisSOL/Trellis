// Host bonds (docs/Trellis_Backend.md §5.3): what a host posts, how it is slashed and how it comes back. The
// trellis_bond program's instructions are named so an operator can post from a wallet or script; this site moves no funds.
import { NotAtLaunch } from "./LaunchSurfaceDocs";
const SLASHES = [
  ["Empty-200 answers above 2% over 24 hours", "1%"],
  ["Quantization swap (3 of 3 canaries)", "25% and delisting"],
  ["Uptime below 95% over 30 days", "0.5% per day"],
  ["Shadow re-execution mismatch", "50% and ejection"],
  ["SEALED served without a fresh attestation", "5% per incident"],
  ["Capacity commitment under-delivered", "the purchase price of the unserved Bushels"],
];
export const BOND_INSTRUCTIONS = [
  ["post_bond(amount)", "moves USDC from the host's token account into the bond vault; the first post needs at least 10,000 USDC."],
  ["request_unbond()", "starts the 14-day unbond period; the host keeps serving and stays slashable until it ends."],
  ["cancel_unbond()", "withdraws the request and keeps the bond active."],
  ["withdraw_bond()", "returns the bond after the unbond period, less any slash executed in the meantime and less what is locked behind open capacity commitments. It is refused while a slash proposal is open."],
  ["propose_slash / dispute / resolve_dispute", "the slasher key named in the program's config proposes a slash with evidence; a 72-hour public window lets the host dispute; a dispute blocks execution until the program's authority resolves it or 7 days pass."],
  ["execute_slash()", "anyone can send it once a proposal is executable, with one exception: a slash that the 30-day cap would cut is executed by the slasher key only, so nobody can run it at the moment it takes least. Funds move only to the configured payout accounts."],
  ["propose_reinstate / resolve_reinstate", "the program's authority proposes to list a delisted or ejected host again and applies it no sooner than 24 hours later; a slash executed in between makes the proposal stale."],
];
export default function HostBondDocs() {
  return <section id="host-bonds" className="docs-section"><h2>Host bonds</h2><NotAtLaunch />
    <p>A Graft host on SEALED or BLIND posts a USDC bond in the <code>trellis_bond</code> program: <code>HostBond{"{host, amount ≥ 10,000 USDC, unbond_at, strikes}"}</code>. An attested gateway, the other kind of supply on those lanes (<a href="/docs/#lanes">Lanes</a>), posts no bond: it is held to its attestation and its signed receipts, and one that fails attestation is dropped from the lane. The bond is what makes a wrong answer cost the host more than the call paid: slashes refund the affected callers first, and the rest goes to the treasury.</p>
    <table><thead><tr><th>Evidence</th><th>Slash</th></tr></thead><tbody>{SLASHES.map(([what, how]) => <tr key={what}><td>{what}</td><td>{how}</td></tr>)}</tbody></table>
    <p>A slash is proposed by the slasher key and can be executed after a 72-hour public dispute window. A dispute filed inside the window blocks execution until the program's authority resolves it or 7 days pass, whichever comes first. One proposal takes at most 50% of a bond, and all rate-based slashes of one bond within 30 days take at most 50% of it together; what that cap cuts off is not carried over. A slash the cap cuts to nothing neither delists nor ejects the host. Delisting and ejection are lifted only by the program's authority, through a proposal that waits 24 hours on chain. Unbonding takes 14 days. A capacity commitment locks its value in the bond, at the grade price of the moment the host made it, until its claims are paid or expired, and that part cannot be withdrawn. Claims for a commitment that fell short are paid out of that lock: together they never exceed what the host locked for it, whatever the grade prices are changed to afterwards.</p>
    <h3 id="host-bond-governance">Who can change what</h3>
    <p>The program's authority is a single operator key until it is handed to one Squads 2-of-3 multisig. A guardian key, separate from both, can pause new bonds and nothing else: it cannot unpause, cancel a proposed change or move funds, and a pause lapses after 72 hours unless the authority renews it. <code>request_unbond</code> and <code>withdraw_bond</code> cannot be paused. Loosening a setting, replacing a role key or a payout account, or handing over the authority takes effect only after a 24-hour delay on chain, with the new authority accepting; tightening is immediate. The delays have floors compiled into the program: the dispute window is at least 72 hours, a dispute blocks for at least 7 days and unbonding takes at least 14 days. The programs are unaudited.</p>
    <h3>Instructions</h3>
    <dl>{BOND_INSTRUCTIONS.map(([name, what]) => <div key={name}><dt><code>{name}</code></dt><dd>{what}</dd></div>)}</dl>
    <p>Posting a bond is done from the operator's own wallet or a script against the program (the program id is in <code>GET /api/v1/status</code> under <code>chain.programs.bond</code>); this site shows bond state and moves no funds. The <a className="inline-link" href="/hosts/">host record</a> lists the bond beside the attestation and uptime evidence.</p>
  </section>;
}
/** The bond line on a host record: what the router reports, or that it reports nothing. */
export function HostBondNote({ bond }) {
  const amount = bond?.amount_usdc ?? bond?.amount ?? null;
  return <section><h3>Bond</h3>
    {amount != null ? <p className="number">{amount} USDC</p> : <p>No bond recorded for this host.</p>}
    {bond?.unbond_at && <p>Unbonding; withdrawable from {new Date(bond.unbond_at).toLocaleDateString('en-GB')}.</p>}
    {bond?.strikes != null && <p>Strikes: {bond.strikes}.</p>}
    <p>Hosts post a USDC bond in the <code>trellis_bond</code> program and are slashed for empty answers, quantization swaps, downtime and unattested SEALED service. <a href="/docs/#host-bonds">Read the bond rules and instructions →</a></p>
  </section>;
}
