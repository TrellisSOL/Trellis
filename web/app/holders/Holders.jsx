'use client';
import { useCallback, useEffect, useState } from 'react';
import { api, clearKey, loadKey, saveKey } from '../../lib/api';
import { CAN_CHANGE, ME_PATH, NOT_ON, POLLS_PATH, TIERS_PATH, TIER_COLUMNS, formatAmount, nextTierLine, perkLines, pollOpen, pollRows, pollSummary, tierRows, tierStatus, tiersOn, voteErrorMessage, voteReceipt, voteRequest } from '../../lib/holders';
import { hasWallet, shortAddress, walletApiKey, walletSigner } from '../../lib/wallet';
import { Button } from '../../components/UI';
import { extraAttr, isNotEnabled } from '../../lib/launch-surface.js';
import { Problem, usePart } from '../../components/launch/Surface';

const PERKS = [
  ['Higher limits', 'More requests and tokens per minute, and more agent keys, saved routes and batch rows.'],
  ['Sealed-lane priority', 'An earlier place in the queue when a sealed host is full, and in Bushel purchase ordering. A share of capacity is kept for everyone else.'],
  ['Early access', 'A newly listed model can open to tiers first, inside a window of up to 48 hours. Higher tiers get in earlier.'],
  ['Advisory votes', 'One vote per wallet on which models get listed and on slashing rules, with a fixed weight per tier.'],
  ['Credits that do not expire', 'Credits are left in place while the wallet holds a tier that has this perk.'],
  ['Profile badge', 'An opt-in badge with the tier’s name on a public agent profile. Off until you switch it on.'],
];

function TierTable({ doc }) {
  const rows = tierRows(doc);
  return <div className="table-wrap"><table className="data-table">
    <thead><tr><th>Tier</th>{TIER_COLUMNS.map(c => <th key={c.key}>{c.label}</th>)}</tr></thead>
    <tbody>{rows.map((row, i) => <tr key={row.name} style={{ '--i': i }}>
      <td data-label="Tier"><strong>{row.name}</strong></td>
      {TIER_COLUMNS.map(c => <td key={c.key} data-label={c.label}>{row.cells[c.key]}</td>)}
    </tr>)}</tbody>
  </table></div>;
}

function YourTier({ enabled }) {
  const [key, setKey] = useState('');
  const [me, setMe] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [wallet, setWallet] = useState(false);
  const read = useCallback(async secret => {
    setBusy(true); setError('');
    try { setMe((await api(ME_PATH, { key: secret })).data); }
    catch (e) { setMe(null); setError(e.status === 401 ? 'This key was not accepted. Sign in again.' : e.message); if (e.status === 401) { clearKey(); setKey(''); } }
    finally { setBusy(false); }
  }, []);
  useEffect(() => {
    setWallet(hasWallet());
    const saved = loadKey();
    if (saved) { setKey(saved); read(saved); }
  }, [read]);
  const signIn = async () => {
    setBusy(true); setError('');
    try { const secret = await walletApiKey('Wallet key'); saveKey(secret); setKey(secret); await read(secret); }
    catch (e) { setError(e.message); setBusy(false); }
  };
  const status = tierStatus(key ? me : null);
  const next = nextTierLine(me);
  return <section className="control-panel" id="your-tier" aria-labelledby="your-tier-title">
    <h2 id="your-tier-title" style={{ marginTop: 0 }}>Your tier</h2>
    {error && <p className="error" role="alert">{error}</p>}
    {busy && !me && <p role="status">Reading your tier…</p>}
    {(!busy || me) && <p data-tier-state={status.state}><strong>{status.text}</strong></p>}
    {me?.wallet && <dl className="detail-list">
      <div><dt>Wallet</dt><dd title={me.wallet}>{shortAddress(me.wallet)}</dd></div>
      {me.balance != null && <div><dt>Balance</dt><dd>{formatAmount(me.balance)} ${me.token?.symbol || 'TRLS'}</dd></div>}
      {me.tier && <div><dt>Tier</dt><dd>{me.tier.name} (from {formatAmount(me.tier.min)} ${me.token?.symbol || 'TRLS'})</dd></div>}
    </dl>}
    {next && <p>{next}</p>}
    {me && enabled && <><h3>What applies to this key now</h3><ul>{perkLines(me.perks).map(line => <li key={line}>{line}</li>)}</ul></>}
    <div className="button-row">
      {(!key || status.state === 'no-wallet') && <Button disabled={busy} onClick={signIn}>{wallet ? 'Sign in with Solana wallet' : 'Sign in with wallet'}</Button>}
      {key && <Button secondary disabled={busy} onClick={() => read(key)}>{busy ? 'Reading…' : 'Read again'}</Button>}
    </div>
    <p className="help-text">Signing in asks your wallet to sign one message and returns that wallet’s API key, kept in this browser tab. Nothing is sent on chain and nothing is charged. The balance is read from the wallet’s token account and cached for about an hour, so a change can take that long to show. The tier is the highest threshold the balance reaches; holding more inside a tier adds nothing.</p>
  </section>;
}

