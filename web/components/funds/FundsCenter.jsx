'use client';
// Funds: the dashboard's Payments section. A balance card with its last two weeks, an inline way to add USDC (amount
// presets, what the amount buys at this account's own recent prices, wallet / phone / already-sent), paying in $TRLS
// where the router has released that update (lib/trls-funding.js), the balance alert
// and account closure, and one activity list of deposits and daily spending.
import { useEffect, useId, useMemo, useReducer, useRef, useState } from 'react';
import { api } from '../../lib/api.js';
import { connect, hasWallet, sendTransactions } from '../../lib/wallet.js';
import { NO_WALLET_NOTE, fundingAmount, fundingOptions, fundingState, initialFunding, solanaPayLink, validateDepositTransaction } from '../../lib/add-funds.js';
import { defaultFundingOption } from '../../lib/funding-display.js';
import { depositSender, readDepositProgress } from '../../lib/deposit-progress.js';
import { chainOf } from '../../lib/solana.js';
import { PRESETS, activityItems, answersFor, balanceSeries, roughly, spendStats, sparkPaths, usd } from '../../lib/funds.js';
import { TRLS_FACTS, TRLS_OWN_WALLET, TRLS_SIGN_IN, trlsFunding, trlsRateLine } from '../../lib/trls-funding.js';
import { useUpdate } from '../media/useUpdate';
import { FundingDeposits } from '../account/FundingDetails.js';
import { CopyButton } from '../UI';
import DepositProgress from '../account/DepositProgress';
import DepositNextLine from '../account/DepositNextLine';
import TrackDeposit from '../account/TrackDeposit';
import SolanaPayCode from '../account/SolanaPayCode';
import LowBalanceSetting from '../runway/LowBalanceSetting';
import { Icon, IconTile } from '../Icons';
import s from './FundsCenter.module.css';

const METHODS = [
  { id: 'wallet', icon: 'key', label: 'Wallet', hint: 'Sign in this browser' },
  { id: 'phone', icon: 'chat', label: 'Phone', hint: 'Scan a QR code' },
  { id: 'sent', icon: 'receipt', label: 'Already sent', hint: 'Track a transfer' },
];
const STEPS = ['Sign in your wallet', 'Sent to Solana', 'Confirmed', 'Credited'];

