import { z } from "zod";
import { ADDRESS_RE, SIGNATURE_RE } from "./constants.ts";
import { signerAddress } from "./keys.ts";
import { DEFAULT_MAX_LATE_SECONDS, anchorerKeysProblem, networkRef, type AnchorerKey } from "./anchor-memo.ts";

// Launch tiers and the receipt-anchor mode: which Trellis programs a deployment has, and what the router does without
// the others. A program costs rent for as long as it lives (about 6.96 SOL per MB), so a launch deploys only what it
// uses and adds the rest later (MAINNET.md, "Launch tiers").
//
//   LAUNCH_TIER   programs the router requires in production            what users get
//   minimal       none                                                  pay-per-call x402; receipt roots as memo transactions
//   credits       trellis_credits                                       + prepaid credits (deposits, closure refunds)
//   payments      trellis_credits, trellis_tab, trellis_anchor          + tabs; receipt roots in the anchor program
//   full          those three and trellis_bond (the default)            + host bonds; with rules, capacity, the fee
//                                                                         router and the registry where their ids are set
//
// The tier is the MINIMUM: a program id that is set beyond the tier switches its feature on. A feature whose program id
// is not set is off: /api/v1/status says so under `launch_tier.features`, and its routes answer 503 `chain_unconfigured`
// ("The <name> program is not configured on this router.") or their own not-enabled answer. Every other production
// guard is unchanged.
//
// ANCHOR_MODE: `program` posts each hour's receipt root to trellis_anchor (one account per hour, rent returned after
// 400 days); `memo` posts it as an SPL Memo transaction signed by the anchorer key (src/solana/anchor-memo.ts: no rent,
// and weaker in the ways that file lists). Default: `program` when the anchor program id is set, otherwise `memo`.

const address = z.string().regex(ADDRESS_RE, "must be a base58 address").optional().or(z.literal("").transform(() => undefined));
const text = z.string().optional().transform((v) => (v ? v : undefined));

export const LAUNCH_TIERS = ["minimal", "credits", "payments", "full"] as const;
export type LaunchTier = (typeof LAUNCH_TIERS)[number];
/** The legacy setting names the production guard reads, per tier (CALLPAY_ADDRESS carries trellis_tab, PROVIDER_BOND_ADDRESS trellis_bond). */
export const TIER_REQUIRED: Record<LaunchTier, readonly ("CREDITS_ADDRESS" | "CALLPAY_ADDRESS" | "RECEIPT_ANCHOR_ADDRESS" | "PROVIDER_BOND_ADDRESS")[]> = {
  minimal: [],
  credits: ["CREDITS_ADDRESS"],
  payments: ["CREDITS_ADDRESS", "CALLPAY_ADDRESS", "RECEIPT_ANCHOR_ADDRESS"],
  full: ["CREDITS_ADDRESS", "CALLPAY_ADDRESS", "RECEIPT_ANCHOR_ADDRESS", "PROVIDER_BOND_ADDRESS"],
};

export const launchEnv = {
  LAUNCH_TIER: z.enum(LAUNCH_TIERS).default("full"),
  ANCHOR_MODE: z.enum(["memo", "program"]).optional().or(z.literal("").transform(() => undefined)),
  // The anchorer's public key, for processes that do not hold ANCHORER_PRIVATE_KEY (the API publishes it and writes it
  // into proofs). On the anchor worker it must be the public half of ANCHORER_PRIVATE_KEY.
  ANCHORER_ADDRESS: address,
  // JSON, oldest first, only after the first rotation: [{"key":"<first>","from_hour":0},{"key":"<next>","from_hour":<unix hour>,"rotation_tx":"<signature>"}]
  ANCHORER_KEYS: text,
  // Memo mode. Root lines of this hour (unix seconds on an hour boundary) and later are v2 lines, which carry the
  // transaction of the previous root; earlier hours keep their v1 lines. Default 0: every root is a v2 line. A deployment
  // that already posted v1 lines sets this to the first hour posted after the upgrade, or its old roots stop verifying.
  ANCHOR_MEMO_V2_FROM_HOUR: z.coerce.number().int().nonnegative().refine((h) => h % 3600 === 0, "must be unix seconds on an hour boundary").default(0),
  // Memo mode. How long after its hour closed a root may still land and count as an anchor (anchor-memo.ts explains the
  // default of six hours). A root that lands later is "late": alarmed, and refused by verifiers.
  // At most 24 hours: the three verifiers refuse a published lateness bound above that (security review R5-22), so a
  // larger one here would publish a key document nobody accepts.
  ANCHOR_MAX_LATE_SECONDS: z.coerce.number().int().min(600).max(86_400).default(DEFAULT_MAX_LATE_SECONDS),
};

