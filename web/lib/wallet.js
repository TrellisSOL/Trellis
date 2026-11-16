// Solana wallets through the Wallet Standard (Phantom, Solflare, Backpack and any other wallet that registers itself).
// The router never holds a user's funds: it returns unsigned transactions and the user's wallet signs and sends them.
// Discovery goes through @wallet-standard/app (a few hundred bytes); no wallet SDK is bundled. Everything that talks
// to a wallet takes the registry from `registry()`, so tests and other hosts can swap it with `setWalletRegistry`.
import { getWallets } from "@wallet-standard/app";
import { API_BASE, api } from "./api.js";
import { base58Encode, base64ToBytes, isAddress, shortAddress } from "./base58.js";
import { clusterOf } from "./solana.js";

export { shortAddress };

const SIGN_MESSAGE = "solana:signMessage";
const SIGN_AND_SEND = "solana:signAndSendTransaction";
const CONNECT = "standard:connect";

let custom = null;
/** Replace wallet discovery (tests, embedded hosts). `null` returns to @wallet-standard/app. */
export const setWalletRegistry = (r) => {
  custom = r;
};
const registry = () => custom ?? (typeof window === "undefined" ? null : getWallets());

const isSolana = (w) => Array.isArray(w?.chains) && w.chains.some((c) => String(c).startsWith("solana:")) && !!w.features?.[CONNECT];

/** Solana wallets registered in this browser, in registration order. */
export function listWallets() {
  const r = registry();
  return r ? r.get().filter(isSolana) : [];
}
export const hasWallet = () => listWallets().length > 0;

/** Called when a wallet registers or unregisters; returns the unsubscribe function. */
export function onWalletsChange(listener) {
  const r = registry();
  if (!r?.on) return () => {};
  const offs = [r.on("register", listener), r.on("unregister", listener)];
  return () => offs.forEach((off) => off());
}

let current = null; // { wallet, account }

const findWallet = (name) => {
  const wallets = listWallets();
  if (!wallets.length) throw new Error("No Solana wallet found. Install Phantom, Solflare or Backpack, or open this page in your wallet app’s browser.");
  const w = name ? wallets.find((x) => x.name === name) : wallets[0];
  if (!w) throw new Error(`The wallet "${name}" is not installed in this browser.`);
  return w;
};

/** Connect a wallet and return the address of the account it shared. `name` picks a wallet when several are installed. */
export async function connect(name) {
  const wallet = findWallet(name);
  const { accounts } = await wallet.features[CONNECT].connect();
  const account = accounts.find((a) => a.chains?.some((c) => String(c).startsWith("solana:"))) ?? accounts[0];
  if (!account || !isAddress(account.address)) throw new Error("The wallet did not share a Solana account.");
  current = { wallet, account };
  return account.address;
}

/** The account the wallet has already shared with this site, or null (never prompts). */
export async function connectedAccount() {
  if (current && !listWallets().includes(current.wallet)) current = null;
  if (current?.account) return current.account.address;
  for (const wallet of listWallets()) {
    const account = wallet.accounts?.find((a) => isAddress(a.address));
    if (account) {
      current = { wallet, account };
      return account.address;
    }
  }
  try {
    const wallet = listWallets()[0];
    const { accounts } = wallet ? await wallet.features[CONNECT].connect({ silent: true }) : { accounts: [] };
    const account = accounts?.find((a) => isAddress(a.address));
    if (account) {
      current = { wallet, account };
      return account.address;
    }
  } catch {
    /* silent connect refused */
  }
  return null;
}

export function disconnect() {
  const w = current?.wallet;
  current = null;
  return w?.features?.["standard:disconnect"]?.disconnect?.();
}

const sessionFor = async (address) => {
  if (current && !listWallets().includes(current.wallet)) current = null; // the wallet unregistered (or the registry changed)
  if (!current || current.account.address !== address) await connect();
  if (current.account.address !== address) throw new Error(`Switch your wallet to ${shortAddress(address)} and try again.`);
  return current;
};

const utf8 = (text) => new TextEncoder().encode(text);

/** An ed25519 signature (base58) over the UTF-8 bytes of `message`, made by the wallet that holds `address`. */
export async function signMessage(address, message) {
  const { wallet, account } = await sessionFor(address);
  const feature = wallet.features[SIGN_MESSAGE];
  if (!feature) throw new Error(`${wallet.name} cannot sign messages. Use a wallet that supports message signing.`);
  const [out] = await feature.signMessage({ account, message: typeof message === "string" ? utf8(message) : message });
  if (!out?.signature) throw new Error("The wallet returned no signature.");
  return base58Encode(out.signature);
}

