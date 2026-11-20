'use client';
import { useEffect, useId, useReducer, useRef, useState } from 'react';
import TrlsChatFunding from './TrlsChatFunding';
import DepositProgress from './DepositProgress';
import DepositNextLine from './DepositNextLine';
import TrackDeposit from './TrackDeposit';
import SolanaPayCode from './SolanaPayCode';
import { depositSender } from '../../lib/deposit-progress.js';
import { api } from '../../lib/api.js';
import { connect, hasWallet, sendTransactions } from '../../lib/wallet.js';
import { DEPOSIT_REFUND_NOTE, NO_WALLET_NOTE, fundingAmount, fundingOptions, fundingState, initialFunding, solanaPayLink, validateDepositTransaction } from '../../lib/add-funds.js';
import { defaultFundingOption } from '../../lib/funding-display.js'; // V96
import { chainOf } from '../../lib/solana.js';
import { FundingQuote } from './FundingDetails.js'; // V96
import { Button, CopyButton } from '../UI';
import s from './AddFunds.module.css';

// ON1: the router's deposit instructions (one unsigned trellis_credits::deposit transaction) and the Solana wallet sender,
// with a Solana Pay code for a wallet app on a phone where the router credits such transfers.
export default function AddFunds({ apiKey, balance, force = false, onBalance, onResume, onWalletKey, onPayUsdc, disabled = false, showProgress = true }) {
  const [state, dispatch] = useReducer(fundingState, initialFunding);
  const [data, setData] = useState(null);
  const [selected, setSelected] = useState('');
  const [amount, setAmount] = useState('10');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [readError, setReadError] = useState('');
  const [wallet, setWallet] = useState(false);
  const id = useId();
  const alive = useRef(false);
  const callbacks = useRef({ onBalance }); callbacks.current = { onBalance };
  const previous = useRef(balance);
  const eligible = !!apiKey && (force || balance != null && Number(balance) === 0);
  const tracking = eligible || state.baseline != null && state.phase !== 'credited';
  useEffect(() => { setWallet(hasWallet()); }, []);
  useEffect(() => {
    if (!tracking) return;
    alive.current = true;
    const ac = new AbortController(); let timer;
    const read = async () => {
      try {
        const [credits, status] = await Promise.all([api('/api/v1/credits', { key: apiKey, signal: ac.signal }), api('/api/v1/status', { signal: ac.signal })]);
        if (ac.signal.aborted) return;
        const next = { credits: credits.data, chain: status.data?.chain, status: status.data };
        setData(next); setReadError('');
        const available = next.credits.available;
        dispatch({ type: 'observed', balance: available, total: next.credits.total_credits, fastCredit: next.credits.fast_credit });
        if (available != null && Number(available) !== Number(previous.current)) { previous.current = available; await callbacks.current.onBalance?.(available); }
      } catch (e) { if (!ac.signal.aborted) setReadError(e.message || 'Could not refresh funding details.'); }
      if (!ac.signal.aborted) timer = setTimeout(read, 5000);
    };
    read();
    return () => { alive.current = false; ac.abort(); clearTimeout(timer); };
  }, [apiKey, tracking]);
  const options = fundingOptions(data || {});
  const option = options.find(item => item.id === selected) || defaultFundingOption(options);
  const chain = chainOf(data?.status);
  const available = data?.credits?.available ?? balance;
  const trls = data?.status?.updates?.some(update => update.name === 'trls' && update.on) && !data.credits?.session;
  const pending = state.phase === 'pending';
  const payLink = option ? solanaPayLink(option, amount) : null;
  if (!eligible && !['pending', 'credited'].includes(state.phase)) return showProgress ? <DepositProgress apiKey={apiKey}/> : null;
  if (state.phase === 'dismissed') return <>{showProgress && <DepositProgress apiKey={apiKey}/>}<div className={s.reminder}>Your balance is ${Number(available || 0).toFixed(2)}. <button type="button" className="text-button" onClick={() => dispatch({ type: 'open' })}>Add funds{force ? ' to send this' : ''}</button>{onResume && Number(available) > 0 && <Button type="button" disabled={disabled} onClick={onResume}>Send now</Button>}</div></>;
  async function send() {
    setBusy(true); setError(''); let waiting = false;
    try {
      const raw = fundingAmount(amount, option);
      const from = await connect();
      const txs = validateDepositTransaction((await api('/api/v1/credits/deposit-tx', { key: apiKey, method: 'POST', body: { amount: amount.trim(), payer: from } })).data, option, raw);
      await sendTransactions(from, txs, depositSender(apiKey, 'usdc', status => { waiting ||= /waiting for confirmation/i.test(status); if (alive.current) dispatch({ type: 'pending', total: Number(data.credits.total_credits), status }); }), { network: chain.network });
      if (alive.current) dispatch({ type: 'pending', total: Number(data.credits.total_credits), status: 'Transaction sent. Follow the observed amount and credit status below.' });
    } catch (e) {
      if (alive.current) { setError(e.message); dispatch(waiting && !/failed on-chain/i.test(e.message) ? { type: 'pending', total: Number(data.credits.total_credits), status: 'Check your wallet transaction. Watching for credits; do not send again while it is pending.' } : { type: 'failed' }); }
    } finally { if (alive.current) setBusy(false); }
  }
  return <section className={s.card} aria-label={force ? 'Add funds to send this' : 'Add funds'}>
    <div className={s.heading}><h3>{force ? 'Add funds to send this' : Number(available) === 0 ? 'Your balance is $0. Add funds.' : 'Add funds'}</h3><button type="button" className="text-button" disabled={busy || pending} onClick={() => dispatch({ type: 'dismiss' })}>Dismiss</button></div>
    {onPayUsdc && <Button type="button" disabled={disabled || busy} onClick={onPayUsdc}>Pay for this message with USDC</Button>}
    {trls && <TrlsChatFunding apiKey={apiKey} onWalletKey={onWalletKey}/>}
    {option && <p>USDC on {chain.name}, into this key’s credit account. Your wallet shows the transaction before you confirm. Credits are spend-only and carry a 0% router fee.</p>}
    {readError && <p className="error" role="alert">{readError} Funding status is unknown; the next refresh will try again.</p>}
    {!data && <p role="status">Reading deposit instructions…</p>}
    {data?.credits?.session && <p>This session uses its owner’s balance and its own spending cap. Ask the owner to add funds or update the session budget.</p>}
    {data && !trls && !data.credits?.session && options.length === 0 && <p>No deposit route is available for this key: the router has not published its credits program. <a className="inline-link" href="/dashboard/#payments">Open Payments to inspect your account.</a></p>}
    {option && <>
      <div className={s.fields}><div><label htmlFor={id + '-token'}>Send token</label><select id={id + '-token'} value={option.id} disabled={busy || pending} onChange={e => { setSelected(e.target.value); setAmount('10'); setError(''); }}>{options.map(item => <option key={item.id} value={item.id}>{item.label || item.symbol}</option>)}</select></div><div><label htmlFor={id + '-amount'}>Amount in {option.symbol}</label><input id={id + '-amount'} inputMode="decimal" value={amount} disabled={busy || pending} onChange={e => setAmount(e.target.value)} /></div></div>
      <dl><div><dt>Send</dt><dd>{amount || '0'} {option.symbol}</dd></div><div><dt>USDC mint</dt><dd><code>{option.mint}</code></dd></div><div><dt>Credits program</dt><dd><code>{option.program}</code></dd></div><div><dt>Key hash</dt><dd><code>{option.keyHash}</code></dd></div>{option.creditAccount && <div><dt>Credit account</dt><dd><code>{option.creditAccount}</code></dd></div>}{option.capUsdc != null && <div><dt>Cap per key</dt><dd>{option.capUsdc} USDC</dd></div>}</dl>
      <FundingQuote option={option} amount={amount} />
      <p>One wallet transaction: <code>trellis_credits::deposit</code> moves the USDC from your wallet into the program vault for this key hash. Do not transfer USDC to the program address or its vault directly: a plain transfer is not credited.</p>
      <p className="help-text">{DEPOSIT_REFUND_NOTE}</p>
      <div className={s.actions}><Button type="button" disabled={busy || pending || !!readError} onClick={send}>{busy ? 'Confirm in your wallet…' : pending ? 'Waiting for confirmation…' : wallet ? 'Add funds with wallet' : 'Connect a Solana wallet'}</Button><CopyButton text={option.keyHash} label="Copy key hash"/></div>
      {payLink ? <SolanaPayCode url={payLink}/> : <p className="help-text">{NO_WALLET_NOTE}</p>}
      <DepositNextLine info={data.credits} lane="usdc"/>
      <TrackDeposit apiKey={apiKey} lane="usdc"/>
    </>}
    {showProgress && <DepositProgress apiKey={apiKey}/>}
    {state.status && <p className={s.status} role="status" aria-live="polite">{state.status}</p>}
    {error && <p className="error" role="alert">{error}</p>}
    {onResume && Number(available) > 0 && <Button type="button" disabled={disabled || busy} onClick={onResume}>Send now</Button>}
    <p className={s.links}><a className="inline-link" href="/docs/#get-usdc">How do I get USDC on Solana?</a> · <a className="inline-link" href="/dashboard/#payments">See all payment options</a></p>
  </section>;
}