type LaunchEnv = {
  LAUNCH_TIER: LaunchTier;
  ANCHOR_MODE?: "memo" | "program";
  ANCHORER_ADDRESS?: string;
  ANCHORER_KEYS?: string;
  ANCHOR_MEMO_V2_FROM_HOUR?: number;
  ANCHOR_MAX_LATE_SECONDS?: number;
  ANCHORER_PRIVATE_KEY?: string;
  SOLANA_NETWORK: string;
  RUNTIME_ROLE: string;
  PAYMENTS_MODE?: string;
  CREDITS_ADDRESS?: string;
  CALLPAY_ADDRESS?: string;
  RECEIPT_ANCHOR_ADDRESS?: string;
  PROVIDER_BOND_ADDRESS?: string;
  TRELLIS_CREDITS_PROGRAM_ID?: string;
  TRELLIS_TAB_PROGRAM_ID?: string;
  TRELLIS_BOND_PROGRAM_ID?: string;
  TRELLIS_ANCHOR_PROGRAM_ID?: string;
};
type Programs = { credits?: string; tab?: string; bond?: string; anchor?: string; rules?: string; feeRouter?: string; capacity?: string; measurements?: string };

export type LaunchSettings = ReturnType<typeof launchSettings>;

/**
 * What /api/v1/status says under `launch_tier`: the tier, which features have their program (a feature without one is off
 * and says why), and where receipt roots go.
 */
export function launchStatus(launch: LaunchSettings) {
  const off = (program: string) => `off: ${program} is not deployed for this router`;
  const f = launch.features;
  return {
    tier: launch.tier,
    features: {
      per_call_x402: { enabled: true, needs: null },
      credits: { enabled: f.credits, needs: "trellis_credits", ...(f.credits ? {} : { reason: off("trellis_credits") }) },
      tabs: { enabled: f.tabs, needs: "trellis_tab", ...(f.tabs ? {} : { reason: off("trellis_tab") }) },
      rulebooks: { enabled: f.rulebooks, needs: "trellis_rules", ...(f.rulebooks ? {} : { reason: off("trellis_rules") }) },
      host_bonds: { enabled: f.host_bonds, needs: "trellis_bond", ...(f.host_bonds ? {} : { reason: off("trellis_bond") }) },
      capacity: { enabled: f.capacity, needs: "trellis_capacity", ...(f.capacity ? {} : { reason: off("trellis_capacity") }) },
      fee_router: { enabled: f.fee_router, needs: "trellis_fee_router", ...(f.fee_router ? {} : { reason: off("trellis_fee_router") }) },
      measurement_registry: { enabled: f.measurement_registry, needs: "trellis_measurements", ...(f.measurement_registry ? {} : { reason: off("trellis_measurements") }) },
    },
    receipt_anchor: {
      mode: launch.anchor.mode,
      program: launch.anchor.program,
      anchorer: launch.anchor.anchorer,
      // Said where the mode is said: a memo root has no program behind it.
      note: launch.anchor.mode === "memo" ? "Receipt roots are memo transactions signed by the anchorer key: no program enforces one root per hour, a root counts only when it is finalized and landed within the lateness bound, and verifying an old root needs an RPC that still serves its transaction." : "Receipt roots are accounts of trellis_anchor (one per hour); an account is closed after 400 days and its root is then verified from the transaction that posted it.",
    },
  };
}

/** The tier guard of a production router outside escrow mode: the programs LAUNCH_TIER requires are configured. */
export function assertLaunchTier(e: LaunchEnv): void {
  const tier = e.LAUNCH_TIER;
  for (const name of TIER_REQUIRED[tier]) if (!e[name]) throw new Error(`${name} is required in production${tier === "full" ? "" : ` (LAUNCH_TIER=${tier})`}.`);
  // A program the router would use must also be named under the legacy key the deployment guard reads, so it cannot
  // run outside the verified manifest (H-02).
  const pairs: [keyof LaunchEnv, keyof LaunchEnv][] = [["TRELLIS_CREDITS_PROGRAM_ID", "CREDITS_ADDRESS"], ["TRELLIS_TAB_PROGRAM_ID", "CALLPAY_ADDRESS"], ["TRELLIS_BOND_PROGRAM_ID", "PROVIDER_BOND_ADDRESS"], ["TRELLIS_ANCHOR_PROGRAM_ID", "RECEIPT_ANCHOR_ADDRESS"]];
  for (const [id, legacy] of pairs) if (e[id] && !e[legacy]) throw new Error(`${id} is set without ${legacy}: in production a program the router uses is also named under ${legacy}, which the deployment manifest is checked against.`);
}

/**
 * The anchor mode, the anchorer key and the feature map. `programs` is the resolved program-id map of solanaSettings;
 * `callPay` the tab program under its legacy name.
 */
