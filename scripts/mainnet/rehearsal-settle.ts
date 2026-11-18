// Rehearsal only: makes the settlement key do, on the local validator, what the chain monitor exists to notice.
//
//   bun scripts/mainnet/rehearsal-settle.ts      prints SETTLE_KNOWN=<token account> and SETTLE_UNKNOWN=<token account>
//
//   bun scripts/mainnet/rehearsal-settle.ts made-up-root <usdc>    only a spent root of <usdc> for the hour that just
//                                                                   closed, and ten times that much fixture USDC in the
//                                                                   vault (the program wants the spend covered; the
//                                                                   monitor pages on a root above half the vault, which
//                                                                   is not what this mode is there to show): what a
//                                                                   stolen settlement key leaves behind, for the
//                                                                   write-down of config-change.ts to repair (R5-16).
//                                                                   Prints nothing on stdout.
//
// It mints 10,000 fixture USDC straight into the credits vault (the rehearsal deployer is the fixture mint's authority),
// then, signed by the rehearsal's settlement key exactly as the settlement worker would:
//   commit_spent_root   the hour that just closed, with a delta of 3,000 USDC
//   settle_to_host      120 USDC to a token account the rehearsal then puts on the monitor's allow-list
//   settle_to_host      120 USDC to a token account nobody knows
// 240 USDC is nearly all the limiter lets out at once this soon after init: a new limiter has no history of the vault,
// so for its first two 24-hour epochs only the floor applies (1,000 USDC per 24 h, a quarter of it at once: 250). The
// settlement allowance is left almost empty. scripts/mainnet/rehearse.sh then runs the monitor against these real transactions:
// the program's own event logs, decoded through the IDL. It cannot run against a public cluster: the mode is fixed to
// "rehearsal", and the fixture mint exists on no other chain.
import { randomBytes } from "node:crypto";
import { Keypair, PublicKey, Transaction, sendAndConfirmTransaction, type TransactionInstruction } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, createMintToInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { commitSpentRootIx, creditsPdas, settleToHostIx } from "../../src/solana/programs/credits.ts";
import { assertCluster, connect, fail, loadDeployer, loadRecord, readKeypairFile, recordedIds, rpcUrl } from "./lib.ts";
import { MAINNET_USDC, USDC } from "./params.ts";
import { chainTime } from "./state.ts";

const conn = connect(rpcUrl("rehearsal"));
const genesis = await assertCluster(conn, "rehearsal");
const deployer = loadDeployer("rehearsal");
const file = process.env.REHEARSAL_SETTLEMENT_KEYPAIR;
if (!file) fail("REHEARSAL_SETTLEMENT_KEYPAIR is not set (scripts/mainnet/rehearsal-fixtures.ts exports it).", 2);
const settlement = readKeypairFile(file);
const rec = loadRecord("rehearsal", genesis);
const id = recordedIds(rec, ["trellis_credits"]).trellis_credits;
const mint = new PublicKey(MAINNET_USDC);
const { vault } = creditsPdas(id);
const send = (ixs: TransactionInstruction[], signers: Keypair[]) => sendAndConfirmTransaction(conn, new Transaction().add(...ixs), signers, { commitment: "confirmed" });

if (process.argv[2] === "made-up-root") {
  const amount = Number(process.argv[3]);
  if (!Number.isSafeInteger(amount) || amount <= 0) fail("usage: bun scripts/mainnet/rehearsal-settle.ts made-up-root <whole USDC>", 2);
  await send([createMintToInstruction(mint, vault, deployer.publicKey, USDC(amount * 10))], [deployer]);
  const closed = BigInt(Math.floor((await chainTime(conn)) / 3600) * 3600);
  const sig = await send([commitSpentRootIx(id, { settlement: settlement.publicKey, hour: closed, root: randomBytes(32), spentDelta: USDC(amount) })], [settlement]);
  console.error(`committed a made-up spent root for hour ${closed} (delta ${amount} USDC, nothing settled): ${sig}`);
  process.exit(0);
}
if (process.argv[2] !== undefined) fail(`unknown mode ${process.argv[2]}: no argument, or made-up-root <usdc>`, 2);
const known = Keypair.generate().publicKey, unknown = Keypair.generate().publicKey;
const ata = (owner: PublicKey) => getAssociatedTokenAddressSync(mint, owner, true);
await send([
  createMintToInstruction(mint, vault, deployer.publicKey, USDC(10_000)),
  createAssociatedTokenAccountIdempotentInstruction(deployer.publicKey, ata(known), known, mint),
  createAssociatedTokenAccountIdempotentInstruction(deployer.publicKey, ata(unknown), unknown, mint),
], [deployer]);
const hour = BigInt(Math.floor((await chainTime(conn)) / 3600) * 3600);
const settle = (to: PublicKey) => settleToHostIx(id, { settlement: settlement.publicKey, hour, amount: USDC(120), hostToken: to, mint });
const commit = await send([commitSpentRootIx(id, { settlement: settlement.publicKey, hour, root: randomBytes(32), spentDelta: USDC(3_000) })], [settlement]);
const first = await send([settle(ata(known))], [settlement]);
const second = await send([settle(ata(unknown))], [settlement]);
console.error(`committed a spent root for hour ${hour} (delta 3,000 USDC): ${commit}`);
console.error(`settled 120 USDC to a known account (${first}) and 120 USDC to an unknown one (${second})`);
console.log(`SETTLE_KNOWN=${ata(known).toBase58()}`);
console.log(`SETTLE_UNKNOWN=${ata(unknown).toBase58()}`);
