// ON1: how to fund an account with USDC on Solana. Compatibility only: no partnership with any exchange or wallet.
import { EXPLORER, MAINNET, USDC_MINT } from "../lib/solana.js";
export default function GetUsdcDocs() {
  return <section id="get-usdc"><h2>Get USDC on Solana</h2>
    <p>USDC is a US dollar stablecoin used for prepaid calls. For Trellis deposits it must be USDC on Solana mainnet-beta (CAIP-2 <code>{MAINNET}</code>), mint <a className="inline-link" href={`${EXPLORER}/address/${USDC_MINT}`} rel="noreferrer"><code>{USDC_MINT}</code></a>. USDC on another network, and any other token that calls itself USDC, does not fund your account here.</p>
    <p>Most exchanges let you withdraw USDC directly to a Solana address. Choose the Solana network when you withdraw, send it to a wallet you control (Phantom, Solflare, Backpack or any Solana Pay wallet), and keep a little SOL in that wallet for transaction fees. Then open Payments in your dashboard: the deposit is one <code>trellis_credits::deposit</code> transaction your wallet signs, or a Solana Pay code a wallet app scans.</p>
    <p>Deposits are credited once the transaction is finalized, usually seconds. Credits are spend-only: there is no withdrawal. Closing the account returns what is left to the wallet that paid it in; the API key cannot send it anywhere else. USDC deposits are not switched on at trellis.example yet; this guide is for when they are.</p>
  </section>;
}
