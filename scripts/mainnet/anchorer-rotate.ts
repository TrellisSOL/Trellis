// Rotate the anchorer key in memo mode: the key whose signature makes an hourly memo line a receipt root.
//
//   bun scripts/mainnet/anchorer-rotate.ts --i-understand-this-is-mainnet --current-key-file <path> --next-key-file <path> [--from-hour <unix seconds on an hour>] [--dry-run]
//   bun scripts/mainnet/anchorer-rotate.ts --rehearsal ...
//
// The two keys are read from FILES, never from the environment (security/REVIEW-ROUND5-2026-10.md R5-17: a secret in the
// environment is handed to every child process and shows in a process listing on some systems). Neither is ever
// printed or written anywhere by this script. A file must be readable by its owner only (mode 600), and holds either
// a keypair as solana-keygen writes it (a JSON array of 64 bytes) or an env file with an ANCHORER_PRIVATE_KEY=<base58>
// line, which is how the router keeps the key:
//   --current-key-file <path>   the CURRENT anchorer key: deploy/production/secrets/anchor.env, read where it lies
//   --next-key-file <path>      the NEW anchorer key, made on the anchor worker's host: a `solana-keygen new --outfile`
//                               keypair file, or an env file in the format of secrets/anchor.env. (The router wants
//                               the key in base58, the env-file format; this script neither converts nor prints a key.)
// ANCHORER_PRIVATE_KEY or ANCHORER_NEXT_PRIVATE_KEY set in the environment stops the run.
//
// It runs from any checkout: it reads no program id and no deployments record (memo mode has no program).
//
// Environment (public values):
//   ANCHORER_KEYS               the history so far, as the router has it (JSON). REQUIRED once there has been a rotation:
//                               the line this script prints replaces the router's history, so a run without it would
//                               print a history that starts at the current key and drops every earlier one, and roots
//                               signed by those keys would stop verifying (security/REVIEW-ROUND3-2026-10.md R3-21).
//                               Without it the script refuses, unless --first-rotation says the current key is the
//                               first anchorer this deployment ever had. Either way the FIRST key of the history is
//                               a claim that is checked: that key's own history is searched for a hand-over TO it,
//                               and one that is found is a refusal. So ANCHORER_KEYS that names the current key
//                               "from hour 0" when that key was itself handed the role is refused as well, instead of
//                               printing a history without the keys before it (REVIEW-ROUND4-2026-10.md R4-29).
//   SOLANA_NETWORK              the cluster's CAIP-2 id, as the router has it (it is part of the line)
//
// What it does: one transaction with one memo,
//     trellis:anchorer:v1:<network>:<from hour>:<new key>
// signed by BOTH keys. The old key's signature is what lets anyone follow the chain of keys back to the first one; the
// new key's signature shows it exists and is held. From <from hour> on (default: the next full hour) roots must be
// signed by the new key; roots of earlier hours stay valid under the old one. The line must land before the end of the
// hour it names: a rotation announced later is refused by every verifier, so that an old key cannot be used to disown
// roots after the fact.
//
// Afterwards, by hand, in this order. The order matters (security/REVIEW-ROUND4-2026-10.md R4-12): every root line is
// signed by the key published for ITS hour, and the old key has one root left to sign after <from hour> begins: the root
// of the hour before <from hour>, which closes AT <from hour>. A verifier wants that line from the old key, landed before
// <from hour> + 3600; it refuses the same root signed by the new key, for good.
//   1. put the printed ANCHORER_KEYS line and the new ANCHORER_ADDRESS into .env.production, and the new key into
//      secrets/anchor.env as ANCHORER_PRIVATE_KEY. Files only: nothing is restarted yet;
//   2. restart the API (it publishes the key document; verifiers need the new list before <from hour> ends). Do NOT
//      restart worker-anchor: it keeps running with the old key, which is what the next step needs. From the moment it
//      reads the hand-over it reports `anchor.memo_unexpected_rotation` (its own settings do not list the new key yet)
//      and TrellisAnchorUnexpectedRotation fires: expected until step 4;
//   3. wait until <from hour> has begun and worker-anchor, still on the old key, has posted the root of the hour before
//      <from hour> and that root is final (its log line for that hour says "confirmed"; an explorer shows the old key's
//      newest memo, trellis:root:...:<from hour - 3600>:...). That takes a few minutes after <from hour>;
//   4. THEN restart worker-anchor, so that it runs with the new key and the new list, and do it before <from hour> + 3600:
//      the root of <from hour> itself is due then and only the new key can sign it. Move the old key's remaining SOL.
// What happens when the order is not kept: a worker given the new key before step 3 is done does not hold the key of the
// old key's last hour. It posts nothing for that hour, logs `anchor.memo_wrong_key`, the row is `unverifiable`, /ready
// fails `anchor_roots_verifiable`, and the receipts of that hour are rooted an hour later under the new key: nothing is
// lost, but that hour has no root of its own. A worker left on the old key past <from hour> + 3600 signs roots that
// verifiers with the new list refuse while its own (old) settings call them confirmed: do not miss step 4.
// If the old key is LOST there is no rotation: this script needs the old key's signature, and nothing else can stand in
// for it. The chain of keys is broken, and what is left is a new FIRST key (MAINNET.md, "Rollback and incidents", the
// row for a lost anchorer key, has the steps): a new ANCHORER_ADDRESS and an ANCHORER_KEYS that starts at it, announced
// publicly, because every verifier that pinned the old first key must be told to pin the new one for the hours from
// then on; the hours between the loss and the new key have no root. If it is STOLEN, rotate at once; the thief can
// still sign lines for hours before <from hour> that have no root yet, which is one reason memo mode is weaker than
// the anchor program (MAINNET.md).
//
// Program mode has no use for this script: there the anchorer is trellis_anchor's authority and hands itself on with
// transfer_authority (24 h, then the new key accepts).
import { readFileSync } from "node:fs";
import { PublicKey, Transaction, sendAndConfirmTransaction, type Keypair } from "@solana/web3.js";
import { anchorerKeysProblem, anchorerMemo, findHandOverTo, memoIx, readSignedTransaction, verifyAnchorerChain, type AnchorerKey, type MemoRpc } from "../../src/solana/anchor-memo.ts";
import { loadSigner } from "../../src/solana/keys.ts";
import { MAINNET_FLAG, REHEARSAL_FLAG, assertCluster, confirm, connect, expectFlags, explorer, fail, keyFileProblem, modeOf, parseArgs, readKeypairFile, rpcHost, rpcUrl } from "./lib.ts";