function Poll({ poll, onVoted }) {
  const [choice, setChoice] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  const open = pollOpen(poll);
  const vote = async e => {
    e.preventDefault();
    if (!choice) return;
    setBusy(true); setError(''); setDone('');
    try {
      const signer = await walletSigner();
      const req = await voteRequest(signer, poll.id, choice);
      const { data } = await api(req.path, { method: 'POST', body: req.body, headers: req.headers });
      setDone(voteReceipt(data));
      onVoted?.();
    } catch (e) { setError(voteErrorMessage(e)); }
    finally { setBusy(false); }
  };
  const rows = pollRows(poll);
  return <article className="control-panel" style={{ marginBottom: 20, overflowWrap: 'anywhere' }}>
    <h3 style={{ marginTop: 0 }}>{poll.title}</h3>
    <p className="help-text">{pollSummary(poll)}</p>
    <div className="table-wrap"><table className="data-table">
      <thead><tr><th>Option</th><th className="num">Votes</th><th className="num">Weight</th><th className="num">Share of weight</th></tr></thead>
      <tbody>{rows.map(r => <tr key={r.option}><td data-label="Option"><strong>{r.option}</strong></td><td className="num" data-label="Votes">{r.votes}</td><td className="num" data-label="Weight">{r.weight}</td><td className="num" data-label="Share of weight">{r.pct}%</td></tr>)}</tbody>
    </table></div>
    {open && <form onSubmit={vote}>
      <fieldset disabled={busy} style={{ border: 0, padding: 0, margin: '16px 0' }}><legend className="sr-only">Your vote</legend>
        {poll.options.map(option => <label key={option} style={{ display: 'block', margin: '6px 0' }}><input type="radio" name={'vote-' + poll.id} value={option} checked={choice === option} onChange={() => setChoice(option)} /> {option}</label>)}
      </fieldset>
      <div className="button-row"><Button type="submit" disabled={busy || !choice}>{busy ? 'Waiting for your wallet…' : 'Sign and vote'}</Button></div>
      <p className="help-text">Your wallet signs the poll id and your choice. One vote per wallet; it cannot be changed. The weight is fixed by tier, never by balance, and is checked again when the poll closes.</p>
    </form>}
    {error && <p className="error" role="alert">{error}</p>}
    {done && <p role="status">{done}</p>}
  </article>;
}

export default function Holders() {
  const [doc, setDoc] = useState(null);
  const [error, setError] = useState('');
  const [polls, setPolls] = useState(null);
  const [pollError, setPollError] = useState('');
  // Launch surface: a core router serves the tier table (read only). Polls, votes and a wallet's own tier are not core:
  // their routes are asked only once the router has said it serves them, and a core router's page leaves them out.
  const pollsOn = usePart('part', 'holder-polls');
  const readPolls = useCallback(() => api(POLLS_PATH).then(r => { setPolls(r.data); setPollError(''); }).catch(e => { setPolls([]); setPollError(e.status === 404 ? '' : e.message); }), []);
  useEffect(() => {
    api(TIERS_PATH).then(r => setDoc(r.data)).catch(e => setError(e.status === 404 && !isNotEnabled(e) ? NOT_ON + '.' : e.message));
  }, []);
  useEffect(() => { if (pollsOn) readPolls(); }, [pollsOn, readPolls]);
  const on = tiersOn(doc);
  const open = (polls || []).filter(p => pollOpen(p));
  const closed = (polls || []).filter(p => !pollOpen(p));
  return <>
    <section id="tiers" aria-labelledby="tiers-title">
      <h2 id="tiers-title">Tiers</h2>
      <Problem text={error} />
      {!error && !doc && <p role="status">Reading tiers…</p>}
      {doc && !on && <div className="empty"><h3>{NOT_ON}</h3><p>No thresholds are set on this router. When they are, the table appears here with what each tier gives.</p></div>}
      {on && <><TierTable doc={doc} />
        <p className="help-text">{CAN_CHANGE} Thresholds are in whole tokens{doc.token?.address ? <> of <span title={doc.token.address}>{shortAddress(doc.token.address)}</span></> : ''}. The router reads a wallet’s balance about once every {Math.round((doc.cache_s || 3600) / 60)} minutes.</p></>}
    </section>

    <div {...extraAttr('part', 'holder-polls')}><YourTier enabled={on && pollsOn} /></div>

    <section id="perks" aria-labelledby="perks-title">
      <h2 id="perks-title">What a tier gives</h2>
      <dl className="detail-list">{PERKS.map(([name, text]) => <div key={name}><dt>{name}</dt><dd>{text}</dd></div>)}</dl>
      <div className="note">Tiers are access and priority only. Trellis adds no markup, so every caller pays the host’s price whatever their tier, and a tier pays nothing to its holder. <a className="inline-link" href="/docs/#holders">Read the reference</a>.</div>
    </section>

    <section id="polls" aria-labelledby="polls-title" {...extraAttr('part', 'holder-polls')}>
      <h2 id="polls-title">Open polls</h2>
      <p>Polls are advisory: a result informs a decision and does not carry it out. Tallies are public; who voted is not shown.</p>
      {pollError && <p className="error" role="alert">{pollError}</p>}
      {!polls && <p role="status">Reading polls…</p>}
      {polls && !open.length && <div className="empty"><h3>No open polls</h3><p>When a poll opens, it appears here with a vote button.</p></div>}
      {open.map(p => <Poll key={p.id} poll={p} onVoted={readPolls} />)}
    </section>

    <section id="closed-polls" aria-labelledby="closed-polls-title" {...extraAttr('part', 'holder-polls')}>
      <h2 id="closed-polls-title">Closed polls</h2>
      {polls && !closed.length && <p>No closed polls yet.</p>}
      {closed.map(p => <Poll key={p.id} poll={p} />)}
    </section>
  </>;
}
