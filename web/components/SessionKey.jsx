'use client';
import { useEffect, useState } from 'react';
import { API_BASE } from '../lib/api.js';
import { TAB_STATUS_PATH, deleteSessionKey, ed25519Supported, generateSessionKey, loadSessionKey, saveSessionKey, tabView } from '../lib/session-key.js';
import { shortAddress } from '../lib/base58.js';
import { Button, Code, CopyButton } from './UI';
import s from './account/AddFunds.module.css';
import { refused } from "../lib/launch-surface.js";

/**
 * The tab session key, made and kept in this browser: an Ed25519 key pair whose private half never leaves IndexedDB
 * (non-extractable), and whose public key goes to the SDK that opens tabs. Also whether this router bills tabs, from its status.
 */
export default function SessionKey() {
  const [record, setRecord] = useState(undefined); // undefined: reading; null: none
  const [supported, setSupported] = useState(undefined);
  const [able, setAble] = useState(null);
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const [confirm, setConfirm] = useState(false);
  useEffect(() => {
    loadSessionKey().then(setRecord).catch((e) => { setRecord(null); setMessage(e.message); });
    ed25519Supported().then(setAble);
    const ac = new AbortController();
    fetch(API_BASE + TAB_STATUS_PATH, { signal: ac.signal, headers: { accept: 'application/json' } }).then(async (r) => (r.ok ? r.json() : (await refused(r, TAB_STATUS_PATH), null))).then(setSupported).catch(() => setSupported(null));
    return () => ac.abort();
  }, []);
  const run = async (name, fn) => { setBusy(name); setMessage(''); try { await fn(); } catch (e) { setMessage(e.message || String(e)); } finally { setBusy(''); } };
  const make = () => run('make', async () => { const next = await generateSessionKey(); await saveSessionKey(next); setRecord(next); setConfirm(false); setMessage('Session key made and kept in this browser.'); });
  const remove = () => run('delete', async () => { await deleteSessionKey(); setRecord(null); setConfirm(false); setMessage('Session key deleted from this browser. Tabs it signed for can still be closed by the payee with the vouchers it already has.'); });
  const view = tabView(supported);
  return <div>
    <section className={s.card} aria-label="Tabs on this router">
      <div className={s.heading}><h3>Tabs on this router</h3><span className="badge">{view.state === 'loading' ? 'Reading…' : view.state === 'tab' ? 'Open' : view.state === 'off' ? 'Off' : 'Unreachable'}</span></div>
      <p role="status">{view.headline}</p>
      {view.tab && <dl><div><dt>Tab program</dt><dd><code>{view.tab.program}</code></dd></div>{view.tab.payee && <div><dt>Payee to name</dt><dd><code>{view.tab.payee}</code></dd></div>}{view.tab.capUsdc && <div><dt>Largest cap</dt><dd>{view.tab.capUsdc.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDC</dd></div>}{view.tab.maxUnvouched && <div><dt>Served ahead of a voucher</dt><dd>{view.tab.maxUnvouched}</dd></div>}</dl>}
      <p className={s.links}><a className="inline-link" href="/docs/#tabs">How tabs work</a></p>
    </section>
    <section className={s.card} aria-label="Session key">
      <div className={s.heading}><h3>Your session key</h3><span className="badge">{record === undefined ? 'Reading…' : record ? 'Kept in this browser' : 'None yet'}</span></div>
      <p>The key that signs tab vouchers. It is made here with WebCrypto, its private half is non-extractable and stays in this browser's IndexedDB, and only the public key below is shared. It is not a wallet: it holds no funds and cannot move the tab's escrow.</p>
      {able === false && <p className="error" role="alert">This browser cannot make Ed25519 keys with WebCrypto. Use a current Chrome, Safari or Firefox, or let the SDK make the session key.</p>}
      {record && <dl><div><dt>Public key</dt><dd><code>{record.publicKey}</code> <CopyButton text={record.publicKey} label="Copy"/></dd></div><div><dt>Made</dt><dd>{new Date(record.createdAt).toLocaleString('en-GB')}</dd></div></dl>}
      {record && <Code label="Give it to the SDK">{`TRELLIS_TAB_SESSION_PUBKEY=${record.publicKey}`}</Code>}
      <div className={s.actions}>
        {!record && <Button type="button" disabled={!!busy || record === undefined || able === false} onClick={make}>{busy === 'make' ? 'Making the key…' : 'Make a session key'}</Button>}
        {record && !confirm && <Button type="button" secondary disabled={!!busy} onClick={() => setConfirm(true)}>Replace or delete</Button>}
        {record && confirm && <><Button type="button" disabled={!!busy} onClick={make}>{busy === 'make' ? 'Making a new key…' : `Replace ${shortAddress(record.publicKey)}`}</Button><Button type="button" secondary disabled={!!busy} onClick={remove}>{busy === 'delete' ? 'Deleting…' : 'Delete it'}</Button><Button type="button" secondary disabled={!!busy} onClick={() => setConfirm(false)}>Keep it</Button></>}
      </div>
      {message && <p className={s.status} role="status" aria-live="polite">{message}</p>}
      <p className="help-text">Opening a tab (<code>open_tab</code>), topping it up and reclaiming it are wallet transactions an SDK or script makes with this public key; this page makes none. A voucher is signed for one tab program, one tab and one opening of it (the tab’s <code>created_at</code>, read from the chain once it is open), so a voucher of a closed tab cannot be used on a tab opened again at the same address; <a className="inline-link" href="/docs/#tab-vouchers">what a voucher signs</a>. Clearing site data deletes the key; a tab opened with it can then only be closed by the payee.</p>
    </section>
  </div>;
}