const args = parseArgs(process.argv.slice(2), ["--from-hour", "--current-key-file", "--next-key-file"]);
expectFlags(args, [MAINNET_FLAG, REHEARSAL_FLAG, "--dry-run", "--yes", "--first-rotation"]);
const mode = modeOf(args);
const url = rpcUrl(mode);
const conn = connect(url);
const genesis = await assertCluster(conn, mode);
const network = process.env.SOLANA_NETWORK ?? `solana:${genesis.slice(0, 32)}`;
if (network.includes(":") && !genesis.startsWith(network.slice(network.indexOf(":") + 1))) fail(`SOLANA_NETWORK is ${network}, but this RPC's genesis hash is ${genesis}: the line would name another cluster.`, 2);

// The keys come from files (R5-17). A secret in the environment is not read and not tolerated: it would also be in the
// environment of everything this process starts.
for (const [name, flag] of [["ANCHORER_PRIVATE_KEY", "--current-key-file"], ["ANCHORER_NEXT_PRIVATE_KEY", "--next-key-file"]] as const) {
  if (process.env[name]?.trim()) fail(`${name} is set in the environment. This script reads the anchorer keys from files only: unset it and pass ${flag} <path> (a solana-keygen keypair file, or the env file that holds the key, mode 600).`, 2);
}
/** A key file: a solana-keygen keypair (JSON array), or an env file whose ANCHORER_PRIVATE_KEY= line holds the base58 key. Owner-readable only. */
function keyFromFile(flag: string): Keypair {
  const path = args.options.get(flag);
  if (!path) fail(`${flag} <path> is required: the file that holds the ${flag === "--current-key-file" ? "CURRENT" : "NEW"} anchorer key (mode 600).`, 2);
  const loose = keyFileProblem(path);
  if (loose) fail(loose, 2);
  const text = readFileSync(path, "utf8").trim();
  if (text.startsWith("[")) return readKeypairFile(path);
  const line = /^ANCHORER_PRIVATE_KEY=(.+)$/m.exec(text)?.[1]?.trim();
  try { if (line) return loadSigner(line); } catch { /* reported below, without the value */ }
  fail(`${flag}: ${path} holds no ed25519 secret key: neither a solana-keygen keypair file nor an env file with an ANCHORER_PRIVATE_KEY=<base58> line.`, 2);
}
const current = keyFromFile("--current-key-file");
const next = keyFromFile("--next-key-file");
if (current.publicKey.equals(next.publicKey)) fail("--next-key-file is the current key.", 2);

