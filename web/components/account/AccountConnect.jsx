'use client';
import { useEffect, useState } from 'react';
import { api, validKey } from '../../lib/api.js';
import { hasWallet, walletApiKey } from '../../lib/wallet.js';
import { Button } from '../UI';
import s from './AccountShell.module.css';
export default function AccountConnect({ onConnect, onSecret }) {
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [wallet, setWallet] = useState(false);
  useEffect(() => { setWallet(hasWallet()); }, []);
  async function run(getKey) {
    setBusy(true); setError('');
    try {
      const value = await getKey();
      if (!validKey(value)) throw new Error('Enter a valid Trellis API key.');
      await api('/api/v1/key', { key: value.trim() });
      await onConnect(value.trim());
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }
  const signIn = () => run(async () => { const key = await walletApiKey('Wallet key'); onSecret(key); return key; });
  return <div className={s.form}>
    <h2 tabIndex={-1}>Connect your account</h2>
    <div className="button-row"><Button disabled={busy} onClick={signIn}>{wallet ? 'Sign in with Solana wallet' : 'Sign in with wallet'}</Button>
      <Button secondary disabled={busy} onClick={() => run(async () => { const r = await api('/api/v1/keys', { method: 'POST', body: { name: 'Account key' } }); onSecret(r.key); return r.key; })}>Create a key</Button>
    </div>
    <p className="help-text">Wallet sign-in asks you to sign a message. It does not move funds.</p>
    <form onSubmit={e => { e.preventDefault(); run(() => draft); }}>
      <div className="field"><label htmlFor="account-key">Have an API key?</label><input id="account-key" type="password" autoComplete="off" spellCheck={false} required value={draft} onChange={e => setDraft(e.target.value)}/></div>
      <Button type="submit" secondary disabled={busy}>{busy ? 'Connecting…' : 'Connect key'}</Button>
    </form>
    {error && <p className="error" role="alert">{error}</p>}
    <p className="help-text">Your key stays in this browser tab’s session storage until you disconnect or close the tab.<span data-surface-extra=""> Use a management key or an owner/admin key to manage agents.</span></p>
    <nav className={s.resources} aria-label="Account help"><a href="/docs/#payments">Payment guide</a><a href="/keep/">Data privacy</a></nav>
  </div>;
}
