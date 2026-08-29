// After a database restore: rebuild what the chain can rebuild, report what it cannot, and lift the freeze on vault
// outflows only when what is left has been acknowledged (security review R5-08, R5-20; src/services/restore-reconcile.ts
// says exactly what is rebuilt and what is not). Run it with ingress and workers OFF, with the router's own environment:
//
//   bun scripts/restore-reconcile.ts                                  dry run: prints the report, changes nothing
//   bun scripts/restore-reconcile.ts --key-document keys.json         also compares the receipt keys with a saved copy of
//                                                                     GET /api/v1/receipts/keys (keep one off the database host)
//   bun scripts/restore-reconcile.ts --apply [--key-document f]       imports the chain's spent root, repairs receipt keys,
//                                                                     sets the x402 watermark
//   bun scripts/restore-reconcile.ts --apply --acknowledge-gap-usdc N as above, and accepts the usage gap of exactly N USDC
//                                                                     units (the figure the report prints) as written off
//
// Exit status: 0 when vault outflows are not frozen at the end, 1 while they still are (the report says why), 2 on a
// usage error. The report never contains a key, a secret or the RPC address.
import { readFileSync } from "node:fs";
import { createApp } from "../src/app.ts";
import { restoreReconcile } from "../src/services/restore-reconcile.ts";
import { restoreState } from "../src/services/settlement.ts";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const value = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const known = new Set(["--apply", "--acknowledge-gap-usdc", "--key-document"]);
for (const [i, a] of args.entries()) if (a.startsWith("--") ? !known.has(a) : !["--acknowledge-gap-usdc", "--key-document"].includes(args[i - 1] ?? "")) { console.error(`Unknown argument: ${a}`); process.exit(2); }
const ack = value("--acknowledge-gap-usdc");
if (ack !== undefined && !/^\d+$/.test(ack)) { console.error("--acknowledge-gap-usdc takes a whole number of USDC units (the report's usage_gap_usdc)."); process.exit(2); }
if (ack !== undefined && !flag("--apply")) { console.error("--acknowledge-gap-usdc only means something with --apply."); process.exit(2); }
let keyDocument: unknown;
const keyFile = value("--key-document");
if (keyFile) {
  try { keyDocument = JSON.parse(readFileSync(keyFile, "utf8")); } catch { console.error("--key-document: the file could not be read as JSON."); process.exit(2); }
}

const { ctx, close } = await createApp({ env: { WORKERS: "false", AUTO_MIGRATE: "false" }, startJobs: false });
try {
  // The anchor job's own read-only comparison of its rows with the chain, when this build has one (services/anchor.ts).
  const anchor = (await import("../src/services/anchor.ts")) as { compareAnchorsWithChain?: (ctx: unknown) => Promise<unknown> };
  const report = await restoreReconcile(ctx, { apply: flag("--apply"), acknowledgeGapUsdc: ack === undefined ? null : BigInt(ack), keyDocument, ...(anchor.compareAnchorsWithChain ? { auditAnchors: () => anchor.compareAnchorsWithChain!(ctx) } : {}) });
  console.log(JSON.stringify(report, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  const frozen = (await restoreState(ctx))?.frozen === true;
  if (frozen) console.error(`Vault outflows are still FROZEN: ${report.still_frozen_because.join("; ") || "see the report"}.`);
  process.exitCode = frozen ? 1 : 0;
} finally {
  await close();
}