let history: AnchorerKey[] = [{ key: current.publicKey.toBase58(), fromHour: 0, rotationTx: null }];
if (process.env.ANCHORER_KEYS) {
  let parsed: { key: string; from_hour: number; rotation_tx?: string | null }[];
  try { parsed = JSON.parse(process.env.ANCHORER_KEYS); } catch { fail("ANCHORER_KEYS is not JSON.", 2); }
  history = parsed.map((k) => ({ key: k.key, fromHour: k.from_hour, rotationTx: k.rotation_tx ?? null }));
  const problem = anchorerKeysProblem(history);
  if (problem) fail(`ANCHORER_KEYS: ${problem}.`, 2);
  if (history[history.length - 1]!.key !== current.publicKey.toBase58()) fail("ANCHORER_KEYS does not end with the key in --current-key-file.", 2);
  // The history this rotation extends must itself hold: every earlier hand-over signed by the key before it.
  const broken = await verifyAnchorerChain(conn, network, history, history.length - 1, "confirmed");
  if (broken) fail(`The existing key history does not verify on this cluster: ${broken}`, 2);
  if (args.flags.has("--first-rotation") && history.length > 1) fail("--first-rotation contradicts ANCHORER_KEYS, which lists an earlier rotation.", 2);
} else if (!args.flags.has("--first-rotation")) {
  fail("ANCHORER_KEYS is not set. This script prints the ANCHORER_KEYS line the router will use from now on; without the history so far that line would start at the current key and drop every earlier one. Set ANCHORER_KEYS to the router's current value, or, if the current key is the first anchorer this deployment ever had, pass --first-rotation.", 2);
}
// "The first key" is a claim, whoever makes it (--first-rotation, or an ANCHORER_KEYS that starts at some key "from hour
// 0"): look for a hand-over TO that key among the transactions that name it. A rotation memo is signed by the new key
// too, so it is in that key's own signature list; it is read from its transaction, not believed from the list.
{
  const first = history[0]!.key;
  const said = process.env.ANCHORER_KEYS ? "ANCHORER_KEYS starts at" : "--first-rotation: the current key is";
  let handed: Awaited<ReturnType<typeof findHandOverTo>>;
  try { handed = await findHandOverTo(conn as unknown as MemoRpc, new PublicKey(first), { network, commitment: "confirmed" }); }
  catch { fail(`${said} ${first}, and that key's transaction history could not be read on this RPC, so it cannot be shown that no earlier hand-over names it.`, 2); }
  if (handed.found) fail(`${said} ${first}, but that key was itself handed the role in ${handed.found}, so it is not the first anchorer: the printed history would drop every key before it, and roots signed by those keys would stop verifying. Set ANCHORER_KEYS to the router's whole history.`, 2);
  if (!handed.complete) fail(`${said} ${first}, and it cannot be shown that no earlier hand-over names that key (${handed.why}). Use an RPC that serves the key's whole history.`, 2);
  if (!process.env.ANCHORER_KEYS) console.log("--first-rotation: no earlier hand-over names the current key in its transaction history; it is taken as the first anchorer.");
}

