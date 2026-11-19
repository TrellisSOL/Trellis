'use client';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import w from './Workspace.module.css';

const SUGGESTIONS = ['Explain what a signed receipt proves, in two sentences.', 'Write a haiku about open models.', 'Summarise the trade-offs of routing between providers.'];
const SAMPLE = 'A generation receipt makes usage easier to audit by recording the model, provider, token counts, payment allocation and cost components for one call.';

/**
 * The Playground as a chat: the conversation of this visit in the middle of the page (each question, the
 * model that answered, the answer, its cost and its receipt) and the composer inside the dock (the shell leaves a
 * [data-dock-slot] there on this page). The dashboard owns the call itself: the model, key, lane and payment choices,
 * `onRun`, the stream and the result. Nothing here is stored; the conversation ends with the page.
 */
export default function ChatPage({ live, busy, prompt, setPrompt, modelId, setModelId, modelOptions, modelLabel, keyId, setKeyId, keyOptions, payWith, setPayWith, payOptions, showPayWith,
  privateRoute, setPrivate, forceFailure, setForceFailure, onRun, onCancel, streamText, result, money, request, onReceipt, funding, problem }) {
  const [slot, setSlot] = useState(null);
  const [turns, setTurns] = useState([]);
  const [showRequest, setShowRequest] = useState(false);
  const [copied, setCopied] = useState('');
  const input = useRef(null);
  const end = useRef(null);
  useEffect(() => { setSlot(document.querySelector('[data-dock-slot]')); }, []);
  // The message box grows with its text, up to six lines.
  useEffect(() => { const el = input.current; if (!el) return; el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 124) + 'px'; }, [prompt, slot]);
  // The open turn takes the call's result when it lands, or is marked as not run when the call stops without one.
  useEffect(() => { if (result) setTurns(t => t.length && !t.at(-1).result ? [...t.slice(0, -1), { ...t.at(-1), result, answer: live ? result.text : SAMPLE }] : t); }, [result, live]);
  useEffect(() => { if (!busy) setTurns(t => t.length && !t.at(-1).result && !t.at(-1).failed && (problem || funding) ? [...t.slice(0, -1), { ...t.at(-1), failed: true }] : t); }, [busy, problem, funding]);
  useEffect(() => { if (turns.length) end.current?.scrollIntoView({ block: 'end', behavior: 'smooth' }); }, [turns.length]);

  const submit = event => {
    event.preventDefault();
    if (busy || !prompt.trim()) return;
    setTurns(t => [...t, { id: Date.now(), question: prompt, model: modelLabel || modelId }]);
    setShowRequest(false);
    onRun(event);
  };
  const copy = (id, text) => navigator.clipboard?.writeText(text).then(() => setCopied(id), () => {});

  const composer = <form className={w.composer} onSubmit={submit}>
    <div className={w.tools} role="group" aria-label="Call options">
      <button type="button" aria-pressed={privateRoute} onClick={() => setPrivate(!privateRoute)} disabled={busy}>Private route</button>
      <button type="button" aria-pressed={forceFailure} onClick={() => setForceFailure(!forceFailure)} disabled={busy}>{live ? 'No fallbacks' : 'Preview a timeout'}</button>
      <label className={w.toolSelect}><span>{live ? 'Key' : 'Sample key'}</span>
        <select value={keyId} onChange={e => setKeyId(e.target.value)} disabled={busy} aria-label={live ? 'Key' : 'Sample key'}><option value="">Select key</option>{keyOptions}</select>
      </label>
      {showPayWith && <label className={w.toolSelect}><span>Pay with</span>
        <select value={payWith} onChange={e => setPayWith(e.target.value)} disabled={busy} aria-label="Pay with">{payOptions.map(p => <option key={p}>{p}</option>)}</select>
      </label>}
    </div>
    <div className={w.inputRow}>
      <textarea ref={input} rows={1} value={prompt} onChange={e => setPrompt(e.target.value)} maxLength={4000} disabled={busy} aria-label={live ? 'Prompt' : 'Sample prompt'}
        placeholder={turns.length ? 'Ask a follow-up…' : 'Ask any open model…'} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) submit(e); }}/>
      <label className={w.modelChip}><span className="sr-only">Model</span>
        <img src="/dashboard-icons/models.png" alt="" width="20" height="20"/>
        <select value={modelId} onChange={e => setModelId(e.target.value)} disabled={busy}>{modelOptions}</select>
      </label>
      {busy
        ? <button type="button" className={w.send} onClick={onCancel} aria-label="Stop"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor"/></svg></button>
        : <button type="submit" className={w.send} aria-label={live ? 'Run call' : 'Run sample call'} disabled={!prompt.trim()}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h12M12 6l6 6-6 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg></button>}
    </div>
    <p className={w.hint}><span>Enter to send · Shift + Enter for a new line</span><span>{live ? 'Live call · billed to the selected key · up to 512 tokens' : 'Sample call · nothing is sent'}</span></p>
  </form>;

  const spent = turns.reduce((sum, t) => sum + (t.result?.cost || 0), 0);
  return <div className={w.chat}>
    {!turns.length && <div className={w.chatEmpty}>
      <img src="/dashboard-icons/chat.png" alt="" width="96" height="96"/>
      <h2>Ask any open model.</h2>
      <p>Each answer streams back with its cost and a signed receipt. {live ? 'Prompts and responses are never stored.' : 'Connect a key to send live calls; this preview returns a fixed sample.'}</p>
      <div className={w.suggestions}>{SUGGESTIONS.map(text => <button key={text} type="button" onClick={() => { setPrompt(text); input.current?.focus(); }}>{text}</button>)}</div>
      <p className={w.chatAside}>Tools, compare mode and attachments are in the full <a href="/harness/">Chat</a>.</p>
    </div>}

    {turns.length > 0 && <div className={w.threadMap}>
      <span>{turns.length} {turns.length === 1 ? 'question' : 'questions'} · {money(spent, 6)} USDC this visit</span>
      <button type="button" onClick={() => end.current?.scrollIntoView({ block: 'end', behavior: 'smooth' })}>Latest question ↓</button>
    </div>}

    <div className={w.thread} aria-live="polite" aria-busy={busy || undefined}>
      {turns.map((turn, i) => {
        const open = i === turns.length - 1;
        const answer = turn.answer ?? (open && busy ? (live ? streamText : '') : '');
        return <article key={turn.id} className={w.turn}>
          <div className={w.question}><p>{turn.question}</p><button type="button" onClick={() => { setPrompt(turn.question); input.current?.focus(); }}>Use this question</button></div>
          <div className={w.answerTabs} role="tablist" aria-label="Answers">
            <span role="tab" aria-selected="true" className={w.answerTab}><img src="/dashboard-icons/models.png" alt="" width="20" height="20"/>{turn.model}</span>
            {open && <button type="button" className={w.answerAside} onClick={() => setShowRequest(v => !v)} aria-expanded={showRequest}>{showRequest ? 'Hide request' : 'View request'}</button>}
          </div>
          {open && showRequest && <pre className={w.request} aria-label="Request preview"><code>{request}</code></pre>}
          <div className={w.answer}>
            {answer ? <p>{answer}</p> : <p className={w.pending}>{turn.failed ? 'This call did not run. The reason is below.' : busy && open ? (live ? 'Selecting a provider and holding the worst-case cost…' : 'Checking the sample route and budget…') : 'No answer.'}</p>}
          </div>
          {turn.result && <footer className={w.answerFoot}>
            <span className={w.receiptMark}><i aria-hidden="true"/>Signed receipt</span>
            <span>{turn.result.tokens} tokens</span><span>{money(turn.result.cost, 6)} USDC</span>
            {turn.result.provider && <span>{turn.result.provider}</span>}
            <span className={w.footActions}>
              <button type="button" onClick={() => onReceipt(turn.result)}>Inspect receipt</button>
              {turn.answer && <button type="button" onClick={() => copy(turn.id, turn.answer)}>{copied === turn.id ? 'Copied' : 'Copy'}</button>}
            </span>
          </footer>}
        </article>;
      })}
      <div ref={end}/>
    </div>

    {(problem || funding) && <div className={w.chatProblems}>{funding}{problem}</div>}
    {slot && createPortal(composer, slot)}
  </div>;
}
