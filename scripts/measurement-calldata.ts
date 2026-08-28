// Print the trellis_measurements register instructions the measurement keeper prepared (nothing is sent), or record
// the transaction the registry authority sent for one of them.
//
//   bun scripts/measurement-calldata.ts                    list prepared registrations as JSON
//   bun scripts/measurement-calldata.ts --record <id> <signature>
//
// Needs DATABASE_URL (an already-migrated database). The program only accepts register from the registry's authority
// (a Squads 2-of-3 in production), so the transaction is sent by whoever holds that role: `calldata` names the program,
// the authority and, per entry, the instruction's accounts in order and its data in base64. A row becomes "registered"
// only when the router later reads the registry (TRELLIS_MEASUREMENTS_PROGRAM_ID) and finds its entries live.
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { openDatabase } from "../src/db/client.ts";
import { measurements } from "../src/db/schema.ts";
import type { Ctx } from "../src/context.ts";
import { recordSubmission } from "../src/services/measurements.ts";

/** The prepared registration as an object; a row prepared before the Solana registry keeps its text. */
const parse = (text: string | null): unknown => { try { return JSON.parse(text ?? "null"); } catch { return text; } };

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required.");
const args = process.argv.slice(2);
const h = await openDatabase(url, { migrate: false });
try {
  if (args[0] === "--record") {
    const id = Number(args[1]);
    if (!Number.isInteger(id) || !args[2]) throw new Error("usage: --record <id> <txHash>");
    await recordSubmission({ db: h.db } as Ctx, id, args[2]);
    console.log(JSON.stringify({ recorded: id }));
  } else {
    // Current rows only: a superseded row's calldata would register digests the provider no longer runs.
    const rows = await h.db.select().from(measurements).where(and(eq(measurements.status, "ready"), isNotNull(measurements.calldata), isNull(measurements.supersededAt)));
    console.log(
      JSON.stringify(
        rows.map((r) => ({ id: r.id, provider: r.providerId, image_digest: r.imageDigest, compose_hash: r.composeHash, model_digest: r.modelDigest, rekor_entry: r.rekorEntry, to: r.calldataTarget, submitted_tx: r.txHash, registration: parse(r.calldata) })),
        null,
        2,
      ),
    );
  }
} finally {
  await h.close();
}
