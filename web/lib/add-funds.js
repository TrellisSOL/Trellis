// ON1: account funding state and API-derived deposit instructions, for USDC credits on Solana.
//
// A key's credits live in a trellis_credits CreditAccount seeded by its key hash. Two ways in:
//   wallet   POST /api/v1/credits/deposit-tx {amount, payer} returns one unsigned transaction (base64) that moves USDC
//            from the payer's wallet into the program vault for this key; the browser wallet signs and sends it.
//   QR       a Solana Pay transfer request to the vault with the key hash as `reference`, for a wallet app on a phone.
//            Offered only when the router says it credits such transfers (`deposit.solana_pay_transfer: true`): the
//            credits indexer reads the program's own `Deposited` events, so a plain token transfer is not a deposit,
//            and a link the router cannot credit would strand the payer's USDC.
// Credits are spend-only: there is no withdrawal. POST /api/v1/credits/close returns what is left to the wallets that paid
// it in. The request names no destination and the API key cannot choose one (security re-review RR-05).
import { depositCreditLabel } from './fast-credit.js';
import { isAddress, toRawAmount } from './deposit-format.js';
import { USDC_AMOUNT, USDC_DECIMALS, keyHashReference, solanaPayUrl } from './solana.js';
export const fundingError = error => error?.type !== 'key_budget_exceeded' && (error?.status === 402 || ['insufficient_credits', 'insufficient_balance'].includes(error?.type) || /insufficient (?:balance|credits)/i.test(error?.message || ''));
export const recoverFundingDraft = (draft, history) => draft || history.findLast(message => message.role === 'user')?.text || '';
export const initialFunding = { phase: 'zero', baseline: null, status: '' };
export function fundingState(state, event) {
  if (event.type === 'dismiss') return { ...state, phase: 'dismissed', resumePhase: state.phase };
  if (event.type === 'open') return { ...state, phase: state.resumePhase || 'zero' };
  if (event.type === 'pending') return { phase: 'pending', baseline: event.total, status: event.status || 'Waiting for confirmation…' };
  if (event.type === 'failed') return { ...state, phase: 'zero', status: '' };
  if (event.type === 'observed') {
    if (state.phase === 'credited' && event.fastCredit?.enabled) return { ...state, status: Number(event.balance) < 0 ? 'Credit reversed. Cover the negative balance before spending again.' : depositCreditLabel(event.fastCredit) || state.status };
    if (state.phase === 'credited' && Number(event.balance) === 0) return initialFunding;
    if (state.baseline != null && Number(event.total) > state.baseline) return { ...state, phase: 'credited', baseline: null, status: depositCreditLabel(event.fastCredit) || 'Credited. Your balance has been updated.' };
    return state;
  }
  return state;
}
/** A key hash as the router reports it: the SHA-256 of the key's public key, hex, with or without 0x. */
export const KEY_HASH_RE = /^(?:0x)?[0-9a-fA-F]{64}$/;
/**
 * The one deposit route for a key, from GET /api/v1/credits (`credits.deposit`) and GET /api/v1/status (`chain`), or none:
 * a session key spends its owner's balance, and a router without the credits program takes no deposits.
 */