/**
 * Send the router's unsigned transactions in order. Each is `{ transaction (base64), description?, network? }`; the wallet
 * signs each one as fee payer and broadcasts it. `onStep(text, { hash, index, count })` is told when each one is sent,
 * with its signature (base58). Returns the signatures.
 */
export async function sendTransactions(from, txs, onStep, { network } = {}) {
  const { wallet, account } = await sessionFor(from);
  const feature = wallet.features[SIGN_AND_SEND];
  if (!feature) throw new Error(`${wallet.name} cannot sign and send transactions from this page.`);
  const hashes = [];
  for (const [i, tx] of txs.entries()) {
    if (typeof tx?.transaction !== "string" || !tx.transaction) throw new Error("The router returned no transaction to sign.");
    onStep?.(`${i + 1}/${txs.length}: ${tx.description || "Confirm in your wallet"}`);
    const chain = clusterOf(tx.network ?? network).chain;
    const [out] = await feature.signAndSendTransaction({ account, transaction: base64ToBytes(tx.transaction), chain, options: { commitment: "confirmed" } });
    if (!out?.signature) throw new Error("The wallet returned no transaction signature.");
    const hash = base58Encode(out.signature);
    await onStep?.(`${i + 1}/${txs.length}: sent, waiting for confirmation…`, { hash, index: i, count: txs.length });
    hashes.push(hash);
  }
  return hashes;
}

// ---- which router this page talks to --------------------------------------------------------------------------------

/**
 * The host (with its port, when it has one) of the router this page talks to: the build-time API URL when the site calls
 * a router hosted elsewhere, otherwise the page's own origin. It is what a sign-in challenge must name and what
 * X-Wallet-Auth is signed for. `location` is passed in by tests.
 */
export function routerHost(location = globalThis.location) {
  try {
    return new URL(API_BASE || location?.origin || "").host.toLowerCase();
  } catch {
    return "";
  }
}

/** The origin (scheme, host and port) of the router this page talks to: what an organisation challenge must name. */
export function routerOrigin(location = globalThis.location) {
  try {
    return new URL(API_BASE || location?.origin || "").origin;
  } catch {
    return "";
  }
}

// ---- sign-in ------------------------------------------------------------------------------------------------------

/** Version of the sign-in scheme the router reports with a challenge (web/PORT-NOTES.md, "Wallet sign-in"). */
export const SIGN_IN_VERSION = "trellis:wallet:v2";

/**
 * Read a sign-in message (the Sign-In-With-Solana text the router issues) back into its fields; null when it is not one.
 * The router returns it ready to sign as `challenge.message`: the page signs exactly those bytes and builds no text of
 * its own.
 */
export function parseSignInMessage(message) {
  const m = /^([^\s]+) wants you to sign in with your Solana account:\n([1-9A-HJ-NP-Za-km-z]{32,44})\n\n([^\n]*)\n\nURI: ([^\n]+)\nVersion: ([^\n]+)\nChain ID: ([^\n]+)\nNonce: ([^\n]+)\nIssued At: ([^\n]+)\nExpiration Time: ([^\n]+)$/.exec(String(message ?? ""));
  if (!m) return null;
  return { domain: m[1], address: m[2], statement: m[3], uri: m[4], version: m[5], chainId: m[6], nonce: m[7], issuedAt: m[8], expirationTime: m[9] };
}

/**
 * Check a challenge before the wallet is asked to sign it: it is a sign-in message for this router (`host`) and for the
 * connected wallet (`address`), carries the challenge's own nonce and has not expired. A challenge that names another
 * site would sign the wallet in there, so it is refused with a sentence that says which site it names.
 */
export function checkSignInChallenge(challenge, { address, host = routerHost(), now = Date.now() } = {}) {
  const f = parseSignInMessage(challenge?.message);
  if (!f) throw new Error("The router did not return a sign-in message to sign. Nothing was signed.");
  const want = String(host || "").toLowerCase();
  if (!want) throw new Error("This page cannot tell which router it is signing in to. Nothing was signed.");
  let uriHost = "";
  try { uriHost = new URL(f.uri).host.toLowerCase(); } catch { /* not a URL: refused below */ }
  if (f.domain.toLowerCase() !== want || uriHost !== want || String(challenge.domain ?? "").toLowerCase() !== want)
    throw new Error(`This sign-in request is for ${f.domain}, not for ${want}. Nothing was signed. Open the dashboard at the router’s own address to sign in.`);
  if (f.address !== address) throw new Error("This sign-in request names another wallet. Nothing was signed.");
  if (f.nonce !== challenge.nonce) throw new Error("This sign-in request does not match its challenge. Nothing was signed.");
  const expires = Date.parse(f.expirationTime);
  if (!Number.isFinite(expires) || expires <= now) throw new Error("This sign-in request has expired. Try again.");
  return f;
}

