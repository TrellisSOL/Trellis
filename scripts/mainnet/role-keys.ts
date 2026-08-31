// Generate the router's role keys where they will be used, and print only their public halves.
//
//   bun scripts/mainnet/role-keys.ts --secrets-dir deploy/production/secrets --tier credits   the keys the launch needs
//   bun scripts/mainnet/role-keys.ts --secrets-dir deploy/production/secrets --surface all --tier full --with slasher --with makegood
//
//   --tier minimal|credits|payments|full   which keys are made (default credits, the launch tier): `minimal` has no
//                                          settlement key (there is no credits program for it to sign for), and only
//                                          the tiers with the anchor program need a first receipt signer for its init.
//   --surface core|all                     the launch surface the router will run (LAUNCH_SURFACE; default core). Only
//                                          the keys that surface uses are made, and the ones left out are named. On
//                                          `core` that means: --with slasher, --with makegood and the tiers payments
//                                          and full are refused: their keys belong to features that are not on that
//                                          surface. (The hosted facilitator joined the launch on 2026-11-04, so the
//                                          relay key is made on every surface.)
//
// Run it on the production host (or the machine that will hold the secrets), after `./bootstrap.sh --init` created the
// secrets/*.env files. For each role it makes a fresh ed25519 keypair, writes the base58 secret key straight into the
// right `KEY=` line of the right file (mode 0600), and prints the public key. A secret is never printed, never passed
// on a command line and never written anywhere else; a line that already holds a value is left alone, so a second run
// changes nothing.
//
//   role                 file(s)                         setting
//   router               api.env and tabs.env            ROUTER_PRIVATE_KEY            x402 fee payer; tab payee (worker-tabs)
//   facilitator relay    api.env                         FACILITATOR_RELAY_PRIVATE_KEY pays the hosted facilitator's transaction fees only
//   settlement           settlement.env                  SETTLEMENT_PRIVATE_KEY        credits settlement authority, capacity sale authority
//   anchorer             anchor.env                      ANCHORER_PRIVATE_KEY          trellis_anchor authority
//   slasher (--with)     slasher.env  (surface all only) SLASHER_PRIVATE_KEY           trellis_bond slasher
//   makegood (--with)    makegood.env (surface all only) MAKEGOOD_REFUND_PRIVATE_KEY   make-good refund treasury
//   first receipt signer nowhere                         (public key only)             see below
//
// The first receipt signer: trellis_anchor needs a signer at init, before any router exists. The router then makes and
// rotates its own receipt keys and the anchor worker publishes the current one within an hour of starting. So this
// script generates that first key, prints its public half for MAINNET_RECEIPT_SIGNER and discards the secret: nobody,
// including you, can ever sign a receipt with it.
//
// Not made here, on purpose: the deployer key (make it on the machine that deploys: solana-keygen new), the three
// multisig member keys (hardware wallets, created by their holders) and the GUARDIAN key. The guardian pauses the
// programs with one signature; it belongs on a device of its own (a hardware wallet, or a keypair file on a machine
// that is not this host), never beside the worker keys: `solana-keygen new --outfile <path>` there, and put its public
// key in MAINNET_GUARDIAN. The output is the public-key block for
// .env.mainnet.local (config/mainnet.env.example), which init.ts and the monitor read.
import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Keypair } from "@solana/web3.js";
import { base58Encode } from "../../src/solana/constants.ts";
import { signerAddress } from "../../src/solana/keys.ts";

const argv = process.argv.slice(2);
let dir = "";
const extra = new Set<string>();
let tier = "credits";
let surface = "core";
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--secrets-dir") dir = argv[++i] ?? "";
  else if (argv[i] === "--surface") { surface = argv[++i] ?? ""; if (surface !== "core" && surface !== "all") { console.error("--surface takes core or all"); process.exit(2); } }
  else if (argv[i] === "--tier") { tier = argv[++i] ?? ""; if (!["minimal", "credits", "payments", "full"].includes(tier)) { console.error("--tier takes minimal, credits, payments or full"); process.exit(2); } }
  else if (argv[i] === "--with") { const v = argv[++i] ?? ""; if (v !== "slasher" && v !== "makegood") { console.error("--with takes slasher or makegood"); process.exit(2); } extra.add(v); }
  else { console.error(`unknown argument ${argv[i]}`); process.exit(2); }
}
if (!dir) { console.error("usage: bun scripts/mainnet/role-keys.ts --secrets-dir <dir> [--tier minimal|credits|payments|full] [--surface core|all] [--with slasher] [--with makegood]"); process.exit(2); }
// The core surface runs tier credits or minimal and none of the features these keys belong to (src/surface/config.ts
// refuses their settings in production). A key the router would refuse is not made: it is asked for with --surface all.
const core = surface === "core";
if (core && (tier === "payments" || tier === "full")) { console.error(`tier ${tier} needs programs that are not on the core launch surface: use --tier credits (or minimal), or --surface all once those features have been reviewed (security/DEFERRED.md).`); process.exit(2); }
if (core && extra.size) { console.error(`--with ${[...extra][0]} makes a key of a feature that is not on the core launch surface, and a production router refuses to start with it. Pass --surface all when that feature has been reviewed and enabled.`); process.exit(2); }
const hasCredits = tier !== "minimal";
const hasAnchorProgram = tier === "payments" || tier === "full";
dir = resolve(dir);

