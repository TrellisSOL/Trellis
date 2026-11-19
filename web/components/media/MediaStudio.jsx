'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../lib/api.js';
import { useLaunchSurface } from '../launch/Surface.jsx';
import { useAccountKey } from '../account/useAccountKey.js';
import { Dock, TopBar, Corner } from '../account/Workspace.jsx';
import w from '../account/Workspace.module.css';
import { useUpdate } from './useUpdate.js';
import m from './MediaStudio.module.css';

const COPY = {
  image: { title: 'Images', lede: 'Describe a picture and choose a model. One to four images per prompt.', placeholder: 'A stone arch covered in climbing roses at dawn…', action: 'Generate', order: '/api/v1/images/generations', wait: 5000, unit: 'image' },
  video: { title: 'Video', lede: 'Describe a clip and choose a model. A video takes a few minutes; this page follows it.', placeholder: 'A slow push through rows of vines as the sun comes up…', action: 'Generate', order: '/api/v1/videos/generations', wait: 8000, unit: 'video' },
};
const RATIOS = ['16:9', '1:1', '9:16'];
const usd = n => (Number(n) < 0.01 ? '$' + Number(n).toFixed(4) : '$' + Number(n).toFixed(2));
const priceOf = model => (model ? (model.pricing.min != null && model.pricing.min !== model.pricing.max ? `${usd(model.pricing.min)} to ${usd(model.pricing.max)}` : usd(model.pricing.max)) : '');

/**
 * Images and Video (the media update): one page each, the same shape. The page orders a generation with the key this tab
 * holds, follows it until it is done, and shows the files, what they cost and the receipt. Nothing is stored here:
 * the list ends with the page, and the router serves a file for 24 hours.
 */