/**
 * One wallet sign-in against the router: ask for the one-time challenge, check it is this router's, have the wallet sign
 * `challenge.message` exactly as returned, and exchange it for a key of the wallet's account. `call` is lib/api.js `api`
 * (or a stand-in), `sign(address, message)` returns the base58 ed25519 signature. Returns the router's whole answer.
 */
export async function signInWithWallet({ address, sign, call = api, name, host, now = Date.now }) {
  const { data: challenge } = await call("/api/v1/auth/wallet/challenge", { method: "POST", body: { address } });
  checkSignInChallenge(challenge, { address, host: host ?? routerHost(), now: now() });
  const signature = await sign(address, challenge.message);
  return call("/api/v1/auth/wallet", { method: "POST", body: { address, nonce: challenge.nonce, signature, message: challenge.message, ...(name ? { name } : {}) } });
}

/** Wallet sign-in: sign the router's one-time challenge and receive this wallet's API key. No password, no email. */
export async function walletApiKey(name = "Wallet key", { now = Date.now, walletName, host } = {}) {
  const address = await connect(walletName);
  const r = await signInWithWallet({ address, sign: signMessage, name, host, now });
  return r.key;
}

// ---- organisation challenges (owner binding, joining and signing in to a team with a wallet) -------------------------------

/**
 * Read the message the router issues for an organisation action (src/api/teams.ts): "Trellis organisation", then
 * Action, Origin, Network, Wallet, Nonce and Expires, one per line. Null when it is not one.
 */
export function parseTeamMessage(message) {
  const m = /^Trellis organisation\nAction: ([^\n]+)\nOrigin: ([^\n]+)\nNetwork: ([^\n]+)\nWallet: ([1-9A-HJ-NP-Za-km-z]{32,44})\nNonce: ([^\n]+)\nExpires: ([^\n]+)$/.exec(String(message ?? ""));
  return m ? { action: m[1], origin: m[2], network: m[3], wallet: m[4], nonce: m[5], expires: m[6] } : null;
}

/**
 * Check an organisation challenge before the wallet signs it: the message is the router's own form, names this router's
 * origin and the wallet about to sign, and has not expired. `action` (a prefix such as "own team " or "sign in to team ")
 * is what the page asked for: a challenge for some other action is refused.
 */
export function checkTeamChallenge(message, { address, action, origin = routerOrigin(), now = Date.now() } = {}) {
  const f = parseTeamMessage(message);
  if (!f) throw new Error("The router did not return an organisation message to sign. Nothing was signed.");
  if (!origin || f.origin !== origin) throw new Error(`This request is for ${f.origin}, not for ${origin || "this site"}. Nothing was signed.`);
  if (f.wallet !== address) throw new Error("This request names another wallet. Nothing was signed.");
  if (action && !f.action.startsWith(action)) throw new Error(`This request is to “${f.action}”, which is not what was asked for. Nothing was signed.`);
  const expires = Date.parse(f.expires);
  if (!Number.isFinite(expires) || expires <= now) throw new Error("This request has expired. Ask for a new one.");
  return f;
}

/** Sign an organisation challenge with the connected wallet, after checkTeamChallenge. Returns the base58 signature. */
export async function signTeamChallenge(address, message, expect = {}) {
  checkTeamChallenge(message, { ...expect, address });
  return signMessage(address, message);
}

// ---- X-Wallet-Auth ---------------------------------------------------------------------------------------------------

/** Version line of the X-Wallet-Auth message. The earlier message ("trellis:<time>:<sha256>") is no longer accepted. */
export const WALLET_AUTH_VERSION = "trellis:wallet-auth:v2";

/**
 * The exact text behind an X-Wallet-Auth signature: the version line, the method (upper case), the router's host (lower
 * case), the path with its query string, a unix time and the SHA-256 (hex) of what the route binds, one per line.
 */
export function walletAuthMessage({ method, host, path, timestamp, sha256 }) {
  const fields = [WALLET_AUTH_VERSION, String(method).toUpperCase(), String(host).toLowerCase(), String(path), String(timestamp), String(sha256)];
  if (fields.some((f) => /[\r\n]/.test(f))) throw new Error("A signed request field contains a line break.");
  return fields.join("\n");
}

