'use client';
import { useEffect, useRef, useState } from 'react';
import { Button } from '../UI';
import { api } from '../../lib/api.js';
import { useUpdate } from '../media/useUpdate.js';
import { MAX_DAYS, exportFileName, exportRange, localDate, readExport } from '../../lib/receipt-export.js';

// Receipt export (update 15): the signed receipts of a date range as one CSV or JSON file. Shown only where the router
// has released `receipt-export` (GET /api/v1/status, `updates`); elsewhere the route does not exist.
function save(text, name, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function ReceiptExport({ apiKey }) {
  const on = useUpdate('receipt-export')?.on === true;
  const [fromDay, setFromDay] = useState(() => localDate(new Date(Date.now() - 29 * 86_400_000)));
  const [toDay, setToDay] = useState(() => localDate(new Date()));
  const [format, setFormat] = useState('csv');
  const [busy, setBusy] = useState(false), [progress, setProgress] = useState(null), [done, setDone] = useState(''), [error, setError] = useState('');
  const controller = useRef(null);
  useEffect(() => () => controller.current?.abort(), []);
  if (!on || !apiKey) return null;

  async function run(e) {
    e.preventDefault();
    const range = exportRange(fromDay, toDay);
    setDone(''); setError(''); setProgress(null);
    if (range.error) return setError(range.error);
    const ac = new AbortController(); controller.current = ac; setBusy(true);
    try {
      const out = await readExport((path, options) => api(path, { ...options, key: apiKey }), { ...range, format, signal: ac.signal, onPage: p => { if (!ac.signal.aborted) setProgress(p); } });
      if (ac.signal.aborted) return;
      save(out.text, exportFileName(fromDay, toDay, format), format === 'csv' ? 'text/csv' : 'application/json');
      setDone(out.count ? `Downloaded ${out.count.toLocaleString('en-US')} signed receipt${out.count === 1 ? '' : 's'}.` : 'No signed receipts in that range. The file has the header only.');
    } catch (err) { if (!ac.signal.aborted) setError(err.message); }
    finally { if (!ac.signal.aborted) setBusy(false); }
  }

  return (
    <section className="control-panel" aria-labelledby="receipt-export-title">
      <h3 id="receipt-export-title">Download signed receipts</h3>
      <p className="help-text">Every receipt in a date range, with its signed payload, signature and key id, so each line can be checked later with the router’s published keys. Up to {MAX_DAYS} days at a time; days are in your own time zone.</p>
      <form className="catalog-tools" onSubmit={run}>
        <label className="sr-only" htmlFor="receipt-export-from">First day</label>
        <input id="receipt-export-from" type="date" value={fromDay} max={toDay} onChange={e => setFromDay(e.target.value)} required />
        <label className="sr-only" htmlFor="receipt-export-to">Last day</label>
        <input id="receipt-export-to" type="date" value={toDay} min={fromDay} onChange={e => setToDay(e.target.value)} required />
        <select aria-label="File format" value={format} onChange={e => setFormat(e.target.value)}>
          <option value="csv">CSV</option>
          <option value="json">JSON</option>
        </select>
        <Button type="submit" disabled={busy}>{busy ? 'Downloading…' : 'Download'}</Button>
        {busy && <Button type="button" secondary onClick={() => { controller.current?.abort(); setBusy(false); setProgress(null); setError('Download cancelled. Nothing was saved.'); }}>Cancel</Button>}
      </form>
      {busy && progress && <p role="status" aria-live="polite">Read {progress.count.toLocaleString('en-US')} receipts ({progress.pages} page{progress.pages === 1 ? '' : 's'})…</p>}
      {done && <p role="status">{done}</p>}
      {error && <p role="alert">{error}</p>}
      {format === 'csv' && <p className="help-text">In the CSV the signature is hex. To check a line, turn it back into base64 and send it with the payload and key id to <code>POST /api/v1/receipts/verify</code>.</p>}
    </section>
  );
}