/** The value of KEY= in a file, or "" when the line is empty. Exits when the file or the line is missing. */
function current(file: string, key: string): string {
  const path = join(dir, file);
  if (!existsSync(path)) { console.error(`${file} is missing in the secrets directory: run ./bootstrap.sh --init first`); process.exit(1); }
  // These files hold the role keys' secrets: one that its group or anyone else can read is not loaded (R3-21).
  if ((statSync(path).mode & 0o077) !== 0) { console.error(`${file} in the secrets directory is readable by other users (mode ${(statSync(path).mode & 0o777).toString(8)}); chmod 600`); process.exit(2); }
  const m = new RegExp(`^${key}=(.*)$`, "m").exec(readFileSync(path, "utf8"));
  if (!m) { console.error(`${file} has no ${key}= line`); process.exit(1); }
  return m[1]!.trim();
}
function write(file: string, key: string, value: string): void {
  const path = join(dir, file);
  writeFileSync(path, readFileSync(path, "utf8").replace(new RegExp(`^${key}=.*$`, "m"), `${key}=${value}`), { mode: 0o600 });
  chmodSync(path, 0o600);
}
/** One role key in one or more files: reuse the value that is there, else generate. Returns the public key. */
function role(name: string, key: string, files: string[]): string {
  const existing = files.map((f) => current(f, key)).filter(Boolean);
  if (new Set(existing).size > 1) { console.error(`${key} differs between ${files.join(" and ")}: they must hold the same key`); process.exit(1); }
  let secret = existing[0];
  let made = false;
  if (!secret) { secret = base58Encode(Keypair.generate().secretKey); made = true; }
  const address = signerAddress(secret);
  if (!address) { console.error(`${key} in ${files[0]} is not a base58 64-byte ed25519 secret key`); process.exit(1); }
  for (const f of files) if (current(f, key) !== secret) write(f, key, secret);
  console.error(`${made ? "generated" : "kept     "} ${name.padEnd(18)} ${address}  (${files.join(", ")})`);
  return address;
}

// The router key is also the tab payee: worker-tabs (the tab-close job, on the launch since 2026-11-04) signs with it.
const router = role("router", "ROUTER_PRIVATE_KEY", ["api.env", "tabs.env"]);
const relay = role("facilitator relay", "FACILITATOR_RELAY_PRIVATE_KEY", ["api.env"]);
const settlement = hasCredits ? role("settlement", "SETTLEMENT_PRIVATE_KEY", ["settlement.env"]) : null;
const anchorer = role("anchorer", "ANCHORER_PRIVATE_KEY", ["anchor.env"]);
const slasher = extra.has("slasher") ? role("slasher", "SLASHER_PRIVATE_KEY", ["slasher.env"]) : null;
if (extra.has("makegood")) role("makegood refund", "MAKEGOOD_REFUND_PRIVATE_KEY", ["makegood.env"]);
const receipt = hasAnchorProgram ? Keypair.generate().publicKey.toBase58() : null; // the secret half is dropped here, on purpose

console.error("\nPublic keys for .env.mainnet.local (nothing below is secret):\n");
console.log([
  settlement ? `MAINNET_SETTLEMENT_AUTHORITY=${settlement}` : "# MAINNET_SETTLEMENT_AUTHORITY=   (tier minimal has no credits program)",
  `MAINNET_ANCHORER=${anchorer}`,
  `ANCHORER_ADDRESS=${anchorer}   # for the API's own env file: the public key it publishes and writes into proofs`,
  slasher ? `MAINNET_SLASHER=${slasher}` : "# MAINNET_SLASHER=   (only with trellis_bond: run again with --with slasher)",
  receipt ? `MAINNET_RECEIPT_SIGNER=${receipt}` : "# MAINNET_RECEIPT_SIGNER=   (only trellis_anchor's init needs one; in memo mode the router announces its receipt keys itself)",
  `MONITOR_ROUTER_ADDRESS=${router}`,
  `MONITOR_FACILITATOR_RELAY_ADDRESS=${relay}`,
  "# MAINNET_GUARDIAN=   (the pause key: made on a device of its own, not here)",
].join("\n"));
console.error("\nFund with SOL for fees before the first start: the preflight prints the amount for each address (about 0.1 SOL each; MAINNET.md, section 6).");
if (receipt) console.error("MAINNET_RECEIPT_SIGNER is printed once and its secret was discarded: copy the line now. A second run prints a different one, which is fine before init and useless after.");
