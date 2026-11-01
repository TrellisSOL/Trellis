import { NotAtLaunch } from "./LaunchSurfaceDocs";
const SETTINGS = [
  ["NETWORK_PAYOUTS_ENABLED", "false", "Needs sanctions screening, host anchoring and a settlement worker signer when switched on."],
  ["NETWORK_FEE_BPS", "0", "Bounded to 0–2000. The configured percentage is shown at runtime."],
];

export default function NetworkPayoutDocs() {
  return <section id="network-payouts"><h2>Network host payments</h2><NotAtLaunch />
    <p>Payouts are not switched on at trellis.example yet. No payouts are being made.</p>
    <h3>How payouts work</h3>
    <p>When enabled, hosts are paid per token served only from receipts included in their confirmed per-host roots. Weekly USDC payments are made at the host’s full price: the network fee is 0 (zero markup). Accrual is switched off by default; runtime availability is reported by <code>network.payouts_open</code> in <code>GET /api/v1/status</code>.</p>
    <h3>Settings</h3>
    <table className="docs-table">
      <thead><tr><th>Setting</th><th>Default</th><th>Notes</th></tr></thead>
      <tbody>{SETTINGS.map(([name, value, note]) => <tr key={name}><td><code>{name}</code></td><td>{value}</td><td>{note}</td></tr>)}</tbody>
    </table>
    <p>Unresolved or reverted payouts require operator reconciliation.</p>
  </section>;
}
