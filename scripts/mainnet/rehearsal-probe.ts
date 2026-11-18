// Rehearsal only: things that MUST be refused by the chain, sent for real against the local validator. Each mode sends
// one transaction and exits 1 when the chain refuses it (what rehearse.sh expects) and 0 if it were accepted. It cannot
// run against a public cluster: the mode is fixed to "rehearsal".
//
//   bun scripts/mainnet/rehearsal-probe.ts                    after the hand-over, the OPERATOR key tries to change a config
//                                                             (a lower cap: tightening applies at once for the authority,
//                                                             so this would succeed if the operator still were it)
//   bun scripts/mainnet/rehearsal-probe.ts guardian-cancel    the GUARDIAN key tries to cancel a pending proposal of
//                                                             trellis_credits (resolve_config(apply = false)). The
//                                                             guardian can pause and nothing else (RR-02): Unauthorized
//   bun scripts/mainnet/rehearsal-probe.ts guardian-repause   the GUARDIAN key pauses trellis_credits deposits again inside
//                                                             its cooldown (7 days after its last pause was due to
//                                                             lapse): GuardianCooldown. pause.ts would not even send
//                                                             this; here it is sent, so the refusal is the program's
import { Transaction, sendAndConfirmTransaction, type Keypair, type TransactionInstruction } from "@solana/web3.js";
import { updateConfigIx as creditsUpdateConfigIx } from "../../src/solana/programs/credits.ts";
import { updateConfigIx as tabUpdateConfigIx } from "../../src/solana/programs/tab.ts";
import { assertCluster, connect, deployedPrograms, fail, loadDeployer, loadRecord, readKeypairFile, recordedIds, rpcUrl } from "./lib.ts";
import { cancelIx, pauseIx } from "./plan.ts";

const what = process.argv[2] ?? "operator-update";
const conn = connect(rpcUrl("rehearsal"));
const genesis = await assertCluster(conn, "rehearsal");
const operator = loadDeployer("rehearsal");
const rec = loadRecord("rehearsal", genesis);
const deployed = deployedPrograms(rec);
const ids = recordedIds(rec, deployed);
const guardian = (): Keypair => {
  const file = process.env.REHEARSAL_GUARDIAN_KEYPAIR;
  if (!file) fail("REHEARSAL_GUARDIAN_KEYPAIR is not set.", 2);
  return readKeypairFile(file);
};

let signer: Keypair, ix: TransactionInstruction, sent: string;
if (what === "operator-update") {
  signer = operator;
  ix = deployed.includes("trellis_tab")
    ? tabUpdateConfigIx(ids.trellis_tab, { authority: operator.publicKey, maxCap: 1_000_000n })
    : creditsUpdateConfigIx(ids.trellis_credits, { authority: operator.publicKey, maxBalancePerKey: 1_000_000n });
  sent = "the operator's update_config";
} else if (what === "guardian-cancel") {
  signer = guardian();
  // The pending proposal's rent goes back to the authority that proposed it: the operator key, before the hand-over.
  ix = cancelIx("trellis_credits", ids.trellis_credits, { operator: operator.publicKey, signer: signer.publicKey })!;
  sent = "the guardian's resolve_config(apply = false)";
} else if (what === "guardian-repause") {
  signer = guardian();
  ix = pauseIx("trellis_credits.deposits", ids.trellis_credits, { signer: signer.publicKey, paused: true });
  sent = "the guardian's second set_deposits_paused(true)";
} else fail(`unknown probe ${what}: operator-update, guardian-cancel or guardian-repause`, 2);

try {
  await sendAndConfirmTransaction(conn, new Transaction().add(ix), [signer], { commitment: "confirmed" });
} catch (e) {
  // The program's own error name is what the caller checks (Unauthorized, GuardianCooldown), so the logs are searched for it.
  const logs: string[] = (e as { logs?: string[] }).logs ?? [];
  const code = logs.map((l) => /Error Code: (\w+)/.exec(l)?.[1]).find(Boolean);
  console.error(`the chain refused ${sent}: ${code ? `${code}: ` : ""}${(e as Error).message.split("\n")[0]}`);
  process.exit(1);
}
console.log(`${sent} was ACCEPTED`);
