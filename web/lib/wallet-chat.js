// USDC per-message checkout. The wallet signs one exact SPL transfer. The router co-signs and broadcasts it.
import { ComputeBudgetProgram, PublicKey, Transaction } from '@solana/web3.js';
import { createTransferCheckedInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { bytesToBase64, isAddress } from './base58.js';
import { MAINNET, USDC_MINT } from './solana.js';
import { connect, signChatPayment } from './wallet.js';

export function chatQuote(doc, url) {
  const q = doc?.accepts?.find(r => r.scheme === 'exact' && r.network === MAINNET && r.asset === USDC_MINT && r.extra?.decimals === 6);
  if (!q || q.resource !== url || !isAddress(q.payTo) || !isAddress(q.extra.feePayer) || !isAddress(doc.recent_blockhash) || !/^[1-9]\d{0,19}$/.test(q.maxAmountRequired) || BigInt(q.maxAmountRequired) >= 2n ** 64n)
    throw new Error('A valid Solana mainnet USDC quote is unavailable. Request a fresh quote.');
  const units = BigInt(q.maxAmountRequired);
  const amount = (units / 1000000n).toString() + ('.' + (units % 1000000n).toString().padStart(6, '0')).replace(/0+$/, '').replace(/\.$/, '');
  return { amount, units, recipient: q.payTo, sponsor: q.extra.feePayer, blockhash: doc.recent_blockhash };
}

export function paymentTransaction(q, address) {
  const owner = new PublicKey(address), mint = new PublicKey(USDC_MINT);
  if (address === q.sponsor) throw new Error('Choose your own USDC wallet.');
  return new Transaction({ feePayer: new PublicKey(q.sponsor), recentBlockhash: q.blockhash }).add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 30000 }),
    createTransferCheckedInstruction(getAssociatedTokenAddressSync(mint, owner), mint,
      getAssociatedTokenAddressSync(mint, new PublicKey(q.recipient), true), owner, q.units, 6)
  );
}

export async function walletChatFetch(url, init, { request = fetch, approve = text => window.confirm(text), openWallet = connect, sign = signChatPayment } = {}) {
  const options = { ...init, redirect: 'error', headers: { ...init.headers } };
  if (options.headers.authorization) throw new Error('Wallet checkout requires a separate, keyless request.');
  const first = await request(url, { ...options, headers: { ...options.headers, 'x-trellis-wallet-quote': '1' } });
  if (first.status !== 402) return first;
  const doc = await first.clone().json();
  if (!doc.accepts) return first;
  const q = chatQuote(doc, new URL(url, globalThis.location?.origin).href);
  if (!approve('Pay ' + q.amount + ' USDC on Solana for this message?\n\nModel: ' + doc.model + '\nRecipient: ' + q.recipient))
    throw new Error('Payment cancelled. You can retry this message.');
  init.signal?.throwIfAborted();
  const address = await openWallet();
  init.signal?.throwIfAborted();
  const tx = paymentTransaction(q, address);
  const bytes = await sign(address, tx.serialize({ requireAllSignatures: false }));
  const signed = Transaction.from(bytes);
  if (!signed.serializeMessage().equals(tx.serializeMessage()) || !signed.signatures.find(s => s.publicKey.toBase58() === address)?.signature || !signed.verifySignatures(false))
    throw new Error('The wallet did not sign the quoted transfer.');
  init.signal?.throwIfAborted();
  const payment = btoa(JSON.stringify({ x402Version: 1, scheme: 'exact', network: MAINNET, payload: { transaction: bytesToBase64(bytes) } }));
  // No automatic payment retry, including after a network error.
  try {
    return await request(url, { ...options, headers: { ...options.headers, 'X-PAYMENT': payment } });
  } catch {
    throw new Error('The paid request was interrupted. Check your wallet activity before approving another payment.');
  }
}
