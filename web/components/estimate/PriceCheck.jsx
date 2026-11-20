'use client';
import { useState } from 'react';
import { api } from '../../lib/api.js';
import { ESTIMATE_PATH, OUTPUT_PRESETS, PRICE_CHECK_LIMITS, priceCheckBody, priceRows } from '../../lib/price-check.js';
import { useLaunchSurface } from '../launch/Surface.jsx';
import { useAccountKey } from '../account/useAccountKey.js';
import { Dock, TopBar, Corner } from '../account/Workspace.jsx';
import w from '../account/Workspace.module.css';
import { useUpdate } from '../media/useUpdate.js';
import m from '../media/MediaStudio.module.css';
import p from './PriceCheck.module.css';

/**
 * Price check (update 13): a page of the account workspace. Paste a prompt, set the most output you allow, and the router
 * prices it on every model it lists (POST /api/v1/estimate): the estimate at the listed price, the amount it would hold
 * on a balance while the call runs, and whether the request fits. No key is needed and nothing is kept: the prompt is
 * sent in the request body, priced and dropped. "Coming soon" until the router has released the update.
 */
export default function PriceCheck() {
  const update = useUpdate('estimate');
  const [apiKey, connectKey] = useAccountKey();
  const { surface } = useLaunchSurface();
  const [prompt, setPrompt] = useState('');
  const [system, setSystem] = useState('');
  const [maxTokens, setMaxTokens] = useState(String(OUTPUT_PRESETS[1]));
  const [pay, setPay] = useState('balance');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const [answer, setAnswer] = useState(null);

  async function submit(event) {
    event.preventDefault();
    const body = priceCheckBody({ prompt, system, maxTokens, pay });
    if (typeof body === 'string') { setProblem(body); return; }
    setProblem(''); setBusy(true);
    try {
      const result = await api(ESTIMATE_PATH, { method: 'POST', body });
      setAnswer({ rows: priceRows(result), input: result.input_tokens, bound: result.input_bound_tokens, output: result.max_tokens, count: result.count, pay: result.pay });
    } catch (e) {
      setProblem(e.message);
    } finally {
      setBusy(false);
    }
  }

  const page = update === undefined ? <p className={m.note}>Loading…</p>
    : !update?.on ? <div className={m.soon}><p className={m.eyebrow}>Coming soon</p><h2>{update?.title || 'Price check'}</h2><p>{update?.summary || 'Pricing a prompt on every model is not released on this router yet.'}</p></div>
    : <>
      <form className={m.form} onSubmit={submit}>
        <label className={m.field}><span>Prompt</span>
          <textarea rows={5} maxLength={PRICE_CHECK_LIMITS.promptChars} value={prompt} onChange={e => setPrompt(e.target.value)} placeholder="Paste the prompt you are about to send…" disabled={busy}/>
        </label>
        <details className={p.system}><summary>Add a system prompt</summary>
          <label className={m.field}><span>System prompt</span>
            <textarea rows={3} maxLength={PRICE_CHECK_LIMITS.systemChars} value={system} onChange={e => setSystem(e.target.value)} disabled={busy}/>
          </label>
        </details>
        <div className={p.row}>
          <label className={m.field}><span>Most output tokens</span>
            <input className={p.number} type="number" inputMode="numeric" min="1" max={PRICE_CHECK_LIMITS.maxTokens} step="1" value={maxTokens} onChange={e => setMaxTokens(e.target.value)} disabled={busy}/>
          </label>
          <div className={p.presets} role="group" aria-label="Output presets">{OUTPUT_PRESETS.map(n => <button key={n} type="button" aria-pressed={String(n) === maxTokens} onClick={() => setMaxTokens(String(n))} disabled={busy}>{n.toLocaleString('en-US')}</button>)}</div>
          <label className={m.field}><span>Paying</span>
            <select value={pay} onChange={e => setPay(e.target.value)} disabled={busy}><option value="balance">From a balance</option><option value="per_call">Per call</option></select>
          </label>
          <button type="submit" className={m.go} disabled={busy || !prompt.trim()}>{busy ? 'Pricing…' : 'Price it'}</button>
        </div>
        <p className={m.price}>Your prompt is sent to the router in the request body, priced and dropped. Nothing is stored, and no key is needed.</p>
      </form>
      {problem && <p className={m.problem} role="alert">{problem}</p>}
      {answer && <section className={p.results} aria-live="polite" aria-labelledby="price-results">
        <h2 id="price-results" className={p.head}>{answer.count ? `${answer.count} models, cheapest first` : 'No text models are listed right now'}</h2>
        <p className={m.price}>About <strong>{answer.input.toLocaleString('en-US')}</strong> input tokens (one per four characters) and up to <strong>{answer.output.toLocaleString('en-US')}</strong> output tokens. The hold is the router’s bound: the prompt’s bytes ({answer.bound.toLocaleString('en-US')}) plus the output cap, at the dearest offer that may serve the model. It is released down to what the call cost when it settles.</p>
        {answer.rows.length > 0 && <div className={p.table} role="table" aria-label="Price per model">
          <div className={p.tr} role="row"><span role="columnheader">Model</span><span role="columnheader">Estimate</span><span role="columnheader">Hold</span><span role="columnheader">Fits</span></div>
          {answer.rows.map(row => <div key={row.id} className={p.tr} role="row" data-fits={row.fits || undefined}>
            <span role="cell" className={p.model}><strong>{row.name}</strong><small>{row.rates}</small></span>
            <span role="cell" className={p.amount}>{row.estimate}</span>
            <span role="cell" className={p.amount}>{row.hold}</span>
            <span role="cell" className={p.fit}>{row.fits ? <a href={'/harness/?model=' + encodeURIComponent(row.id)}>Fits · try it</a> : row.problem}</span>
          </div>)}
        </div>}
        <p className={m.price}>Estimates use the listed rate of each model’s cheapest offer and leave out image, audio, search and cache charges. A call can be routed to another offer; the router never charges more than its hold.</p>
      </section>}
    </>;

  return <div className={w.shell}>
    <TopBar apiKey={apiKey} onDisconnect={() => connectKey('')}/>
    <main className={m.page}>
      <p className={m.eyebrow}>Before you call</p>
      <h1>Price check</h1>
      <p className={m.lede}>Paste a prompt and see what it would cost on every model, and what the router would hold for it, before you send it.</p>
      {page}
    </main>
    <Dock current="Price check" surface={surface} mediaHere="estimate"/>
    <Corner apiKey={apiKey} surface={surface}/>
  </div>;
}
