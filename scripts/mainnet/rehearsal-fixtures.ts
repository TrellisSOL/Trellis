// Fixtures for scripts/mainnet/rehearse.sh: throwaway keys and the account files a local validator is started with, so a
// rehearsal exercises the mainnet code paths with mainnet's own addresses where it matters.
//
//   bun scripts/mainnet/rehearsal-fixtures.ts <dir>
//
// Writes into <dir> (under the gitignored .data/): a deployer keypair, role keypairs (settlement, anchorer, slasher,
// receipt signer), a guardian keypair (the pause key: a key of its own), three multisig member keypairs, and validator
// account files for
//   - a USDC mint at the MAINNET USDC address (classic SPL Token, 6 decimals, mint authority = the rehearsal deployer)
//   - a $TRLS mint (Token-2022, no extensions, 9 decimals)
//   - a Squads v4 multisig account (2-of-3, autonomous, one transaction created) owned by the Squads program id, and
//     that one transaction as a multisig leaves it once it worked: a VaultTransaction of vault 0 and its Proposal in
//     state Executed, approved by two members ("tested" means executed, not created: REVIEW-ROUND4 R4-29)
//   - the same account as it would be for a multisig that has never created a transaction (part 2 starts its validator
//     with this one: the stand-in vault program creates no Squads transaction, so there the bypass is the honest case)
//   - multisig accounts that must be REFUSED, each at an address of its own: threshold 1, a config authority (a
//     "controlled" multisig), an extra member, a member without the vote permission, one owned by another program,
//     one that created a transaction and executed none, and one whose third member is the guardian key
// and prints the environment the rehearsal runs with. These keys are generated here, never leave <dir>, and are worthless:
// they only ever exist on a local validator.
//
// The multisig account is encoded by this file and decoded by squads.ts, which checks the decoder against this encoder,
// not against Squads itself: compare the handover's printout of the real multisig with the Squads app before signing.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Keypair, PublicKey } from "@solana/web3.js";
import { MINT_SIZE, MintLayout, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { readKeypairFile } from "./lib.ts";
import { MAINNET_USDC, SQUADS_V4_PROGRAM } from "./params.ts";
import { transactionPdas, vaultPda } from "./squads.ts";

const dir = process.argv[2];
if (!dir) { console.error("usage: bun scripts/mainnet/rehearsal-fixtures.ts <dir>"); process.exit(2); }
mkdirSync(dir, { recursive: true, mode: 0o700 });

function keypair(name: string): Keypair {
  const file = join(dir!, `${name}.json`);
  if (existsSync(file)) return readKeypairFile(file);
  const kp = Keypair.generate();
  writeFileSync(file, JSON.stringify(Array.from(kp.secretKey)), { mode: 0o600 });
  return kp;
}
const deployer = keypair("deployer");
const roles = { settlement: keypair("settlement"), anchorer: keypair("anchorer"), slasher: keypair("slasher"), receiptSigner: keypair("receipt-signer"), guardian: keypair("guardian") };
const members = [keypair("member-1"), keypair("member-2"), keypair("member-3")];
const trlsMint = keypair("trls-mint").publicKey;
const multisig = keypair("multisig-account").publicKey; // only its address is used: the account is owned by the Squads program id
const vault = vaultPda(multisig, 0);

const rent = (bytes: number) => (bytes + 128) * 6960; // rent-exempt minimum on every cluster today
function accountFile(name: string, address: PublicKey, owner: PublicKey, data: Buffer): string {
  const file = join(dir!, `${name}.account.json`);
  writeFileSync(file, JSON.stringify({ pubkey: address.toBase58(), account: { lamports: rent(data.length), data: [data.toString("base64"), "base64"], owner: owner.toBase58(), executable: false, rentEpoch: 0, space: data.length } }));
  return file;
}
function mintData(decimals: number, authority: PublicKey): Buffer {
  const data = Buffer.alloc(MINT_SIZE);
  MintLayout.encode({ mintAuthorityOption: 1, mintAuthority: authority, supply: 0n, decimals, isInitialized: true, freezeAuthorityOption: 0, freezeAuthority: PublicKey.default }, data);
  return data;
}
function multisigData(v: { threshold?: number; transactions?: bigint; configAuthority?: PublicKey; members?: { key: PublicKey; mask: number }[]; timeLock?: number } = {}): Buffer {
  const list = v.members ?? members.map((m) => ({ key: m.publicKey, mask: 7 }));
  const head = Buffer.alloc(8 + 32 + 32 + 2 + 4 + 8 + 8 + 1 + 1 + 4);
  let o = 0;
  createHash("sha256").update("account:Multisig").digest().copy(head, o, 0, 8); o += 8;
  Keypair.generate().publicKey.toBuffer().copy(head, o); o += 32; // create_key
  if (v.configAuthority) v.configAuthority.toBuffer().copy(head, o); // config_authority: all zeros = autonomous
  o += 32;
  head.writeUInt16LE(v.threshold ?? 2, o); o += 2; // threshold
  head.writeUInt32LE(v.timeLock ?? 3600, o); o += 4; // time_lock: one hour (a multisig with none is refused: R5-17, the ZERO_TIME_LOCK account below)
  head.writeBigUInt64LE(v.transactions ?? 1n, o); o += 8; // transaction_index: one transaction created
  head.writeBigUInt64LE(0n, o); o += 8; // stale_transaction_index
  head[o++] = 0; // rent_collector: None
  head[o++] = 255; // bump
  head.writeUInt32LE(list.length, o);
  return Buffer.concat([head, ...list.map((m) => Buffer.concat([m.key.toBuffer(), Buffer.from([m.mask])]))]);
}

const u64 = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };
const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const disc = (name: string) => createHash("sha256").update(`account:${name}`).digest().subarray(0, 8);
/** A Squads v4 `Proposal` in state Executed (variant 5) with two approvals: multisig | transaction_index | status | bump | approved | rejected | cancelled. */
const executedProposal = (ms: PublicKey, index: bigint) => Buffer.concat([disc("Proposal"), ms.toBuffer(), u64(index), Buffer.from([5]), u64(1_750_000_000n), Buffer.from([255]), u32(2), members[0]!.publicKey.toBuffer(), members[1]!.publicKey.toBuffer(), u32(0), u32(0)]);
/** A Squads v4 `VaultTransaction` of vault 0, up to its message: multisig | creator | index | bump | vault_index | vault_bump | ephemeral_signer_bumps. */
const vaultTransaction = (ms: PublicKey, index: bigint) => Buffer.concat([disc("VaultTransaction"), ms.toBuffer(), members[0]!.publicKey.toBuffer(), u64(index), Buffer.from([255, 0, 254]), u32(0), Buffer.alloc(40)]);
const executed = transactionPdas(multisig, 1n);

