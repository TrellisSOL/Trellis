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
const AGENTS_OFF = 'Agent rulebooks are not switched on at this router.';
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
  return <div className={s.home}>
    <div className="panel-heading"><h2>Home</h2><button className="text-button" disabled={refreshing} onClick={async () => { setRefreshing(true); setRefreshError(''); try { await onRefresh(); setRevision(r => r + 1); } catch (e) { setRefreshError(e.message); } finally { setRefreshing(false); } }}>Refresh account details</button></div>
    {refreshError && <p className="error" role="alert">{refreshError}</p>}
    <p>Pay for calls from one balance. Follow each call’s receipt to inspect what ran, where{agentsOn ? ', what it cost and the rules recorded for it' : ' and what it cost'}.</p>
    <AddFunds key={apiKey} showProgress={false} apiKey={apiKey} balance={workspace.credits.available ?? workspace.credits.balance} onBalance={onRefresh}/> {/* ON1 */}
    <DepositProgress apiKey={apiKey}/> {/* V97B: visible regardless of balance. */}
    <FirstCallQuickstart apiKey={apiKey} workspace={workspace} account/> {/* ON2 */}
    <div className={s.cards}>
      <section className="control-panel"><h3>Balance</h3><dl><div><dt>Available</dt><dd>{dollars(workspace.credits.available ?? workspace.credits.balance)}</dd></div></dl>{runwayOn && <RunwayHint apiKey={apiKey} revision={revision}/>}{/* B119 */}<DepositCreditStatus credits={workspace.credits}/><a className="inline-link" href="/dashboard/#payments">Add funds and see payment options</a></section>
      {spendOn && <section className="control-panel"><h3>Spend</h3>{spend ? <><dl><div><dt>Today</dt><dd>{dollars(spend.today)}</dd></div><div><dt>This week</dt><dd>{dollars(spend.week)}</dd></div></dl><p className="help-text">UTC days · week starts Monday · {spend.scope === 'account' ? 'all account keys' : 'this key only'}</p></> : <p className="help-text" role="status">{status('spend')}</p>}<a className="inline-link" href="/dashboard/#spend-watch">Watch spending</a></section>}
      <section className="control-panel"><h3>Keys</h3>{workspace.keysError ? <p className="help-text">{workspace.keysError}</p> : <p>{workspace.keys.length} account {workspace.keys.length === 1 ? 'key' : 'keys'} · {workspace.keys.filter(key => !key.disabled).length} active</p>}<a className="inline-link" href="/dashboard/#api-keys">Manage keys and budgets</a></section>
      {agentsOn && <section className="control-panel"><h3>Agents</h3>{data.agents ? <p>{data.agents.length} agent {data.agents.length === 1 ? 'key' : 'keys'} · {data.agents.filter(agent => agent.killed).length} stopped</p> : <p className="help-text" role="status">{status('agents')}</p>}<a className="inline-link" href="/agents/">Manage agent rules</a></section>}
      {agentsOn && <section className="control-panel"><h3>Waiting for you</h3>{approvals ? <p>{approvals.length} {approvals.length === 1 ? 'approval' : 'approvals'} waiting</p> : <p className="help-text" role="status">{status('approvals')}</p>}<a className="inline-link" href="/agents/#approvals">Review approvals</a></section>}
      {steps.length > 0 && <section className="control-panel"><h3>Next steps</h3><ul>{steps.map(step => <li key={step.id}><a className="inline-link" href={step.href}>{step.title}</a></li>)}</ul></section>}
    </div>
    {activityOn ? <AccountActivity apiKey={apiKey} recent/> : <section className="control-panel" aria-label="Recent calls" data-surface-core="">
      <div className="panel-heading"><h3>Recent calls</h3><a className="inline-link" href="/dashboard/#receipts">See all receipts</a></div>
      {recent.length ? <ul>{recent.map(receipt => <li key={receipt.id}><button type="button" className="text-button" onClick={() => onReceipt?.(receipt)}>{receipt.model}</button> <span className="help-text">{[receipt.provider, receipt.time && new Date(receipt.time).toLocaleString(), receipt.status].filter(Boolean).join(' · ')}</span></li>)}</ul> : <p>No calls yet.</p>}
    </section>}
  </div>;
}