export function fundingOptions({ credits, chain } = {}) {
  if (credits?.session) return [];
  const deposit = credits?.deposit;
  if (!deposit || !isAddress(deposit.token) || !KEY_HASH_RE.test(deposit.key_hash || '')) return [];
  const program = deposit.credits_program || deposit.credits_contract;
  if (!isAddress(program)) return [];
  const vault = [deposit.vault_authority, deposit.vault].find(isAddress) || null;
  return [{ id: 'usdc', symbol: 'USDC', mint: deposit.token, address: deposit.token, program, to: program, decimals: USDC_DECIMALS, kind: 'credits', keyHash: deposit.key_hash, creditAccount: isAddress(deposit.credit_account) ? deposit.credit_account : null, vault, payTransfer: deposit.solana_pay_transfer === true, capUsdc: deposit.cap_usdc ?? null, network: deposit.network || chain?.network || null }];
}
export function fundingAmount(amount, option) {
  if (!option) throw new Error('Choose an available payment option.');
  const text = String(amount ?? '').trim();
  if (!USDC_AMOUNT.test(text)) throw new Error('Enter a USDC amount with up to 6 decimals.');
  const raw = toRawAmount(text, option.decimals);
  if (raw <= 0n || raw >= 1n << 64n) throw new Error('Enter an amount above zero within the token limit.');
  if (option.capUsdc != null && Number(text) > Number(option.capUsdc)) throw new Error(`Deposits are capped at ${option.capUsdc} USDC per key.`);
  return raw;
}
/** The unsigned deposit transaction the router returned, checked against the option it was asked for before the wallet opens. */
export function validateDepositTransaction(data, option, raw) {
  if (data?.key_hash == null || data.key_hash !== option.keyHash || data.amount_units !== raw.toString() || typeof data.transaction !== 'string' || !data.transaction) throw new Error('Deposit instructions changed. Refresh the payment options before sending.');
  if (data.accounts?.vault != null && !isAddress(data.accounts.vault)) throw new Error('The router returned a vault address that is not a Solana address.');
  if (data.refund_to != null && !isAddress(data.refund_to)) throw new Error('The router returned a refund account that is not a Solana address.');
  return [{ transaction: data.transaction, description: data.message || `Deposit ${data.amount_usdc || ''} USDC to this key`.replace('  ', ' '), network: data.network }];
}
/**
 * The Solana Pay link a wallet app scans to pay this key from a phone: USDC to the program vault, with the key hash as the
 * reference the indexer credits by. Null unless the router publishes its vault address and says it credits plain
 * transfers to it (`payTransfer`); without that statement the only deposit is the trellis_credits::deposit transaction.
 */
