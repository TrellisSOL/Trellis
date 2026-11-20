'use client';
import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { barTitle, dayLabel, formatUsd, sharePct, usageChart, usagePath, USAGE_DAYS } from '../../lib/usage.js';
import h from './Home.module.css';

// Usage breakdown (update 19): a key's spend by model and by day for the last 30 days, with totals. AccountHome shows
// it only where the router lists the `usage` update as on (GET /api/v1/status); the numbers are GET /api/v1/usage.
export default function UsageBreakdown({ apiKey, revision = 0 }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!apiKey) return;
    const ac = new AbortController();
    setError('');
    api(usagePath(), { key: apiKey, signal: ac.signal }).then(r => { if (!ac.signal.aborted) setData(r.data); }).catch(e => { if (!ac.signal.aborted) setError(e.message || 'The usage breakdown could not be read.'); });
    return () => ac.abort();
  }, [apiKey, revision]);

  const chart = usageChart(data);
  return <section className={h.breakdown} aria-labelledby="home-breakdown">
    <div className={h.usageHead}><h3 id="home-breakdown">Spend by model</h3><span>Last {data?.range?.days ?? USAGE_DAYS} days · UTC{data?.scope === 'account' ? ' · every key of this account' : ''}</span></div>
    {error ? <p className="error" role="alert">{error}</p> : !data ? <p className="help-text" role="status">Reading your usage…</p> : <>
      <dl className={h.figures}>
        <div><dt>Spent</dt><dd>{formatUsd(data.totals.cost_usd)}</dd></div>
        <div><dt>Calls</dt><dd>{data.totals.requests.toLocaleString('en-US')}</dd></div>
        <div><dt>Models</dt><dd>{data.totals.models}</dd></div>
      </dl>
      {chart.empty ? <div className={h.empty}><p>No calls in the last {data.range.days} days. Your spend by model will appear here after your first call.</p></div> : <>
        <div className={h.stack} role="img" aria-label={`Spend per day for the last ${data.range.days} days, by model. Busiest day ${formatUsd(chart.peak)}.`}>
          {chart.bars.map(bar => <div key={bar.date} className={h.stackBar} title={barTitle(bar)}>
            {bar.segments.map(seg => <i key={seg.id} style={{ height: `${seg.pct}%`, background: seg.color }}/>)}
          </div>)}
        </div>
        <div className={h.stackAxis} aria-hidden="true"><span>{dayLabel(data.range.from)}</span><span>Busiest day {formatUsd(chart.peak)}</span><span>{dayLabel(data.range.to)}</span></div>
        <table className={h.modelTable}>
          <thead><tr><th>Model</th><th className={h.num}>Calls</th><th className={h.num}>Share</th><th className={h.num}>Spent</th></tr></thead>
          <tbody>{chart.series.map(s => <tr key={s.id}>
            <td><i className={h.swatch} style={{ background: s.color }} aria-hidden="true"/>{s.label}</td>
            <td className={h.num}>{s.requests.toLocaleString('en-US')}</td><td className={h.num}>{sharePct(s.share)}</td><td className={h.num}>{formatUsd(s.cost)}</td>
          </tr>)}</tbody>
        </table>
      </>}
    </>}
  </section>;
}