/**
 * X-Wallet-Auth for one request: `<address>:<unixSeconds>:<signature>`, the wallet's ed25519 signature (base58) over
 * walletAuthMessage. `request` is `{ method, path, sha256, host? }`: the method and path of the request it will ride on
 * (the path with its query string), the hash that route binds, and the router's host (default: the one this page talks
 * to). The signature is good for that one request at that one router, once. `signer` is `{ address, sign(bytes) }`.
 */
export async function walletAuthHeader(signer, request, now = Date.now()) {
  const host = request?.host ?? routerHost();
  if (!request?.method || !request?.path || !request?.sha256 || !host) throw new Error("A wallet-signed request needs its method, its path, its hash and the router’s host.");
  const ts = Math.floor(now / 1000);
  const signature = await signer.sign(utf8(walletAuthMessage({ method: request.method, host, path: request.path, timestamp: ts, sha256: request.sha256 })));
  return `${signer.address}:${ts}:${signature}`;
}

/** A signer over the connected wallet, for walletAuthHeader. */
export async function walletSigner(walletName) {
  const address = await connect(walletName);
  return { address, sign: (bytes) => signMessage(address, bytes) };
}

// ---- closing an account ------------------------------------------------------------------------------------------------

const readCompactU16 = (bytes, at) => {
  let value = 0;
  for (let shift = 0, i = at; ; shift += 7) {
    const b = bytes[i++];
    if (b === undefined) throw new Error("The router returned a transaction that is cut short.");
    value |= (b & 0x7f) << shift;
    if (!(b & 0x80)) return { value, next: i };
  }
};

/**
 * Read who signs a serialized transaction (base64): the required signers in order, and which of them have signed.
 * Enough to check a closure before the wallet opens; nothing here verifies a signature.
 */
export function transactionSigners(transaction) {
  const raw = base64ToBytes(transaction);
  const count = readCompactU16(raw, 0);
  const signatures = [];
  let at = count.next;
  for (let i = 0; i < count.value; i++, at += 64) signatures.push(raw.subarray(at, at + 64));
  const message = raw.subarray(at);
  const start = message[0] & 0x80 ? 1 : 0; // a versioned message carries one version byte first
  const required = message[start];
  const keys = readCompactU16(message, start + 3);
  if (!required || message.length < keys.next + keys.value * 32 || signatures.length < required) throw new Error("The router returned a transaction that is cut short.");
  return Array.from({ length: required }, (_, i) => ({ address: base58Encode(message.subarray(keys.next + i * 32, keys.next + (i + 1) * 32)), signed: signatures[i].some((b) => b !== 0) }));
}

/** A transaction the router signed as the key, checked before the wallet opens: `payer` pays the fee, and its signature is the only one missing. */
function keySignedTransactions(answer, payer, what, fallback) {
  if (!answer?.transaction) return [];
  const signers = transactionSigners(answer.transaction);
  if (signers[0].address !== payer) throw new Error(`The ${what} was built for ${shortAddress(signers[0].address)} to pay the fee, not for the connected wallet. Nothing was sent.`);
  if (signers.length < 2 || signers.slice(1).some((s) => !s.signed) || answer.signed_by_key === false) throw new Error(`The ${what} does not carry the key’s signature. Nothing was sent; request it again.`);
  return [{ transaction: answer.transaction, description: answer.message || fallback }];
}

/**
 * The closure the router returned (POST /api/v1/credits/close), checked before the wallet is asked to sign: `payer` (the
 * connected wallet) is the fee payer, its signature is the only one missing, and the key has already signed. Returns the
 * list sendTransactions takes; empty when the closure is already registered on chain and there is nothing to send.
 */
export const closureTransactions = (closure, payer) => keySignedTransactions(closure, payer, "closure", "Close this key’s credits and queue the refund to the wallets that paid in");

/** The same check for POST /api/v1/credits/close/cancel: a cancel_close transaction already signed by the key. */
export const cancelTransactions = (cancel, payer) => keySignedTransactions(cancel, payer, "cancellation", "Take back the closure of this key’s credits");

/** Who a closure pays, as `depositor>account` lines in a stable order: what the person reviewed, to compare with what is about to be signed. */
export const refundTargets = (closure) => (Array.isArray(closure?.refunds) ? closure.refunds : []).map((r) => `${r.depositor}>${r.refund_to}`).sort();

