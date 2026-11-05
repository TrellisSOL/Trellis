'use client';
import { useEffect, useId, useState } from 'react';
import { HEADER, PAY_WITH_COPY, isMint, loadPayWith, savePayWith } from '../../lib/pay-with.js';
import { Button } from '../UI';
import s from './AddFunds.module.css';

/**
 * Pay with a tokenized stock: which mint this browser names in X-Pay-With for calls made with `keyHash`.
 * Stored per key in this browser only; the router reads the header per call. No swap happens here.
 */
export default function PayWithSetting({ keyHash, onChange }) {
  const id = useId();
  const [mint, setMint] = useState('');
  const [draft, setDraft] = useState('');
  const [message, setMessage] = useState('');
  useEffect(() => {
    const stored = keyHash ? loadPayWith(keyHash) : '';
    setMint(stored); setDraft(stored); setMessage('');
  }, [keyHash]);
  if (!keyHash) return null;
  const save = (value) => {
    try {
      const kept = savePayWith(keyHash, value);
      setMint(kept); setDraft(kept); setMessage(kept ? `Calls from this browser with this key name ${HEADER}: ${kept}.` : 'Calls from this browser pay with USDC credits.');
      onChange?.(kept);
    } catch (e) { setMessage(e.message); }
  };
  return <section className={s.card} aria-label="Pay with a tokenized stock">
    <div className={s.heading}><h3>Pay with a tokenized stock</h3><span className="badge">{mint ? 'On for this key' : 'Off'}</span></div>
    <p>{PAY_WITH_COPY.what}</p>
    <p>{PAY_WITH_COPY.session}</p>
    <p className="help-text">{PAY_WITH_COPY.guard} The preference below is kept in this browser for this key and only sets the header on calls this site makes; it is not sent to the router on its own.</p>
    <form onSubmit={e => { e.preventDefault(); save(draft); }}>
      <div className={s.fields}><div><label htmlFor={id}>Token mint (base58)</label><input id={id} className="mono" value={draft} spellCheck={false} autoComplete="off" placeholder="Leave empty to pay with USDC credits" onChange={e => setDraft(e.target.value)} aria-invalid={draft.trim() && !isMint(draft) ? 'true' : undefined}/></div></div>
      <div className={s.actions}><Button type="submit" disabled={draft.trim() === mint}>{draft.trim() ? 'Use this token' : 'Pay with USDC credits'}</Button>{mint && <Button type="button" secondary onClick={() => save('')}>Turn off</Button>}</div>
    </form>
    {message && <p className={s.status} role="status" aria-live="polite">{message}</p>}
    <p className={s.links}><a className="inline-link" href="/docs/#payments">How payment methods are chosen</a></p>
  </section>;
}