export function solanaPayLink(option, amount) {
  if (!option?.vault || option.payTransfer !== true) return null;
  const text = String(amount ?? '').trim();
  return solanaPayUrl({ recipient: option.vault, mint: option.mint, amount: USDC_AMOUNT.test(text) && Number(text) > 0 ? text : undefined, reference: keyHashReference(option.keyHash), label: 'Trellis credits' });
}
// ---- closing an account (the only customer-initiated outflow) ----
/** What to do with no browser wallet while the router credits only its own deposit transaction. */
export const NO_WALLET_NOTE = 'No browser wallet? Open this page in your wallet app’s browser, or build the deposit with POST /api/v1/credits/deposit-tx and sign it with any wallet. A plain USDC transfer to the program or its vault is not credited.';
/** What paying in means for a later refund, shown where the deposit is made. */
export const DEPOSIT_REFUND_NOTE = 'If this key’s credits are ever closed, what is left of this deposit goes back to the wallet you pay from, in the same USDC account. The API key cannot send it anywhere else; only your wallet can name a different one.';
export const CLOSE_NOTE = 'Credits are spend-only. Closing this key gives back what is left to the wallets that paid it in: each wallet gets its share, in the account it paid from. It is paid after a 72-hour waiting period and a sanctions check, not on demand.';
/** Why there is no address to type: the point of the rule, in one sentence. */
export const CLOSE_NO_REDIRECT_NOTE = 'You do not choose where the refund goes, and neither can anyone who gets hold of this API key: the key can ask for a closure and take it back, and nothing else.';
/** How the closure is authorised and sent, for the dialog. */
export const CLOSE_SIGNING_NOTE = 'The closure is signed by this key itself: the router builds the transaction with the key’s signature in place, and your wallet only pays its network fee and a small rent, then sends it. Paying the fee does not make your wallet the destination of the refund. From the moment it is on chain this key stops spending.';
export const CLOSE_NEEDS_WALLET = 'Closing needs a Solana wallet in this browser to pay the transaction’s fee (any wallet; the refund still goes to the wallets that paid in). Open this page in your wallet app’s browser, or close the key from an SDK: POST /api/v1/credits/close returns the transaction already signed by the key.';
export const CLOSE_CANCEL_NOTE = 'Changed your mind? Until the refund starts being paid you can take the closure back. The key opens again with its balance.';
export const CLOSE_HELD_NOTE = 'On hold. This key was disabled, so the closure it started is not paid. An owner or admin of the account can release it; the refund still only goes to the wallets that paid in.';
export const CLOSE_MOVE_NOTE = 'A wallet that paid in can send its own share to another wallet. Only that wallet can do this, by signing with it; the API key cannot. It moves no money now.';
/** What revoking a key does to a closure it started, for the confirmation and the notice afterwards. */
export const REVOKE_HOLDS_CLOSURE_NOTE = 'If this key has asked to close its credits, that closure is put on hold: no refund is paid until an owner or admin releases it.';
/** The router's refusal for a key whose closure is registered: the key is frozen until its refund is paid (409). */
export const closingError = error => error?.status === 409 && error?.type === 'credits_closing';
export const CLOSING_MESSAGE = 'This key’s credits are being closed, so it cannot start new calls. Use another key. What is left goes back to the wallets that paid it in, after the waiting period; until then the closure can be taken back.';
/** A plain sentence for a call a frozen key was refused, or null when the error is something else. */
export const closingMessage = error => (closingError(error) ? CLOSING_MESSAGE : null);
export const CLOSE_STATUS = { queued: 'Not sent yet', registered: 'Waiting period', paid: 'Paid', refused: 'Refused', failed: 'Failed', cancelled: 'Cancelled' };
/** Why a closure is where it is, in words. On an open closure these are waits, not failures. */
export const CLOSE_REASON = {
  key_disabled: CLOSE_HELD_NOTE,
  refund_rate_limited: 'The refund is being paid in parts: there is a limit on how much leaves the vault per hour. The rest follows without you doing anything.',
  refund_destination_unavailable: 'A wallet’s refund account cannot receive USDC right now (it may have been closed). That wallet can name another one; the rest is paid as normal.',
  depositors_unknown: 'The router is still reading which wallets paid in. Nothing is paid until it knows.',
  cancelled_on_chain: 'The closure was taken back before anything was paid. The key is open again with its balance.',
  sanctioned_address: 'Refused by the sanctions check of the wallet being paid.',
  submission_failed: 'The payment could not be sent just now. It is tried again automatically.',
  refund_work_capped: 'The refund goes to many wallets and is being paid a few at a time, largest share first. The rest follows without you doing anything.',
  request_gone_refund_debited: 'The closure was taken back on chain after the refund had been prepared. The amount is being put back on the key’s balance.',
};
const REFUND_STATUS = { planned: 'to be paid', paid: 'paid', refused: 'refused', reversed: 'not paid: the closure was taken back and the amount put back on the balance' };
const usdc = units => (/^\d+$/.test(String(units ?? '')) ? `${(Number(units) / 1e6).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 })} USDC` : null);
/**
 * Where a closure's refund goes, one line per wallet that paid in. Reads both shapes the router sends: the answer to a
 * closure request (`deposited_units`: what that wallet put in, the most it can get back) and the payment plan of a listed
 * closure (`amount_units`, `owner`, `status`). Rows without a wallet and an account are dropped.
 */