const NO_DESTINATION = "A closure names no destination: what is left goes back to the wallets that funded the key, and the API key cannot send it anywhere else. Ask with the paying wallet only.";

/**
 * Ask the router for a closure with the connected wallet as fee payer and send nothing yet: the answer says where the
 * refund goes (`refunds`: the wallets that paid in), for the person to read before a wallet opens. The request carries
 * the payer and no destination. A closure prepared this way and never sent changes nothing: the key keeps working.
 */
export async function prepareClosure({ apiKey, call = api, walletName, ...rest } = {}) {
  if ("refundTo" in rest || "refund_to" in rest) throw new Error(NO_DESTINATION);
  const payer = await connect(walletName);
  const { data: closure } = await call("/api/v1/credits/close", { key: apiKey, method: "POST", body: { payer } });
  return { closure, payer, transactions: closureTransactions(closure, payer) };
}

/**
 * Close a key's credits from the dashboard: ask the router for the closure with the connected wallet as fee payer, check
 * it, and have the wallet add its signature and send it. The transaction already carries the key's signature (the router
 * signs it from the key this page holds), so the wallet pays the fee and a small rent and nothing else. There is no
 * destination to pass: the refund goes back to the wallets that paid in. `reviewed` is the `refunds` list the person was
 * shown ({@link prepareClosure}); if the fresh answer pays anyone else, nothing is sent. Returns the closure and the
 * transaction signatures sent (none when it was already registered).
 */
export async function closeCredits({ apiKey, call = api, onStep, network, walletName, reviewed, ...rest } = {}) {
  const { closure, payer, transactions } = await prepareClosure({ apiKey, call, walletName, ...rest });
  if (reviewed && JSON.stringify(refundTargets({ refunds: reviewed })) !== JSON.stringify(refundTargets(closure))) throw new Error("Where the refund goes has changed since you looked. Nothing was sent; review the list again.");
  const sent = transactions.length ? await sendTransactions(payer, transactions, onStep, { network }) : [];
  return { closure, payer, sent };
}

/**
 * Take a closure back while nothing has been paid: the router returns cancel_close already signed by the key, and the
 * connected wallet pays the fee and sends it. Once it lands the key is open again with its balance.
 */
export async function cancelClosure({ apiKey, call = api, onStep, network, walletName } = {}) {
  const payer = await connect(walletName);
  const { data: cancel } = await call("/api/v1/credits/close/cancel", { key: apiKey, method: "POST", body: { payer } });
  const sent = await sendTransactions(payer, cancelTransactions(cancel, payer), onStep, { network });
  return { cancel, payer, sent };
}

/**
 * The refund-destination change the router returned (POST /api/v1/credits/refund-destination-tx), checked before the
 * wallet opens: the connected wallet is the depositor, the fee payer and the ONLY signer, nothing is signed yet, and the
 * answer names the wallet that was asked for. The API key signs nothing here; it could not.
 */
export function refundDestinationTransactions(answer, depositor, refundTo) {
  if (typeof answer?.transaction !== "string" || !answer.transaction) throw new Error("The router returned no transaction to sign.");
  if (answer.depositor !== depositor || answer.refund_to !== refundTo) throw new Error("The router answered for a different wallet or destination than the one you asked for. Nothing was sent.");
  const signers = transactionSigners(answer.transaction);
  if (signers.length !== 1 || signers[0].address !== depositor || signers[0].signed) throw new Error("A change of refund destination is signed by the wallet that paid in, alone. This transaction asks for something else, so nothing was sent.");
  return [{ transaction: answer.transaction, description: answer.message || `Send this wallet’s refunds to ${shortAddress(refundTo)}` }];
}

/**
 * Move where the CONNECTED wallet's own share of this key's refund goes, to `refundTo`'s USDC account. Only a wallet
 * that deposited to the key can do it, with its own signature (404 otherwise). It moves no money now.
 */
export async function moveRefundDestination({ apiKey, refundTo, call = api, onStep, network, walletName } = {}) {
  if (!isAddress(refundTo)) throw new Error("Enter the Solana address (base58) of the wallet that should receive this wallet’s refund.");
  const depositor = await connect(walletName);
  const { data } = await call("/api/v1/credits/refund-destination-tx", { key: apiKey, method: "POST", body: { depositor, refund_to: refundTo } });
  const sent = await sendTransactions(depositor, refundDestinationTransactions(data, depositor, refundTo), onStep, { network });
  return { request: data, depositor, sent };
}
