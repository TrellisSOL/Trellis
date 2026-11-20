'use client';
import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { walletApiKey } from '../../lib/wallet.js';
import { trlsFunding, trlsRateLine } from '../../lib/trls-funding.js';
import SolanaPayCode from './SolanaPayCode';
import { Button, CopyButton } from '../UI';

export default function TrlsChatFunding({ apiKey, onWalletKey }) {
  const [details, setDetails] = useState(null);
  const [error, setError] = useState('');
  const [connecting, setConnecting] = useState(false);
  useEffect(() => {
    const ac = new AbortController();
    let timer;
    async function refresh() {
      try {
        const [escrow, stock, price] = await Promise.all([
          api('/api/v1/escrow', { signal: ac.signal }),
          api('/api/v1/escrow/deposits', { key: apiKey, signal: ac.signal }),
          api('/api/v1/escrow/trls/price', { signal: ac.signal })
        ]);
        if (!ac.signal.aborted) setDetails({ key: apiKey, route: trlsFunding({ update: { on: price.data?.enabled }, escrow: escrow.data, stock: stock.data }), price: price.data });
      } catch {
        if (!ac.signal.aborted) setDetails({ key: apiKey, route: null });
      }
      if (!ac.signal.aborted) timer = setTimeout(refresh, 15000);
    }
    refresh();
    return () => { ac.abort(); clearTimeout(timer); };
  }, [apiKey]);
  const route = details?.key === apiKey && details.route;
  async function signIn() {
    setConnecting(true); setError('');
    try { await onWalletKey(await walletApiKey('Chat wallet key')); }
    catch (e) { setError(e.message); }
    finally { setConnecting(false); }
  }
  return <div>
    <h3>Fund chat with TRLS</h3>
    {!details || details.key !== apiKey ? <p role="status">Checking wallet funding…</p> : !route ? <p>TRLS funding is temporarily unavailable.</p> : !route.wallet ? <>
      <p>Sign in with the Solana wallet that will send TRLS. Its deposits fund that wallet’s chat balance.</p>
      {onWalletKey && <Button type="button" disabled={connecting} onClick={signIn}>{connecting ? 'Connecting…' : 'Sign in with funding wallet'}</Button>}
    </> : !details.price?.available ? <p role="status">{details.price?.reason?.message || 'Waiting for a TRLS price.'}</p> : <>
      <p>{trlsRateLine(details.price)} {route.maxUsd != null && 'Credit limit per deposit: $' + route.maxUsd + '.'}</p>
      <p>Send TRLS from <code>{route.wallet}</code>. Your balance updates after confirmation.</p>
      <SolanaPayCode url={route.payLink} title="Fund with TRLS"/>
      <p>Recipient <code>{route.owner}</code> <CopyButton text={route.owner} label="Copy recipient"/></p>
      <p>Token mint <code>{route.mint}</code></p>
    </>}
    {error && <p role="alert">{error}</p>}
  </div>;
}
