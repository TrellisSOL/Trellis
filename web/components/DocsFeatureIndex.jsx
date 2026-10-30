const sections = [
  ["payments", "Payments on Solana"],
  ["tabs", "Pay by tab"],
  ["facilitator", "x402 facilitator"],
  ["host-bonds", "Host bonds"],
  ["holder-tiers", "Holder tiers"],
  ["early-access", "Early access to new models"],
  ["holder-votes", "Advisory holder votes"],
  ["unused-keys", "Review unused keys"], // B125
  ["proof-pack", "Proof pack"], // B122
  ["deposit-countdown", "Deposit countdown and credit notices"], // B123
  ["errors", "Similar models when a model is unavailable"], // B121
  ["stop-until", "Stop for a while"], // B117
  ["balance-runway", "Balance runway and alerts"], // B119
  ["spending-limits", "Spending limits"],
  ["default-route", "Default route"],
  ["lane-report", "Lane report"],
  ["starter-setups", "Starter setups"],
  ["auto-topup", "Auto top-up"],
  ["replay-rules", "Replay your rules"],
  ["playbooks", "Playbooks"],
  ["rulebook-words", "Rulebooks in plain English"], // B124
  ["agent-rulebook", "Agent rulebook"],
  ["agent-approvals", "Ask-first approvals"],
  ["approve-and-allow", "Allow this next time"], // B118
  ["agent-pay", "Pay another agent"],
  ["decision-tags", "Decision tags"],
  ["agent-breakers", "Circuit breakers"],
  ["agent-autonomy", "Progressive autonomy"],
  ["agent-ledger", "Activity & receipts"],
  ["agent-alerts", "Agent alerts"],
  ["weekly-summary", "Weekly Telegram summary"], // B120
  ["agent-certificates", "Track-record certificates"],
  ["agent-profiles", "Public profiles & directory"],
  ["sealed-agents", "Sealed agent hosting"],
  ["e2ee-gateway", "Encrypted chat"],
  ["network-host-signup", "Host signup"],
  ["network-host-policy", "Host policy"],
  ["network-payouts", "Host payouts"],
  ["network-stats", "Live network statistics"],
];

export function DocsFeatureLinks() {
  return sections.map(([id, label]) => <a key={id} href={`#${id}`}>{label}</a>);
}

export default function DocsFeatureIndex() {
  return <section id="whats-new">
    <h2>What’s new</h2>
    <p>Payments on Solana (prepaid credits, tabs and the x402 facilitator), host bonds, agent rules, Telegram linking and approvals, opt-in public profiles and encrypted chat are documented below. Sealed agent hosting is described, but no sealed agent is registered at trellis.example yet. USDC deposits and tabs are not switched on at trellis.example yet; the network is open for early hosts running the approved build.</p>
    <ul>{sections.map(([id, label]) => <li key={id}><a href={`#${id}`}>{label}</a></li>)}</ul>
  </section>;
}
