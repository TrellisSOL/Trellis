// Record what a provider invoiced for one UTC day, for the daily reconciliation (security review R4-02;
// src/services/reconcile.ts). The `provider-reconcile` job compares it with what the router recorded as owed to that
// provider and with what its calls collected, and alarms on a difference above RECONCILE_GAP_ALARM_USD.
//
//   DATABASE_URL=... bun scripts/provider-invoice.ts <provider id> <YYYY-MM-DD> <USD amount>
//   DATABASE_URL=... bun scripts/provider-invoice.ts --run            # run the reconciliation of yesterday now and print it
//
// It writes one kv row (provider-invoice:<provider>:<day>) and moves no money.
import { createApp } from "../src/app.ts";
import { usdToPico } from "../src/lib/money.ts";
import { recordProviderInvoice, runProviderReconcile } from "../src/services/reconcile.ts";

const args = process.argv.slice(2);
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required.");
const { ctx, close } = await createApp({ env: { WORKERS: "false", AUTO_MIGRATE: "false" }, startJobs: false });
try {
  if (args[0] === "--run") {
    console.log(JSON.stringify(await runProviderReconcile(ctx), null, 2));
  } else {
    const [provider, day, usd] = args;
    if (!provider || !day || !usd || !/^\d+(\.\d+)?$/.test(usd)) throw new Error("usage: bun scripts/provider-invoice.ts <provider id> <YYYY-MM-DD> <USD amount> | --run");
    await recordProviderInvoice(ctx, provider, day, usdToPico(Number(usd)).toString());
    console.log(`recorded: ${provider} invoiced ${usd} USD for ${day}`);
  }
} finally {
  await close();
}