export function launchSettings(e: LaunchEnv, production: boolean, programs: Programs, callPay: string | undefined) {
  const tier = e.LAUNCH_TIER;
  const escrowMode = e.PAYMENTS_MODE === "escrow";
  // ---- Anchor mode and the anchorer key -------------------------------------------------------------------------------
  const anchorProgram = programs.anchor;
  const mode: "memo" | "program" = e.ANCHOR_MODE ?? (anchorProgram ? "program" : "memo");
  if (mode === "program" && !anchorProgram) throw new Error("ANCHOR_MODE=program needs the anchor program id (TRELLIS_ANCHOR_PROGRAM_ID).");
  const fromSecret = e.ANCHORER_PRIVATE_KEY ? signerAddress(e.ANCHORER_PRIVATE_KEY) : null;
  if (e.ANCHORER_ADDRESS && fromSecret && e.ANCHORER_ADDRESS !== fromSecret) throw new Error("ANCHORER_ADDRESS is not the public key of ANCHORER_PRIVATE_KEY.");
  const anchorer = e.ANCHORER_ADDRESS ?? fromSecret ?? null;
  let anchorers: AnchorerKey[] = anchorer ? [{ key: anchorer, fromHour: 0, rotationTx: null }] : [];
  if (e.ANCHORER_KEYS) {
    let parsed: unknown;
    try { parsed = JSON.parse(e.ANCHORER_KEYS); } catch { throw new Error("ANCHORER_KEYS must be a JSON array of {key, from_hour, rotation_tx}."); }
    const list = z.array(z.object({ key: z.string().regex(ADDRESS_RE), from_hour: z.number().int().nonnegative(), rotation_tx: z.string().regex(SIGNATURE_RE).nullish() })).min(1).max(64).safeParse(parsed);
    if (!list.success) throw new Error("ANCHORER_KEYS must be a JSON array of {key, from_hour, rotation_tx}: base58 keys, hours in unix seconds, base58 transaction signatures.");
    anchorers = list.data.map((k) => ({ key: k.key, fromHour: k.from_hour, rotationTx: k.rotation_tx ?? null }));
    const problem = anchorerKeysProblem(anchorers);
    if (problem) throw new Error(`ANCHORER_KEYS: ${problem}.`);
    if (anchorer && anchorers[anchorers.length - 1]!.key !== anchorer) throw new Error("ANCHORER_KEYS must end with the current anchorer key (ANCHORER_ADDRESS, or the public key of ANCHORER_PRIVATE_KEY).");
  }
  const current = anchorers.length ? anchorers[anchorers.length - 1]!.key : null;
  if (mode === "memo" && (current || production)) {
    // The cluster name goes into every line; refuse a name that cannot be written there before anything is signed.
    try { networkRef(e.SOLANA_NETWORK); } catch (err) { if (current) throw new Error(`ANCHOR_MODE=memo: ${(err as Error).message}`); }
  }
  // In memo mode the key IS the anchor: a public API that cannot say which key signs the roots serves proofs nobody
  // can check. (In program mode the SignerSet account names the authority.)
  if (production && !escrowMode && mode === "memo" && e.RUNTIME_ROLE === "api" && !current) throw new Error(`ANCHORER_ADDRESS is required in production with ANCHOR_MODE=memo (LAUNCH_TIER=${tier}): the public key of the anchor worker's ANCHORER_PRIVATE_KEY, published at /.well-known/trellis-receipt-keys.json.`);

  const features = {
    /** Pay-per-call x402 needs no Trellis program. */
    per_call_x402: true,
    credits: !!programs.credits,
    tabs: !!(programs.tab ?? callPay),
    rulebooks: !!programs.rules,
    host_bonds: !!programs.bond,
    capacity: !!programs.capacity,
    fee_router: !!programs.feeRouter,
    measurement_registry: !!programs.measurements,
  };
  return {
    tier,
    features,
    anchor: {
      mode,
      /** True when ANCHOR_MODE was set; false when the mode follows from whether an anchor program is configured. */
      explicit: !!e.ANCHOR_MODE,
      program: mode === "program" ? anchorProgram! : null,
      /** The current anchorer public key, or null when this process knows none (roots then stay "local"). */
      anchorer: current,
      anchorers,
      /** Memo mode: root lines of this hour and later are v2 (linked) lines. */
      memoV2FromHour: e.ANCHOR_MEMO_V2_FROM_HOUR ?? 0,
      /** Memo mode: how long after its hour closed a root may land and still count. */
      maxLateSeconds: e.ANCHOR_MAX_LATE_SECONDS ?? DEFAULT_MAX_LATE_SECONDS,
    },
  };
}
