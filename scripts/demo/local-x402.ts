// One per-call (x402) payment against the local launch (`bun run launch`, any tier): ask for the price, pay it from the
// local test wallet, get the answer and its signed receipt. The wallet holds test USDC and no SOL: the router signs as
// fee payer and passes the network fee on in the price, exactly as on a public cluster.
//
//   bun scripts/demo/local-x402.ts                          one call to http://127.0.0.1:8787
//   bun scripts/demo/local-x402.ts --url http://127.0.0.1:8800 --model qwen/qwen3-32b --prompt "hello"
//   bun scripts/demo/local-x402.ts --url https://<router> --rpc https://<cluster rpc> --keypair <wallet.json> --model <slug>
//
// The wallet is the `payer` key of .data/launch-chain/keys.json (scripts/lib/local-chain.ts), local test material, unless
// --keypair names a wallet file (a solana-keygen JSON keypair): then that wallet pays, on whatever cluster --rpc and the
// router are on, with real USDC if that is what it holds. The file is read to sign and never printed.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { createTransferCheckedInstruction, getAccount, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { verifyReceipt } from "../../packages/client/src/index.ts";
import { localKeys } from "../lib/local-chain.ts";

const args = process.argv.slice(2);
const opt = (name: string, fallback: string) => { const i = args.indexOf(name); return i >= 0 ? (args[i + 1] ?? fallback) : fallback; };
const base = opt("--url", "http://127.0.0.1:8787").replace(/\/$/, "");
const model = opt("--model", "meta-llama/llama-3.3-70b-instruct");
const prompt = opt("--prompt", "What does HTTP 402 mean?");
const rpc = opt("--rpc", `http://127.0.0.1:${process.env.LAUNCH_CHAIN_PORT ?? 8899}`);

const keypairFile = opt("--keypair", "");
const payer = keypairFile ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(keypairFile, "utf8")) as number[])) : localKeys(resolve(import.meta.dir, "../../.data/launch-chain")).payer;
const unit = keypairFile ? "USDC" : "test USDC";
const conn = new Connection(rpc, "confirmed");
const body = JSON.stringify({ model, max_tokens: 64, messages: [{ role: "user", content: prompt }] });
const call = (headers: Record<string, string> = {}) => fetch(`${base}/api/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });

// 1. No key, no payment: the router answers 402 with what the call costs and where to pay.
const quote = await call();
if (quote.status !== 402) throw new Error(`expected 402 Payment Required, got ${quote.status}: ${(await quote.text()).slice(0, 300)}`);
const accept = ((await quote.json()) as { accepts: { network: string; maxAmountRequired: string; payTo: string; asset: string; extra: { feePayer: string; decimals: number } }[] }).accepts[0]!;
const mint = new PublicKey(accept.asset);
const amount = BigInt(accept.maxAmountRequired);
const from = getAssociatedTokenAddressSync(mint, payer.publicKey, true);
const before = (await getAccount(conn, from, "confirmed")).amount;
console.log(`price       ${Number(amount) / 10 ** accept.extra.decimals} USDC to ${accept.payTo} (${accept.network})`);
console.log(`wallet      ${payer.publicKey.toBase58()}: ${Number(before) / 1e6} ${unit}, ${await conn.getBalance(payer.publicKey, "confirmed")} lamports`);

// 2. The wallet signs a USDC transfer whose fee payer is the router; the router adds its signature and sends it.
const { blockhash } = await conn.getLatestBlockhash("confirmed");
const tx = new Transaction({ feePayer: new PublicKey(accept.extra.feePayer), recentBlockhash: blockhash });
tx.add(createTransferCheckedInstruction(from, mint, getAssociatedTokenAddressSync(mint, new PublicKey(accept.payTo), true), payer.publicKey, amount, accept.extra.decimals));
tx.partialSign(payer);
const transaction = Buffer.from(tx.serialize({ requireAllSignatures: false, verifySignatures: false })).toString("base64");
const header = Buffer.from(JSON.stringify({ x402Version: 1, scheme: "exact", network: accept.network, payload: { transaction } })).toString("base64");

// 3. The same call with the payment attached.
const paid = await call({ "x-payment": header });
if (paid.status !== 200) throw new Error(`the paid call answered ${paid.status}: ${(await paid.text()).slice(0, 400)}`);
const settled = JSON.parse(Buffer.from(paid.headers.get("x-payment-response") ?? "", "base64").toString("utf8") || "{}") as { success?: boolean; transaction?: string };
const answer = (await paid.json()) as { id: string; choices: { message: { content: string } }[]; receipt: { id: string; payload: Record<string, unknown>; sig: string; key_id: string } };
const after = (await getAccount(conn, from, "confirmed")).amount;
const keys = await (await fetch(`${base}/.well-known/trellis-receipt-keys.json`)).json();
const verdict = await verifyReceipt(answer.receipt as never, { keys } as never);
console.log(`answer      ${answer.choices[0]?.message.content.slice(0, 100)}`);
console.log(`settled     ${settled.success === true} in transaction ${settled.transaction}`);
console.log(`paid        ${Number(before - after) / 1e6} ${unit} left the wallet`);
console.log(`receipt     ${answer.receipt.id}: mode ${answer.receipt.payload.mode}, paid_with ${answer.receipt.payload.paid_with}, signature ${verdict.valid ? "valid" : "INVALID"}`);

// 4. A payment is good for one call.
const replay = await call({ "x-payment": header });
console.log(`replay      refused with ${replay.status}${replay.status === 200 ? " (UNEXPECTED: the payment was accepted twice)" : ""}`);
if (!settled.success || !verdict.valid || replay.status === 200) process.exit(1);