const now = (await conn.getBlockTime(await conn.getSlot("confirmed"))) ?? Math.floor(Date.now() / 1000);
const fromHour = args.options.has("--from-hour") ? Number(args.options.get("--from-hour")) : Math.floor(now / 3600) * 3600 + 3600;
if (!Number.isSafeInteger(fromHour) || fromHour % 3600 !== 0) fail("--from-hour must be unix seconds on an hour boundary.", 2);
if (fromHour <= history[history.length - 1]!.fromHour) fail("--from-hour must be after the hour the current key started.", 2);
if (fromHour + 3600 <= now) fail("--from-hour is already over: a rotation must be announced before the end of the hour it starts in.", 2);
if (fromHour < Math.floor(now / 3600) * 3600) fail("--from-hour is in the past.", 2);

const line = anchorerMemo({ network, fromHour, newAnchorer: next.publicKey.toBase58() });
console.log(`Anchorer rotation on ${rpcHost(url)} (${mode})`);
console.log(`  current key   ${current.publicKey.toBase58()}`);
console.log(`  new key       ${next.publicKey.toBase58()}`);
console.log(`  from hour     ${fromHour}  (${new Date(fromHour * 1000).toISOString()})`);
console.log(`  line          ${line}`);
const at = (sec: number) => new Date(sec * 1000).toISOString();
/** The steps after the hand-over, in the order that keeps every hour verifiable (R4-12: each line is signed by its hour's key). */
const procedure = [
  "Afterwards, in this order:",
  "  1. Put ANCHORER_ADDRESS and ANCHORER_KEYS (below) into .env.production and the new key into secrets/anchor.env (ANCHORER_PRIVATE_KEY, base58). Files only.",
  `  2. Restart the API now, so that the new key list is published before ${at(fromHour + 3600)}. Do NOT restart worker-anchor yet.`,
  `  3. Leave worker-anchor running with the old key until ${at(fromHour)} has passed and it has posted the root of hour ${fromHour - 3600} (the old key's last hour, which closes then) and that root is final. Until step 4 it reports anchor.memo_unexpected_rotation: expected.`,
  `  4. Then restart worker-anchor with the new key, before ${at(fromHour + 3600)}: the root of hour ${fromHour} is due then, and only the new key can sign it.`,
  "  A worker given the new key before step 3 is done cannot sign the old key's last hour: it posts nothing for it and alarms anchor.memo_wrong_key.",
];
if (args.flags.has("--dry-run")) { console.log(`\n${procedure.join("\n")}`); console.log("\nDry run: nothing was sent."); process.exit(0); }
await confirm(mode, `rotate anchorer ${next.publicKey.toBase58().slice(-6)}`, args);

const signature = await sendAndConfirmTransaction(conn, new Transaction({ feePayer: current.publicKey }).add(memoIx(line, [current.publicKey, new PublicKey(next.publicKey)])), [current, next], { commitment: "confirmed" });
const check = await readSignedTransaction(conn, signature, "confirmed");
if (!check.ok || !check.tx.memos.some((m) => m.text === line && m.signers.includes(current.publicKey.toBase58()) && m.signers.includes(next.publicKey.toBase58()))) fail(`The rotation was sent (${signature}) but does not read back as signed by both keys. Do not change the router's settings; investigate.`);
const keys = [...history, { key: next.publicKey.toBase58(), fromHour, rotationTx: signature }];
console.log(`\nannounced  ${explorer(mode, "tx", signature)}`);
console.log("\nFor .env.production (both lines; public values):");
console.log(`ANCHORER_ADDRESS=${next.publicKey.toBase58()}`);
console.log(`ANCHORER_KEYS=${JSON.stringify(keys.map((k) => ({ key: k.key, from_hour: k.fromHour, ...(k.rotationTx ? { rotation_tx: k.rotationTx } : {}) })))}`);
console.log(`\n${procedure.join("\n")}`);
