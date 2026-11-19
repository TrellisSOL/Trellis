'use client';
import RunwayHint from "../runway/RunwayHint"; // B119
import DepositCreditStatus from './DepositCreditStatus'; // V97
import DepositProgress from './DepositProgress'; // V97B
import FirstCallQuickstart from './FirstCallQuickstart'; // ON2
import AccountActivity from './AccountActivity';
import AddFunds from './AddFunds'; // ON1: first funds after connection.
import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { pendingApprovals } from '../../lib/agents.js';
import { homeChecklist, homeSpend } from './account-state.js';
import { usePart } from '../launch/Surface';
import s from './AccountShell.module.css';
import h from './Home.module.css';
const AGENTS_OFF = 'Agent rulebooks are not switched on at this router.';
// The balance in cents, cut rather than rounded (as the balance in the bar shows it), and what is left below a cent.
const cents = value => Math.floor((Number(value) || 0) * 100) / 100;
const money = value => new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(cents(value));
const below = value => { const rest = Math.round(((Number(value) || 0) - cents(value)) * 1e6); return rest > 0 ? String(rest).padStart(4, '0').replace(/0+$/, '') : ''; };
const dollars = value => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 6 }).format(value);
export default function AccountHome({ apiKey, workspace, onReceipt, onRefresh }) {
  const [data, setData] = useState({});
  const [revision, setRevision] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState('');
  // Launch surface: agent rulebooks, the spend report, the activity feed and the runway estimate are not core. Each is
  // read and shown only once the router has said it serves them; a core router's Home is balance, keys and receipts.
  const agentsOn = usePart('part', 'agents'), spendOn = usePart('part', 'spend'), activityOn = usePart('part', 'activity'), runwayOn = usePart('part', 'runway');
  useEffect(() => {
    const ac = new AbortController(); setData({});
    const read = async (name, path, parse = r => r.data, off = '') => {
      try { const response = await api(path, { key: apiKey, signal: ac.signal }); const value = parse(response); if (!ac.signal.aborted) setData(old => ({ ...old, [name]: value })); }
      catch (e) { if (!ac.signal.aborted) setData(old => ({ ...old, [name + 'Error']: e.status === 404 && off ? off : e.message })); }
    };
    // A router with agent rulebooks switched off answers 404 on both: say so instead of printing the error.
    if (agentsOn) read('agents', '/api/v1/agents', r => { if (!Array.isArray(r.data)) throw new Error('The agent list could not be read.'); return r.data; }, AGENTS_OFF);
    if (agentsOn) read('approvals', '/api/v1/agents/approvals?status=pending', pendingApprovals, AGENTS_OFF);
    if (spendOn) read('spend', '/api/v1/spend?period=7d&group_by=day');
    return () => ac.abort();
  }, [apiKey, revision, agentsOn, spendOn]);
  const spend = homeSpend(data.spend);
  const approvals = data.approvals?.filter(row => Date.parse(row.expires_at) > Date.now());
  const steps = homeChecklist(workspace, data.agents, { agentStep: agentsOn });
  const recent = (workspace.receipts || []).slice(0, 5);
  const status = name => data[name + 'Error'] || 'Reading account details…';
  const balance = workspace.credits.available ?? workspace.credits.balance;
  const calls = workspace.receipts || [];
  const spent = calls.reduce((sum, r) => sum + (Number(r.cost) || 0), 0);
  const tokens = calls.reduce((sum, r) => sum + (Number(r.tokens) || 0), 0);
  const bars = calls.slice(0, 14).reverse();
  const peak = Math.max(...bars.map(r => Number(r.cost) || 0), 0) || 1;
  const keyCount = workspace.keysError ? null : workspace.keys.length;
  const activeKeys = workspace.keysError ? null : workspace.keys.filter(key => !key.disabled).length;
  const quick = <FirstCallQuickstart apiKey={apiKey} workspace={workspace} account/>;
  const tiles = [
    ['chat', 'Chat', 'Ask any open model', '/dashboard/#playground'],
    ['keys', 'Keys', keyCount === null ? 'Your API keys' : `${keyCount} ${keyCount === 1 ? 'key' : 'keys'} · ${activeKeys} active`, '/dashboard/#api-keys'],
    ['purse', 'Purse', `$${money(balance)} available`, '/dashboard/#payments'],
    ['models', 'Models', 'Browse the catalogue', '/dashboard/#models'],
  ];
  return <div className={h.home}>
    <div className="panel-heading"><h2 className="home-title">Home</h2><button className="text-button" disabled={refreshing} onClick={async () => { setRefreshing(true); setRefreshError(''); try { await onRefresh(); setRevision(r => r + 1); } catch (e) { setRefreshError(e.message); } finally { setRefreshing(false); } }}>Refresh account details</button></div>
    {refreshError && <p className="error" role="alert">{refreshError}</p>}
    <div className={h.top}>
      <section className={h.balance} aria-labelledby="home-balance">
        <span className="eyebrow" id="home-balance">Available balance</span>
        <p className={h.amount}>{money(balance)}{below(balance) && <small title="Below a cent">{below(balance)}</small>}<span>USDC</span></p>
        <p className={h.status}><i aria-hidden="true" data-on={balance > 0 ? '' : undefined}/>{balance > 0 ? 'Ready to spend on any model' : 'Add funds to start calling models'}</p>
        {runwayOn && <RunwayHint apiKey={apiKey} revision={revision}/>}{/* B119 */}
        <DepositCreditStatus credits={workspace.credits}/>
        <div className={h.actions}><a className={h.accent} href="/dashboard/#payments">Add funds</a><a className={h.plain} href="/dashboard/#playground">Open chat</a></div>
      </section>
      <section className={h.usage} aria-labelledby="home-usage">
        <div className={h.usageHead}><h3 id="home-usage">Recent calls</h3><span>{calls.length ? `last ${bars.length}` : 'none yet'}</span></div>
        <div className={h.chart} role="img" aria-label={calls.length ? `Cost of the last ${bars.length} calls` : 'No calls yet'}>
          {bars.length ? bars.map(r => <i key={r.id} title={`${r.model} · ${dollars(Number(r.cost) || 0)}`} style={{ '--h': `${Math.max(6, Math.round((Number(r.cost) || 0) / peak * 100))}%` }}/>) : <span>Your calls will show here, each with its cost.</span>}
        </div>
        <dl className={h.figures}>
          <div><dt>Calls</dt><dd>{calls.length}</dd></div>
          <div><dt>Tokens</dt><dd>{tokens.toLocaleString('en-US')}</dd></div>
          <div><dt>Spent</dt><dd>{dollars(spent)}</dd></div>
          {spendOn && spend && <><div><dt>Today</dt><dd>{dollars(spend.today)}</dd></div><div><dt>This week</dt><dd>{dollars(spend.week)}</dd></div></>}
        </dl>
        {spendOn && !spend && <p className="help-text" role="status">{status('spend')}</p>}
      </section>
    </div>
    <nav className={h.tiles} aria-label="Go to">
      {tiles.map(([icon, title, note, href]) => <a key={icon} href={href}><img src={`/dashboard-icons/${icon}.png`} alt="" width="56" height="56"/><span><strong>{title}</strong><small>{note}</small></span></a>)}
    </nav>
    <AddFunds key={apiKey} showProgress={false} apiKey={apiKey} balance={balance} onBalance={onRefresh}/> {/* ON1 */}
    <DepositProgress apiKey={apiKey}/> {/* V97B: visible regardless of balance. */}
    {agentsOn && <div className={s.cards}>
      <section className="control-panel"><h3>Agents</h3>{data.agents ? <p>{data.agents.length} agent {data.agents.length === 1 ? 'key' : 'keys'} · {data.agents.filter(agent => agent.killed).length} stopped</p> : <p className="help-text" role="status">{status('agents')}</p>}<a className="inline-link" href="/agents/">Manage agent rules</a></section>
      <section className="control-panel"><h3>Waiting for you</h3>{approvals ? <p>{approvals.length} {approvals.length === 1 ? 'approval' : 'approvals'} waiting</p> : <p className="help-text" role="status">{status('approvals')}</p>}<a className="inline-link" href="/agents/#approvals">Review approvals</a></section>
    </div>}
    {activityOn ? <AccountActivity apiKey={apiKey} recent/> : <section className={h.ledger} aria-labelledby="home-receipts" data-surface-core="">
      <div className={h.ledgerHead}><h3 id="home-receipts">Receipts</h3><a href="/dashboard/#receipts">See all receipts</a></div>
      {recent.length ? <table>
        <thead><tr><th>Model</th><th>Provider</th><th>Tokens</th><th>When</th><th className={h.num}>Cost</th></tr></thead>
        <tbody>{recent.map(receipt => <tr key={receipt.id}>
          <td><button type="button" onClick={() => onReceipt?.(receipt)}><img src="/dashboard-icons/receipts.png" alt="" width="22" height="22"/>{receipt.model}</button></td>
          <td>{receipt.provider || '—'}</td><td>{receipt.tokens ?? '—'}</td><td>{receipt.time ? new Date(receipt.time).toLocaleString() : '—'}</td><td className={h.num}>{dollars(Number(receipt.cost) || 0)}</td>
        </tr>)}</tbody>
      </table> : <div className={h.empty}><img src="/dashboard-icons/receipts.png" alt="" width="40" height="40"/><h4>Every call, accounted for</h4><p>Each call you make appears here with its signed receipt.</p></div>}
    </section>}
    {steps.length > 0 ? <section className={h.start} aria-label="Getting started"><h3>Getting started</h3><ul className={h.next}>{steps.map(step => <li key={step.id}><a href={step.href}>{step.title}</a></li>)}</ul>{quick}</section>
      : <details className={h.start}><summary>Getting started · every step done</summary>{quick}</details>}
  </div>;
}
