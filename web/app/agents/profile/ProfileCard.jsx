'use client';
import ProofBadge from '../../../components/ProofBadge';
import { PROFILE_SUMMARY, bpsPercent, livenessLine, profileLink, reputationLine, safeHomepage } from '../../../lib/agent-profiles';
import { holderBadge } from '../../../lib/holders';
export default function ProfileCard({ card, detail = false }) {
  const homepage = safeHomepage(card.homepage);
  const live = livenessLine(card.trellis.liveness), reputation = reputationLine(card.trellis.reputation);
  const identity = card.trellis.identity, record = card.trellis.track_record;
  const badge = holderBadge(card);
  return <article className="control-panel" style={{ overflowWrap: "anywhere" }}>
    <h2>{detail ? card.name : <a href={profileLink(card)}>{card.name}</a>}</h2><p>{card.description}</p>
    {badge && <p data-holder-badge={card.trellis.holder_badge}><strong>{badge}</strong> · <a href="/holders/">a membership level the owner chose to show</a></p>}
    {(live || reputation) && <p data-live={live?.state}>{live && <strong>{live.text}</strong>}{live && reputation && <br/>}{reputation && <span>{reputation.text}</span>}</p>}
    <p>Capabilities supplied by the owner: {card.capabilities.join(', ') || 'None listed'}</p>
    {homepage && <p style={{ overflowWrap: "anywhere" }}>Owner’s homepage: {homepage}</p>}
    {card.payout_wallet && <p style={{ overflowWrap: "anywhere" }}>Wallet for payments, supplied by the owner (USDC on Solana): {card.payout_wallet}</p>}
    <ul>{Object.entries(card.trellis.rulebook_summary).map(([key, value]) => <li key={key}>{PROFILE_SUMMARY[key] || key}: {value ? 'Yes' : 'No'}</li>)}</ul>
    <ProofBadge evidence={{ source: "profile", data: card.trellis }} explain /><p>Sealed hosting: {card.trellis.status.sealed}.</p>
    <h3>Valid track-record certificates</h3><a href="/verify/#proof-certificates">How to check certificates →</a>
    {!card.trellis.certificates.length && <p>No currently valid certificate published.</p>}
    {card.trellis.certificates.map(c => <section key={c.payload.pseudonym}><p>{c.payload.claims.join(', ')}<br/>Expires: <time dateTime={c.payload.expires_at}>{c.payload.expires_at}</time></p><p>{c.payload.notice}</p>{detail && <details><summary>Signed certificate JSON</summary><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{JSON.stringify((({ valid, ...certificate }) => certificate)(c), null, 2)}</pre></details>}</section>)}
    {detail && identity && !identity.opted_out && <section><h3>Identity links</h3><ul>
      <li><a href={identity.card}>Card JSON</a></li>
      <li><a href={identity.receipt_keys}>Receipt keys</a> (current key {identity.receipt_key_id})</li>
    </ul></section>}
    {detail && card.trellis.liveness?.receipt && <details><summary>Signed liveness probe receipt</summary><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{JSON.stringify(card.trellis.liveness.receipt, null, 2)}</pre></details>}
    <p className="help-text">{card.trellis.notice}</p>
  </article>;
}