export default function MediaStudio({ kind }) {
  const copy = COPY[kind];
  const update = useUpdate('media');
  const [apiKey, connectKey] = useAccountKey();
  const { surface } = useLaunchSurface();
  const [models, setModels] = useState(null);
  const [modelId, setModelId] = useState('');
  const [prompt, setPrompt] = useState('');
  const [count, setCount] = useState(1);
  const [ratio, setRatio] = useState(RATIOS[0]);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState(null);
  const [items, setItems] = useState([]);
  const alive = useRef(true);

  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    if (!update?.on || !apiKey) return;
    let live = true;
    api(`/api/v1/media/models?type=${kind}`, { key: apiKey }).then(d => { if (!live) return; setModels(d.data); setModelId(id => id || d.data[0]?.id || ''); }).catch(e => { if (live) { setModels([]); setProblem(e.message); } });
    return () => { live = false; };
  }, [update?.on, apiKey, kind]);

  const model = useMemo(() => models?.find(x => x.id === modelId), [models, modelId]);
  const set = (id, patch) => setItems(list => list.map(item => (item.id === id ? { ...item, ...patch } : item)));

  async function follow(local, job) {
    // A generation that is not ready yet: read it again until it is completed or failed.
    while (alive.current && job.status === 'pending') {
      await new Promise(done => setTimeout(done, copy.wait));
      if (!alive.current) return;
      try { job = await api(`${copy.order}/${job.id}`, { key: apiKey }); } catch (e) { if (e.status === 404) { set(local, { status: 'failed', message: e.message }); return; } }
    }
    if (job.status === 'completed') set(local, { status: 'completed', files: job.data, cost: job.usage?.cost, receipt: job.receipt?.id, expires: job.expires_at });
    else if (job.status === 'failed') set(local, { status: 'failed', message: job.error?.message || 'The generation failed. Nothing was charged.' });
  }

  async function submit(event) {
    event.preventDefault();
    if (busy || !model || !prompt.trim()) return;
    const local = 'local-' + Date.now();
    setProblem(null); setBusy(true);
    setItems(list => [{ id: local, prompt, model: model.name, status: 'pending', files: [] }, ...list]);
    try {
      const body = { model: model.id, prompt, ...(kind === 'image' ? { n: count } : {}), ...(model.capabilities?.accepts_aspect_ratio ? { aspect_ratio: ratio } : {}) };
      const job = await api(copy.order, { key: apiKey, method: 'POST', body });
      setBusy(false);
      await follow(local, job);
    } catch (e) {
      setBusy(false);
      setItems(list => list.filter(item => item.id !== local));
      setProblem(e.status === 402 ? { funds: true, text: 'Your balance does not cover this model’s highest price. Add funds and try again.' } : e.message);
    }
  }

  const body = update === undefined ? <p className={m.note}>Loading…</p>
    : !update?.on ? <div className={m.soon}><p className={m.eyebrow}>Coming soon</p><h2>{update?.title || 'Images and video'}</h2><p>{update?.summary || 'Image and video generation is not released on this router yet.'}</p></div>
    : !apiKey ? <div className={m.soon}><h2>Connect a key</h2><p>Images and video are paid from your balance. Connect the key this tab should use on <a href="/dashboard/">Home</a>.</p></div>
    : <>
      <form className={m.form} onSubmit={submit}>
        <label className={m.field}><span>Prompt</span>
          <textarea rows={3} maxLength={8000} value={prompt} onChange={e => setPrompt(e.target.value)} placeholder={copy.placeholder} disabled={busy}/>
        </label>
        <div className={m.row}>
          <label className={m.field}><span>Model</span>
            <select value={modelId} onChange={e => setModelId(e.target.value)} disabled={busy || !models?.length}>
              {models === null ? <option>Loading models…</option> : models.length ? models.map(x => <option key={x.id} value={x.id}>{x.name}</option>) : <option>No {copy.unit} models available</option>}
            </select>
          </label>
          {kind === 'image' && <label className={m.field}><span>Images</span>
            <select value={count} onChange={e => setCount(Number(e.target.value))} disabled={busy}>{[1, 2, 3, 4].map(n => <option key={n} value={n}>{n}</option>)}</select>
          </label>}
          {model?.capabilities?.accepts_aspect_ratio && <label className={m.field}><span>Shape</span>
            <select value={ratio} onChange={e => setRatio(e.target.value)} disabled={busy}>{RATIOS.map(r => <option key={r}>{r}</option>)}</select>
          </label>}
          <button type="submit" className={m.go} disabled={busy || !model || !prompt.trim()}>{busy ? 'Ordering…' : copy.action}</button>
        </div>
        {model && <p className={m.price}>{priceOf(model)} per {copy.unit}{kind === 'image' && count > 1 ? `, ${count} ordered` : ''}. The highest price is held on your balance while it runs; you are charged what it cost.</p>}
      </form>
      {problem && <p className={m.problem} role="alert">{problem.text || problem}{problem.funds && <> <a href="/dashboard/#payments">Add funds</a></>}</p>}
      <ol className={m.results} aria-live="polite">
        {items.map(item => <li key={item.id} className={m.item} data-status={item.status}>
          <p className={m.prompt}>{item.prompt}</p>
          <p className={m.meta}>{item.model}{item.status === 'pending' ? ' · working…' : item.status === 'failed' ? ' · not made' : ` · ${usd(item.cost ?? 0)}`}{item.receipt && <> · <a href={`/verify/?id=${encodeURIComponent(item.receipt)}`}>receipt</a></>}</p>
          {item.status === 'failed' && <p className={m.problem}>{item.message}</p>}
          {item.status === 'pending' && <div className={m.pending} aria-hidden="true"/>}
          <div className={m.files}>
            {item.files.map((file, n) => <figure key={file.url}>
              {file.content_type.startsWith('video/') ? <video src={file.url} controls playsInline preload="metadata"/> : <img src={file.url} alt={item.prompt} loading="lazy"/>}
              <figcaption><a href={file.url} download>Download{item.files.length > 1 ? ` ${n + 1}` : ''}</a></figcaption>
            </figure>)}
          </div>
          {item.status === 'completed' && <p className={m.meta}>Files are kept for 24 hours. Download what you want to keep.</p>}
        </li>)}
      </ol>
    </>;

  return <div className={w.shell}>
    <TopBar apiKey={apiKey} onDisconnect={() => connectKey('')}/>
    <main className={m.page}>
      <p className={m.eyebrow}>Create</p>
      <h1>{copy.title}</h1>
      <p className={m.lede}>{copy.lede}</p>
      {body}
    </main>
    <Dock current={copy.title} surface={surface} mediaHere={kind === 'image' ? 'images' : 'video'}/>
    <Corner apiKey={apiKey} surface={surface}/>
  </div>;
}
