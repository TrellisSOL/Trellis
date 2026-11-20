'use client';
import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { BURNS_PATH, BURN_NOTE, BURN_OFF, BURN_UPDATE, chartGeometry, formatTokens, formatWhen, safeLink, shortTx } from '../../lib/burn-tracker.js';
import { useUpdate } from '../../components/media/useUpdate';

// The $TRLS burn tracker (update 18). Nothing is asked of the router until its status lists the update as on.

function Chart({ series, symbol }) {
  const g = chartGeometry(series);
  if (!g) return <p className="help-text">No burn has been finalized yet, so there is nothing to chart.</p>;
  return <figure style={{ margin: 0 }}>
    <svg viewBox={`0 0 ${g.width} ${g.height}`} width="100%" role="img" aria-label={`$${symbol} burned in total, by day, from ${g.first} to ${g.last}: ${formatTokens(series[series.length - 1].cumulative)} at the end`} style={{ display: 'block', maxHeight: 260 }}>
      <line x1="24" x2={g.width - 24} y1={g.baseline} y2={g.baseline} stroke="var(--line)" />
      <path d={g.area} fill="var(--signal)" opacity="0.12" />
      <path d={g.line} fill="none" stroke="var(--signal)" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
      {g.dots.map(d => <circle key={d.day} cx={d.x} cy={d.y} r="3.5" fill="var(--signal)"><title>{`${d.day}: ${formatTokens(d.amount)} burned, ${formatTokens(series.find(p => p.day === d.day)?.cumulative)} in total`}</title></circle>)}
    </svg>
    <figcaption className="help-text" style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}><span>{g.first}</span><span>Total burned at the end of each day with a burn (UTC)</span><span>{g.last}</span></figcaption>
  </figure>;
}

export default function Burns() {
  const update = useUpdate(BURN_UPDATE);
  const on = update?.on === true;
  const [doc, setDoc] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!on) return undefined;
    let live = true;
    api(BURNS_PATH).then(r => { if (live) setDoc(r.data); }).catch(e => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [on]);

  if (update === undefined) return <p role="status">Reading this router’s updates…</p>;
  if (!on) return <div className="empty"><h3>{BURN_OFF}</h3><p>When this router turns it on, its burns appear here.</p></div>;
  if (error) return <p className="error" role="alert">{error}</p>;
  if (!doc) return <p role="status">Reading the burns…</p>;
  if (!doc.enabled) return <div className="empty"><h3>Nothing is burned on this router</h3><p>{doc.note || 'This router does not accept $TRLS.'}</p></div>;

  const symbol = doc.token?.symbol || 'TRLS';
  const latest = doc.burns?.[0];
  const pendingLink = safeLink(doc.pending?.explorer_url);
  return <>
    <section aria-labelledby="total-title">
      <h2 id="total-title">Total burned</h2>
      <dl className="detail-list">
        <div><dt>Burned so far</dt><dd><strong>{formatTokens(doc.total_burned)} ${symbol}</strong></dd></div>
        <div><dt>Burns on record</dt><dd>{doc.burns_recorded}{doc.history && !doc.history.complete ? ` (the most recent ${doc.history.kept}; the total covers every burn)` : ''}</dd></div>
        <div><dt>Last burn</dt><dd>{latest ? formatWhen(latest.at) : 'None yet'}</dd></div>
        {doc.token?.address && <div><dt>Token</dt><dd><code title={doc.token.address}>{shortTx(doc.token.address)}</code></dd></div>}
      </dl>
      {doc.pending && <p className="note" role="status">A burn of {formatTokens(doc.pending.amount)} ${symbol} has been sent and is waiting to be finalized{pendingLink ? <>: <a className="inline-link" href={pendingLink} target="_blank" rel="noreferrer">{shortTx(doc.pending.tx)}</a></> : ''}. It joins the total once it is final.</p>}
    </section>

    <section className="control-panel" aria-labelledby="chart-title">
      <h2 id="chart-title" style={{ marginTop: 0 }}>Over time</h2>
      <Chart series={doc.series || []} symbol={symbol} />
    </section>

    <section aria-labelledby="recent-title">
      <h2 id="recent-title">Recent burns</h2>
      {!doc.burns?.length ? <div className="empty"><h3>No burns yet</h3><p>A burn appears here once a $TRLS deposit has been credited and its tokens have been burned.</p></div> : (
        <div className="table-wrap"><table className="data-table">
          <thead><tr><th>When</th><th className="num">Amount</th><th>Transaction</th></tr></thead>
          <tbody>{doc.burns.map((b, i) => {
            const link = safeLink(b.explorer_url);
            return <tr key={b.tx} style={{ '--i': i }}>
              <td data-label="When">{formatWhen(b.at)}</td>
              <td className="num" data-label="Amount">{formatTokens(b.amount)} ${symbol}</td>
              <td data-label="Transaction">{link ? <a className="inline-link" href={link} target="_blank" rel="noreferrer" title={b.tx}>{shortTx(b.tx)}</a> : <code title={b.tx}>{shortTx(b.tx)}</code>}</td>
            </tr>;
          })}</tbody>
        </table></div>
      )}
      <p className="help-text">{BURN_NOTE}</p>
    </section>
  </>;
}