function useCountUp(value, ms = 900) {
  const [shown, setShown] = useState(value);
  const from = useRef(0);
  useEffect(() => {
    const target = Number(value) || 0;
    if (typeof window === 'undefined' || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) { setShown(target); return; }
    const start = performance.now(), a = from.current;
    let raf;
    const tick = (t) => {
      const k = Math.min(1, (t - start) / ms), e = 1 - (1 - k) ** 3;
      setShown(a + (target - a) * e);
      if (k < 1) raf = requestAnimationFrame(tick); else from.current = target;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, ms]);
  return shown;
}

function Spark({ series }) {
  const { line, area, last } = sparkPaths(series, 520, 96, 6);
  const id = useId().replace(/:/g, '');
  if (!line) return null;
  return (
    <div className={s.sparkBox}>
    <svg className={s.spark} viewBox="0 0 520 96" preserveAspectRatio="none" role="img" aria-label="Balance over the last 14 days">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#f2b66d" stopOpacity=".32" /><stop offset="1" stopColor="#f2b66d" stopOpacity="0" /></linearGradient>
      </defs>
      <path d={area} fill={`url(#${id})`} />
      <path d={line} fill="none" stroke="#f2b66d" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    </svg>
    {last && <i className={s.dot} style={{ left: `${(last[0] / 520) * 100}%`, top: `${(last[1] / 96) * 100}%` }} aria-hidden="true" />}
    </div>
  );
}

export default function FundsCenter({ apiKey, ws, status, onRefresh, onClose, children }) {
  const [state, dispatch] = useReducer(fundingState, initialFunding);
  const [data, setData] = useState(null);
  const [deposits, setDeposits] = useState([]);
  const [amount, setAmount] = useState('10');
  const [method, setMethod] = useState('wallet');
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState(-1);
  const [error, setError] = useState('');
  const [wallet, setWallet] = useState(false);
  const [token, setToken] = useState('usdc');
  const [trlsPrice, setTrlsPrice] = useState(null);
  const trlsUpdate = useUpdate('trls');
  const alive = useRef(true);
  const amountId = useId();

  useEffect(() => { setWallet(hasWallet()); return () => { alive.current = false; }; }, []);
  // Deposit instructions and the chain, refreshed while a deposit is on its way.
  useEffect(() => {
    if (!apiKey) return;
    const ac = new AbortController(); let timer;
    const read = async () => {
      try {
        const [credits, st] = await Promise.all([api('/api/v1/credits', { key: apiKey, signal: ac.signal }), api('/api/v1/status', { signal: ac.signal })]);
        if (ac.signal.aborted) return;
        setData({ credits: credits.data, chain: st.data?.chain, status: st.data });
        dispatch({ type: 'observed', balance: credits.data.available, total: credits.data.total_credits, fastCredit: credits.data.fast_credit });
      } catch { /* the cards keep the last values */ }
      readDepositProgress(apiKey).then((d) => !ac.signal.aborted && setDeposits(d?.deposits || []), () => {});
      if (!ac.signal.aborted && state.phase === 'pending') timer = setTimeout(read, 5000);
    };
    read();
    const again = () => read();
    window.addEventListener('trellis-deposit-sent', again);
    return () => { ac.abort(); clearTimeout(timer); window.removeEventListener('trellis-deposit-sent', again); };
  }, [apiKey, state.phase]);
  useEffect(() => { if (state.phase === 'credited') { setStep(3); onRefresh?.(); } }, [state.phase]); // eslint-disable-line react-hooks/exhaustive-deps

  const credits = data?.credits || ws?.credits || {};
  const balance = Number(credits.available ?? 0);
  const shown = useCountUp(balance);
  const receipts = ws?.receipts || [];
  const stats = useMemo(() => spendStats(receipts), [receipts]);
  const series = useMemo(() => balanceSeries({ balance, receipts, deposits }), [balance, receipts, deposits]);
  const items = useMemo(() => activityItems({ receipts, deposits }), [receipts, deposits]);
  const options = fundingOptions(data || {});
  const option = defaultFundingOption(options);
  const chain = chainOf(data?.status || status);
  const payLink = option ? solanaPayLink(option, amount) : null;
  const buys = answersFor(amount, stats.avgCost);
  const runwayDays = stats.spent30d > 0 ? Math.floor(balance / (stats.spent30d / 30)) : null;
  const pending = state.phase === 'pending';
  // Paying in $TRLS: offered only where the router has released the update and lists the token.
  const trls = useMemo(() => trlsFunding({ update: trlsUpdate, escrow: ws?.escrow, stock: ws?.stock }), [trlsUpdate, ws?.escrow, ws?.stock]);
  // Where the router takes no USDC deposits (no funding option), $TRLS is the one way to fund and needs no switch.
  const inTrls = !!trls && (token === 'trls' || !option);
  useEffect(() => {
    if (!inTrls) return;
    let live = true;
    api('/api/v1/escrow/trls/price').then((r) => { if (live) setTrlsPrice(r.data); }, () => {});
    return () => { live = false; };
  }, [inTrls]);
  const trlsRate = inTrls ? trlsRateLine(trlsPrice, trls.symbol) : '';
  const [whole, cents] = (Math.floor(shown * 100 + 1e-6) / 100).toFixed(2).split('.'); // cents shown like the header: never rounded up

  async function deposit() {
    setBusy(true); setError(''); setStep(0); let waiting = false;
    try {
      const raw = fundingAmount(amount, option);
      const from = await connect();
      const txs = validateDepositTransaction((await api('/api/v1/credits/deposit-tx', { key: apiKey, method: 'POST', body: { amount: amount.trim(), payer: from } })).data, option, raw);
      await sendTransactions(from, txs, depositSender(apiKey, 'usdc', (text) => {
        waiting ||= /waiting for confirmation/i.test(text);
        if (!alive.current) return;
        setStep(waiting ? 2 : 1);
        dispatch({ type: 'pending', total: Number(data.credits.total_credits), status: text });
      }), { network: chain.network });
      if (alive.current) { setStep(2); dispatch({ type: 'pending', total: Number(data.credits.total_credits), status: 'Sent. Waiting for Solana to confirm it.' }); }
    } catch (e) {
      if (!alive.current) return;
      setError(e.message || String(e));
      if (!waiting || /failed on-chain/i.test(e.message)) { setStep(-1); dispatch({ type: 'failed' }); }
    } finally { if (alive.current) setBusy(false); }
  }
  async function faucet() {
    setError(''); setBusy(true); setStep(1);
    try {
      if (!/^\d+(\.\d{1,6})?$/.test(amount) || Number(amount) <= 0 || Number(amount) > 1000) throw new Error('Enter up to 1000 test USDC.');
      dispatch({ type: 'pending', total: Number(credits.total_credits || 0), status: 'Minting and depositing test USDC…' });
      await api('/api/v1/dev/faucet', { key: apiKey, method: 'POST', body: { amount } });
      setStep(2);
    } catch (e) { setError(e.message); setStep(-1); dispatch({ type: 'failed' }); }
    finally { setBusy(false); }
  }

  return (
    <div className={s.funds}>
      <div className={s.top}>
        {/* Balance */}
        <section className={s.balance} aria-labelledby="funds-balance">
          <div className={s.balanceHead}>
            <h2 id="funds-balance"><IconTile name="coins" tone="amber" size={34} icon={17} />Balance</h2>
            <span className={s.network}><i aria-hidden="true" />USDC · {chain.name}</span>
          </div>
          <p className={s.amount} aria-live="polite"><span>$</span>{Number(whole).toLocaleString('en-US')}<small>.{cents}</small></p>
          <p className={s.runway}>
            {stats.avgCost
              ? <>Enough for about <b>{roughly(answersFor(balance, stats.avgCost))} answers</b> at your recent average of {usd(stats.avgCost, { small: true })} each{runwayDays !== null && runwayDays < 3650 ? <>, or roughly <b>{runwayDays} days</b> at your last 30 days’ pace</> : null}.</>
              : 'Your first answers will show here what your balance buys.'}
          </p>
          <Spark series={series} />
          <dl className={s.stats}>
            <div><dt><Icon name="clock" size={14} />Held for calls</dt><dd>{usd(credits.held ?? 0, { small: true })}</dd></div>
            <div><dt><Icon name="arrowIn" size={14} />Deposited</dt><dd>{usd(credits.total_credits ?? 0)}</dd></div>
            <div><dt><Icon name="arrowOut" size={14} />Spent, 30 days</dt><dd>{usd(stats.spent30d, { small: true })}</dd></div>
            <div><dt><Icon name="pulse" size={14} />Calls, 30 days</dt><dd>{stats.calls30d.toLocaleString('en-US')}</dd></div>
          </dl>
        </section>

        {/* Add funds */}
        <section className={s.add} aria-labelledby="funds-add">
          <h2 id="funds-add"><IconTile name="arrowIn" size={34} icon={17} />Add funds</h2>
          {trls && option && (
            <div className={s.tokens} role="radiogroup" aria-label="Pay with">
              <button type="button" role="radio" aria-checked={!inTrls} disabled={busy || pending} onClick={() => setToken('usdc')}>USDC</button>
              <button type="button" role="radio" aria-checked={inTrls} disabled={busy || pending} onClick={() => setToken('trls')}>${trls.symbol}</button>
            </div>
          )}
          {inTrls ? (
            <div className={s.trls}>
              <p className={s.buys}><Icon name="sparkles" size={15} /><span>Fund this balance with <b>${trls.symbol}</b>. Send it from your own wallet to the deposit address below.</span></p>
              {!trls.wallet && <p className={s.muted}>{TRLS_SIGN_IN}</p>}
              <div className={s.methodBody}>
                {trls.payLink && <SolanaPayCode url={trls.payLink} title={`Send $${trls.symbol} from a wallet app`} />}
              </div>
              <dl className={s.where}>
                <div><dt>Send ${trls.symbol} to</dt><dd><code>{trls.owner}</code><CopyButton text={trls.owner} label="Copy" /></dd></div>
                <div><dt>Token</dt><dd><code>{trls.mint}</code></dd></div>
                {trls.wallet && <div><dt>Credited to</dt><dd><code>{trls.wallet}</code></dd></div>}
              </dl>
              {trlsRate && <p className={s.muted}>{trlsRate}</p>}
              {trls.maxUsd != null && <p className={s.muted}>Up to {usd(trls.maxUsd)} is credited per deposit.</p>}
              <p className={s.muted}>{TRLS_OWN_WALLET}</p>
              <FundingDeposits deposits={trls.deposits} escrow={ws?.escrow} />
            </div>
          ) : (<>
          <label htmlFor={amountId} className={s.amountLabel}>Amount</label>
          <div className={s.amountField}>
            <span aria-hidden="true">$</span>
            <input id={amountId} inputMode="decimal" value={amount} disabled={busy || pending} onChange={(e) => { setAmount(e.target.value.replace(/[^\d.]/g, '')); setError(''); }} />
            <span className={s.unit}>USDC</span>
          </div>
          <div className={s.presets} role="group" aria-label="Quick amounts">
            {PRESETS.map((p) => (
              <button key={p} type="button" aria-pressed={Number(amount) === p} disabled={busy || pending} onClick={() => setAmount(String(p))}>${p}</button>
            ))}
          </div>
          <p className={s.buys}>
            <Icon name="sparkles" size={15} />
            <span>{buys !== null ? <>Buys about <b>{roughly(buys)} answers</b> at your recent prices.</> : 'Pay as you go: each answer is charged at the provider’s price, with no router fee.'}</span>
          </p>

          <div className={s.methods} role="radiogroup" aria-label="How you pay">
            {METHODS.map((m) => (
              <button key={m.id} type="button" role="radio" aria-checked={method === m.id} onClick={() => setMethod(m.id)}>
                <Icon name={m.icon} size={17} />
                <span><b>{m.label}</b><small>{m.hint}</small></span>
              </button>
            ))}
          </div>

          <div className={s.methodBody}>
            {!option && <p className={s.muted}>This router has not published its credits program yet, so it takes no deposits. Your balance and receipts are unaffected.</p>}
            {option && method === 'wallet' && (
              <button type="button" className={s.cta} disabled={busy || pending || !(Number(amount) > 0)} onClick={deposit}>
                <Icon name="arrowIn" size={18} />
                {busy ? 'Confirm in your wallet…' : pending ? 'Waiting for Solana…' : `Deposit ${usd(amount || 0)} USDC`}
              </button>
            )}
            {option && method === 'wallet' && !wallet && !busy && !pending && <p className={s.ctaHint}>You’ll be asked to connect a Solana wallet first.</p>}
            {option && method === 'phone' && (payLink ? <SolanaPayCode url={payLink} /> : <p className={s.muted}>{NO_WALLET_NOTE}</p>)}
            {option && method === 'sent' && <TrackDeposit apiKey={apiKey} lane="usdc" />}
            {data?.status?.dev_faucet && method === 'wallet' && (
              <button type="button" className={s.faucet} disabled={busy || pending} onClick={faucet}>Add {Number(amount) > 0 ? amount : '10'} test USDC (development chain)</button>
            )}
          </div>

          </>)}

          {step >= 0 && (
            <ol className={s.steps} aria-label="Deposit progress">
              {STEPS.map((label, i) => <li key={label} data-state={i < step ? 'done' : i === step ? 'now' : 'next'}><i aria-hidden="true">{i < step ? <Icon name="check" size={12} strokeWidth={2.4} /> : i + 1}</i>{label}</li>)}
            </ol>
          )}
          {state.status && <p className={s.status} role="status">{state.status}</p>}
          {error && <p className={s.error} role="alert">{error}</p>}

          {inTrls ? (
            <ul className={s.fine}>
              <li><Icon name="zap" size={14} />{TRLS_FACTS[0]}</li>
              <li><Icon name="shieldCheck" size={14} />{TRLS_FACTS[1]}</li>
              <li><Icon name="sparkles" size={14} />{TRLS_FACTS[2]}</li>
            </ul>
          ) : (
          <ul className={s.fine}>
            <li><Icon name="shieldCheck" size={14} />0% router fee</li>
            <li><Icon name="zap" size={14} />{data?.credits ? <DepositNextLine info={data.credits} lane="usdc" /> : 'Credited in seconds'}</li>
            <li><Icon name="arrowOut" size={14} />Leftovers go back to the paying wallet if you close</li>
          </ul>
          )}
        </section>
      </div>

      <div className={s.progress}><DepositProgress apiKey={apiKey} pendingOnly /></div>

      <div className={s.row}>
        <section className={s.activity} aria-labelledby="funds-activity">
          <h2 id="funds-activity"><IconTile name="pulse" size={34} icon={17} />Activity</h2>
          {items.length ? (
            <ul>
              {items.map((it) => (
                <li key={it.id} data-kind={it.kind}>
                  <IconTile name={it.kind === 'deposit' ? 'arrowIn' : 'receipt'} tone={it.kind === 'deposit' ? 'amber' : 'plain'} size={36} icon={16} />
                  <span className={s.what}>
                    <b>{it.kind === 'deposit' ? `Deposit${it.final ? '' : ' · ' + it.stage}` : `${it.count} answer${it.count === 1 ? '' : 's'}`}</b>
                    <small>{new Date(it.t).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}</small>
                  </span>
                  <span className={s.howMuch} data-sign={it.kind === 'deposit' ? '+' : '-'}>{it.kind === 'deposit' ? '+' : '−'}{usd(it.amount, { small: it.kind !== 'deposit' })}</span>
                  {it.url ? <a href={it.url} target="_blank" rel="noopener noreferrer" aria-label="View the transaction"><Icon name="external" size={15} /></a> : it.kind === 'spend' ? <a href="#receipts" aria-label="See these receipts"><Icon name="external" size={15} /></a> : <span />}
                </li>
              ))}
            </ul>
          ) : <p className={s.muted}>Deposits and spending will appear here.</p>}
        </section>
        <div className={s.side}>
          <div className={s.alert}><LowBalanceSetting apiKey={apiKey} /></div>
          {children}
          <section className={s.close} aria-labelledby="funds-close">
            <h2 id="funds-close"><IconTile name="archive" size={34} icon={17} />Close the account</h2>
            <p>Credits are spend-only. Closing returns what is left to the wallets that paid it in, after a short waiting period.</p>
            <button type="button" className={s.ghost} onClick={onClose}>Close account and get your balance back</button>
          </section>
        </div>
      </div>
    </div>
  );
}
