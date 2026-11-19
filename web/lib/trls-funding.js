// Paying in $TRLS (update `trls`, UPDATES.md): what the Payments section shows when the router accepts the token.
//
// A $TRLS deposit is a plain transfer from the payer's own wallet to the router's deposit account for the token
// (GET /api/v1/escrow, the token of kind `trls`). It is credited in dollars to the wallet that sent it, at the token's
// price when the deposit arrives, so the balance it funds is the one that wallet signs in to. Calls are charged in
// dollars as always. Pure (no React); components/funds/FundsCenter.jsx renders it.
import { isAddress } from './deposit-format.js';
import { solanaPayUrl } from './solana.js';

/** The three things the update says about paying in the token (src/features.json `trls`), in the order shown. */
export const TRLS_FACTS = [
  'Credited in dollars at the token’s price when your deposit arrives.',
  'Calls are charged in dollars at the provider’s price, with no router fee.',
  '$TRLS paid for inference is burned.',
];
export const TRLS_SIGN_IN = 'A $TRLS deposit is credited to the wallet that sends it. Sign in with that wallet to spend it.';
export const TRLS_OWN_WALLET = 'Send only from your own wallet, never from an exchange: the credit goes to the sending address.';

/**
 * The $TRLS deposit route, or null: the update is off on this router, it runs no escrow, or it does not list the token.
 * `update` is the router's release switch (GET /api/v1/status `updates`), `escrow` GET /api/v1/escrow, `stock`
 * GET /api/v1/escrow/deposits for the signed-in key.
 */
export function trlsFunding({ update, escrow, stock } = {}) {
  if (!update?.on || !escrow?.enabled) return null;
  const token = (escrow.tokens || []).find(t => t.kind === 'trls');
  if (!token || !isAddress(token.address) || !isAddress(escrow.address)) return null;
  const symbol = token.symbol || 'TRLS';
  let payLink = null;
  try { payLink = solanaPayUrl({ recipient: escrow.address, mint: token.address, label: 'Trellis credits' }); } catch { /* no code; the address still shows */ }
  return {
    symbol, mint: token.address, owner: escrow.address,
    account: isAddress(token.deposit_account) ? token.deposit_account : null,
    maxUsd: token.max_usd_per_deposit ?? null,
    wallet: stock?.wallet || null,
    deposits: (stock?.deposits || []).filter(d => d.symbol === symbol || d.token === token.address),
    payLink,
  };
}

/** What one token is credited at right now (GET /api/v1/escrow/trls/price), or '' while the router has no price. */
export function trlsRateLine(price, symbol = 'TRLS') {
  const rate = Number(price?.usd_per_token);
  if (!price?.available || !(rate > 0)) return '';
  const places = rate >= 1 ? 2 : rate >= 0.01 ? 4 : 8;
  return `1 $${symbol} is credited at $${rate.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: places })} right now. The deposit is priced when it arrives, so the rate can differ.`;
}
