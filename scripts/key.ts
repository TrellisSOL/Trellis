// Offline key tool. Keys are self-custodial: nothing here talks to the router.
//   bun scripts/key.ts new                          new API key + its on-chain identity
//   bun scripts/key.ts info <sk-tr-v1-...>          derive key hash / address
// Credits are spend-only on Trellis, so there is no withdrawal command.
import { deriveKey, generateApiKey, KEY_RE } from "../src/solana/keys.ts";

const [cmd, ...args] = process.argv.slice(2);
const credits = process.env.CREDITS_ADDRESS;

function show(secret: string) {
  const d = deriveKey(secret);
  console.log(JSON.stringify({ key: secret, key_hash: d.chainKeyHash, key_address: d.keyAddress, label: d.label }, null, 2));
  if (credits) console.log(`\nDeposit USDC to this key's balance on the credits program ${credits} (key hash ${d.chainKeyHash}).`); // TODO(solana): print the deposit instruction
}

if (cmd === "new") show(generateApiKey());
else if (cmd === "info" && args[0] && KEY_RE.test(args[0])) show(args[0]);
else {
  console.error("usage: bun scripts/key.ts new | info <key>");
  process.exit(2);
}