const files = {
  usdc: accountFile("usdc-mint", new PublicKey(MAINNET_USDC), TOKEN_PROGRAM_ID, mintData(6, deployer.publicKey)),
  trls: accountFile("trls-mint", trlsMint, TOKEN_2022_PROGRAM_ID, mintData(9, deployer.publicKey)),
  multisig: accountFile("squads-multisig", multisig, new PublicKey(SQUADS_V4_PROGRAM), multisigData()),
  untested: accountFile("squads-multisig-untested", multisig, new PublicKey(SQUADS_V4_PROGRAM), multisigData({ transactions: 0n })),
  // The multisig's one transaction, executed: what "it has made its vault sign" looks like on chain.
  proposal: accountFile("squads-proposal-1", executed.proposal, new PublicKey(SQUADS_V4_PROGRAM), executedProposal(multisig, 1n)),
  transaction: accountFile("squads-vault-transaction-1", executed.transaction, new PublicKey(SQUADS_V4_PROGRAM), vaultTransaction(multisig, 1n)),
};
// Multisig accounts a hand-over must refuse. Each has an address of its own, so the refusal always names two things:
// what is wrong with the account, and that the vault holding the programs is not derived from it.
const squads = new PublicKey(SQUADS_V4_PROGRAM);
const all = members.map((m) => ({ key: m.publicKey, mask: 7 }));
const bad: [string, PublicKey, PublicKey, Buffer][] = [
  ["THRESHOLD1", keypair("multisig-threshold1").publicKey, squads, multisigData({ threshold: 1 })],
  ["CONTROLLED", keypair("multisig-controlled").publicKey, squads, multisigData({ configAuthority: keypair("multisig-config-authority").publicKey })],
  ["EXTRA_MEMBER", keypair("multisig-extra-member").publicKey, squads, multisigData({ members: [...all, { key: keypair("member-4").publicKey, mask: 7 }] })],
  ["NO_VOTE", keypair("multisig-no-vote").publicKey, squads, multisigData({ members: [all[0]!, all[1]!, { key: members[2]!.publicKey, mask: 5 }] })],
  ["FOREIGN_OWNER", keypair("multisig-foreign-owner").publicKey, TOKEN_PROGRAM_ID, multisigData()],
  // One transaction created, none executed: no Proposal and no VaultTransaction account exists for it.
  ["CREATED_ONLY", keypair("multisig-created-only").publicKey, squads, multisigData()],
  // The guardian key as the third member: the brake and a vote for the authority it brakes on one key.
  ["GUARDIAN_MEMBER", keypair("multisig-guardian-member").publicKey, squads, multisigData({ members: [all[0]!, all[1]!, { key: roles.guardian.publicKey, mask: 7 }] })],
  // No time lock: an upgrade two members approve replaces a program at once (R5-17).
  ["ZERO_TIME_LOCK", keypair("multisig-zero-time-lock").publicKey, squads, multisigData({ timeLock: 0 })],
];
const badFiles = bad.map(([name, address, owner, data]) => [name, address, accountFile(`squads-multisig-${name.toLowerCase()}`, address, owner, data)] as const);
const common = `--account ${MAINNET_USDC} ${files.usdc} --account ${trlsMint.toBase58()} ${files.trls} ${badFiles.map(([, address, file]) => `--account ${address.toBase58()} ${file}`).join(" ")}`;
// Shell-evaluable output: validator arguments and the environment of the rehearsal. Public keys and local paths only.
const lines = [
  `VALIDATOR_ACCOUNTS=(${common} --account ${multisig.toBase58()} ${files.multisig} --account ${executed.proposal.toBase58()} ${files.proposal} --account ${executed.transaction.toBase58()} ${files.transaction})`,
  // Part 2: the same multisig address, never having created a transaction.
  `VALIDATOR_ACCOUNTS_UNTESTED=(${common} --account ${multisig.toBase58()} ${files.untested})`,
  ...badFiles.map(([name, address]) => `REHEARSAL_MULTISIG_${name}=${address.toBase58()}`),
  // What the multisig is expected to be: these members, each with every permission, threshold 2 (the default).
  `export MAINNET_MULTISIG_MEMBERS=${members.map((m) => m.publicKey.toBase58()).join(",")}`,
  `REHEARSAL_STRANGER_MEMBER=${keypair("member-4").publicKey.toBase58()}`,
  `export REHEARSAL_DEPLOYER_KEYPAIR=${join(dir, "deployer.json")}`,
  `export MAINNET_MULTISIG_VAULT=${vault.toBase58()}`,
  `export REHEARSAL_MULTISIG_ACCOUNT=${multisig.toBase58()}`,
  `export MAINNET_GUARDIAN=${roles.guardian.publicKey.toBase58()}`,
  `export REHEARSAL_GUARDIAN_KEYPAIR=${join(dir, "guardian.json")}`,
  `export MAINNET_SETTLEMENT_AUTHORITY=${roles.settlement.publicKey.toBase58()}`,
  `export REHEARSAL_SETTLEMENT_KEYPAIR=${join(dir, "settlement.json")}`,
  `export MAINNET_ANCHORER=${roles.anchorer.publicKey.toBase58()}`,
  `export MAINNET_SLASHER=${roles.slasher.publicKey.toBase58()}`,
  `export MAINNET_RECEIPT_SIGNER=${roles.receiptSigner.publicKey.toBase58()}`,
  `export MAINNET_TRLS_MINT=${trlsMint.toBase58()}`,
  `export MAINNET_GRADE_PRICES_USDC=1,2,4`,
  `REHEARSAL_DEPLOYER=${deployer.publicKey.toBase58()}`,
  `REHEARSAL_ANCHORER_KEYPAIR=${join(dir, "anchorer.json")}`,
];
console.log(lines.join("\n"));