export function closureRefunds(closure) {
  return (Array.isArray(closure?.refunds) ? closure.refunds : []).filter(r => isAddress(r?.depositor) && isAddress(r?.refund_to)).map(r => {
    const planned = r.amount_units != null;
    const amount = usdc(planned ? r.amount_units : r.deposited_units);
    const state = planned ? REFUND_STATUS[r.status] || r.status || '' : '';
    return {
      depositor: r.depositor, account: r.refund_to, owner: isAddress(r.owner) ? r.owner : null, moved: isAddress(r.owner) && r.owner !== r.depositor, amount, planned, state, paid: r.status === 'paid', tx: r.tx || null,
      text: planned ? `${amount || 'An amount'} ${state}${r.reason && r.status !== 'paid' ? ` (${String(r.reason).replace(/_/g, ' ')})` : ''}` : amount ? `paid in ${amount}; gets back at most that` : 'gets back at most what it paid in',
    };
  });
}
export function closureView(row) {
  if (!row) return null;
  const open = ['queued', 'registered'].includes(row.status);
  const held = open && row.reason === 'key_disabled' && !row.released_at;
  const refunds = closureRefunds(row);
  const started = !!row.pay_tx || refunds.some(r => r.paid);
  const status = held ? 'On hold' : CLOSE_STATUS[row.status] || row.status || 'Unknown';
  const payable = row.payable_at ? new Date(row.payable_at) : null;
  const when = payable && !Number.isNaN(payable.getTime()) ? payable.toLocaleString('en-GB') : null;
  const why = row.reason ? CLOSE_REASON[row.reason] || `Reason: ${String(row.reason).replace(/_/g, ' ')}.` : '';
  const detail = row.status === 'paid' ? `Paid back to the wallets that paid in${row.pay_tx ? `; last transaction ${row.pay_tx}` : ''}.`
    : row.status === 'cancelled' ? CLOSE_REASON.cancelled_on_chain
    : row.status === 'refused' || row.status === 'failed' ? `${CLOSE_STATUS[row.status]}. ${why}`.trim()
    : held ? CLOSE_HELD_NOTE
    : row.status === 'queued' ? `Prepared, but the transaction has not reached the chain, so the key keeps working.${when ? ` Once sent it is payable from about ${when}.` : ''}`
    : `${when ? `Payable from ${when}, after the waiting period, to the wallets that paid in.` : 'Payable after the waiting period, to the wallets that paid in.'}${why ? ` ${why}` : ''}`;
  return {
    id: row.id, status, detail, refunds, amountUnits: row.amount_units ?? null, open, held, cancelled: row.status === 'cancelled', released: !!row.released_at,
    /** The wallets paid so far (the router's comma-separated list). Never an address the key chose. */
    paidTo: String(row.refund_to || '').split(',').filter(isAddress),
    /** On chain and nothing paid yet: it can still be taken back. A closure that never reached the chain has nothing to cancel. */
    canCancel: row.status === 'registered' && !started,
    /** Prepared but not on chain: the same request hands out a fresh transaction to sign. */
    canSend: row.status === 'queued',
  };
}
/** A plain sentence for a refused cancellation, or null when the error is something else. */
export const cancelMessage = error => error?.type === 'nothing_to_cancel' ? 'There is no closure on chain to take back. If you prepared one and never sent it, the key is still open and working.'
  : error?.type === 'refund_in_progress' ? 'The refund has started being paid, so this closure can no longer be taken back.' : null;
/** What DELETE /api/v1/keys/{hash} said about a closure the revoked key had started: `{ id, text }`, or null. */
export function closureHeldNotice(data) {
  const held = data?.closure_held;
  if (!held?.id) return null;
  return { id: held.id, text: `The closure this key had started (${held.id}) is now on hold: no refund is paid until an owner or admin releases it. Use “Release held refund” on the revoked key when you want it to go ahead.` };
}
/** What POST /api/v1/credits/close/release answered, as one sentence. */
export function releasedMessage(rows) {
  const list = Array.isArray(rows) ? rows.filter(r => r?.released) : [];
  if (!list.length) return 'Nothing was released.';
  const when = new Date(list[0].payable_at);
  return `Released ${list.map(r => r.id).join(', ')}. The refund goes back to the wallets that paid in${Number.isNaN(when.getTime()) ? '' : `, from ${when.toLocaleString('en-GB')}`}.`;
}
