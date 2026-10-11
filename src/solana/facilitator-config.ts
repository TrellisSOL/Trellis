import { z } from "zod";
import { ADDRESS_RE } from "./constants.ts";
import { signerAddress } from "./keys.ts";

// The hosted x402 facilitator: settings. Off by default. When on, it verifies and settles USDC `exact` payments for any
// seller on Solana, straight from payer to the seller's payTo; its own relay key only pays transaction fees as fee payer,
// so it must hold no other role. Schemes: `exact` (SPL TransferChecked, co-signed as fee payer) and `tab` (trellis_tab
// close with the payer's voucher, docs/Trellis_Backend.md §5.2).

const flag = z.union([z.boolean(), z.string()]).transform((v) => (typeof v === "boolean" ? v : ["1", "true", "yes", "on"].includes(v.toLowerCase())));
const address = z.string().regex(ADDRESS_RE, "must be a base58 address").optional().or(z.literal("").transform(() => undefined));
const key = z.string().min(32, "must be a base58 secret key").optional().or(z.literal("").transform(() => undefined));
const usdc = (d: string) => z.string().regex(/^\d{1,12}(\.\d{1,6})?$/, "must be a USDC amount with at most 6 decimals").default(d);

export const facilitatorEnv = {
  FACILITATOR_ENABLED: flag.default(false),
  // Zero markup, by construction: the hosted facilitator takes no fee and there is no code path that charges one. The
  // setting is kept only so that an environment that still names it starts; any value but 0 is refused.
  FACILITATOR_FEE_BPS: z.coerce.number().int().refine((v) => v === 0, "The hosted facilitator charges no fee (zero markup): FACILITATOR_FEE_BPS must be 0 or unset.").default(0),
  // Smallest payment it settles (USDC), unless the seller prepaid a fee float.
  FACILITATOR_MIN_SETTLE: usdc("0.01"),
  FACILITATOR_RELAY_PRIVATE_KEY: key,
  FACILITATOR_TREASURY: address,
  // SOL balance (lamports) below which the fee payer refuses (facilitator_unavailable) instead of queueing. Default 0.01 SOL.
  FACILITATOR_RELAY_FLOOR_LAMPORTS: z.coerce.bigint().nonnegative().default(10_000_000n),
  FACILITATOR_RPM: z.coerce.number().int().min(1).default(120), // per caller address, per minute
  FACILITATOR_PAYER_PER_MIN: z.coerce.number().int().min(1).default(20),
  FACILITATOR_SELLER_PER_MIN: z.coerce.number().int().min(1).default(600),
  // What the relay may spend on fees in one minute, whoever asks (lamports, worst case per settlement). The per-payer
  // and per-seller limits are keyed by addresses the caller picks; this one is not (security re-review RR-11).
  // Default 2,000,000 lamports: 100 settlements a minute at the 20,000-lamport ceiling, under 3 SOL a day.
  FACILITATOR_RELAY_LAMPORTS_PER_MIN: z.coerce.number().int().min(80_000).default(2_000_000),
  FACILITATOR_LISTINGS_PER_HOUR: z.coerce.number().int().min(1).default(20), // per payTo
  // Fee floats: USDC per SOL used to price the fee of a settle, and the buffer on top. Unset: no fee floats.
  FACILITATOR_SOL_USDC: z.string().regex(/^\d{1,9}(\.\d{1,6})?$/).optional().or(z.literal("").transform(() => undefined)),
  FACILITATOR_FEE_BUFFER_BPS: z.coerce.number().int().min(10_000).max(50_000).default(15_000),
  FACILITATOR_SETTLE_LAMPORTS: z.coerce.number().int().min(5_000).max(10_000_000).default(10_000), // estimate for the float pre-check
  // What a fee payer (the router key on the per-call path, the relay in facilitator mode) agrees to pay for an `exact`
  // payment besides the base fee: the payer's compute budget is decoded and capped, and so is the fee it implies.
  X402_MAX_COMPUTE_UNIT_LIMIT: z.coerce.number().int().min(1).max(1_400_000).default(200_000), // compute units
  X402_MAX_COMPUTE_UNIT_PRICE: z.coerce.bigint().nonnegative().default(5_000_000n), // micro-lamports per unit (5 lamports)
  X402_MAX_PRIORITY_FEE_LAMPORTS: z.coerce.bigint().nonnegative().default(10_000n), // ceil(limit x price / 1e6)
  // payTo's token account may be created inside the payment only with the payer's own lamports; off refuses any creation.
  X402_ALLOW_ATA_CREATION: flag.default(true),
  // ---- Sponsored fees (security review round 3, R3-01): what bounds the SOL a fee payer spends for strangers ----------
  // The router key (per-call x402) and the relay (hosted facilitator) pay the network fee of payments other people
  // sign. On the per-call path the payer bears that fee, as pass-through cost recovery and nothing more (zero markup):
  // the 402 quotes the most the fee can be (two signatures and the priority-fee ceiling above), and what is kept back
  // from the credit is the fee of the transaction as signed, in lamports, converted at X402_SOL_USDC. There is no
  // buffer and no margin. Set X402_SOL_USDC to what the operator pays for the SOL it funds the fee payer with; the
  // status route reports lamports paid and USDC recovered so the two can be compared (src/solana/sponsor.ts).
  X402_SOL_USDC: z.string().regex(/^\d{1,9}(\.\d{1,6})?$/).default("250"),
  // No per-call quote is below this (USDC). All of it is credited except the network fee; what a call does not use
  // stays on the payer's wallet account as change. Start-up fails unless it is at least three times the worst-case
  // fee at X402_SOL_USDC. Default 0.03 USDC: six times 20,000 lamports at 250 USDC per SOL.
  X402_MIN_PAYMENT: usdc("0.03"),
  // The fee payer signs nothing while its balance is below this (or cannot be read). Default 0.05 SOL.
  X402_FEE_PAYER_FLOOR_LAMPORTS: z.coerce.bigint().nonnegative().default(50_000_000n),
  // What the router key may spend on sponsored fees, whoever asks: continuously refilled budgets (over ANY minute and
  // ANY 24 hours at most this much, a quarter of it at once), counted at what each payment can cost and given back
  // when nothing was sent. Defaults: 2,000,000 lamports a minute (100 payments), 0.5 SOL a day (25,000 payments).
  X402_SPONSOR_LAMPORTS_PER_MIN: z.coerce.number().int().min(80_000).default(2_000_000),
  X402_SPONSOR_LAMPORTS_PER_DAY: z.coerce.number().int().min(80_000).default(500_000_000),
  // One payer address: payments a minute, and lamports of sponsored fees over any 24 hours (default 100 payments).
  X402_PAYER_PER_MIN: z.coerce.number().int().min(1).default(20),
  X402_PAYER_LAMPORTS_PER_DAY: z.coerce.number().int().min(80_000).default(2_000_000),
  // One source address (as the per-address request limit sees it): sponsored payments a minute.
  X402_SOURCE_PER_MIN: z.coerce.number().int().min(1).default(60),
  // A payer whose sponsored payment failed AFTER it was sent (the fee was paid for nothing) is not sponsored again for
  // this many days. It can still pay its own fee and present the signature.
  X402_FAILED_PAYER_BLOCK_DAYS: z.coerce.number().int().min(1).max(3650).default(30),
  // The relay's own daily budget (the per-minute one is FACILITATOR_RELAY_LAMPORTS_PER_MIN). Default 1 SOL.
  FACILITATOR_RELAY_LAMPORTS_PER_DAY: z.coerce.number().int().min(80_000).default(1_000_000_000),
};

type Env = z.infer<z.ZodObject<typeof facilitatorEnv>> & {
  SANCTIONS_SCREENING_ENABLED: boolean;
  ROUTER_PRIVATE_KEY?: string;
  SETTLEMENT_PRIVATE_KEY?: string;
  ANCHORER_PRIVATE_KEY?: string;
  SLASHER_PRIVATE_KEY?: string;
  KEEPER_PRIVATE_KEY?: string;
  IPX_KEEPER_PRIVATE_KEY?: string;
  IPX_ORACLE_PRIVATE_KEY?: string;
  PAYMASTER_SIGNER_KEY?: string;
  DEV_FAUCET_PRIVATE_KEY?: string;
};

/** The base fee of one transaction signature. */
export const LAMPORTS_PER_SIGNATURE = 5_000;
const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;
/** `lamports` of network fee in USDC base units at `solUsdc` (USDC base units per SOL), rounded up to the unit. */
export const feeUnits = (lamports: number | bigint, solUsdc: bigint) => ceilDiv(BigInt(lamports) * solUsdc, 1_000_000_000n);

/** A decimal USDC string as base units (6 decimals). */
export function usdcUnits(s: string): bigint {
  const [whole, frac = ""] = s.split(".");
  return BigInt(whole) * 1_000_000n + BigInt(frac.padEnd(6, "0"));
}

export function facilitatorSettings(e: Env, production: boolean) {
  const relayKey = e.FACILITATOR_RELAY_PRIVATE_KEY;
  if (e.FACILITATOR_ENABLED && !relayKey) throw new Error("FACILITATOR_ENABLED needs FACILITATOR_RELAY_PRIVATE_KEY, a key that only pays transaction fees.");
  if (relayKey && !signerAddress(relayKey)) throw new Error("FACILITATOR_RELAY_PRIVATE_KEY must be a base58 64-byte ed25519 secret key.");
  if (relayKey) {
    const others = [e.ROUTER_PRIVATE_KEY, e.SETTLEMENT_PRIVATE_KEY, e.ANCHORER_PRIVATE_KEY, e.SLASHER_PRIVATE_KEY, e.KEEPER_PRIVATE_KEY, e.IPX_KEEPER_PRIVATE_KEY, e.IPX_ORACLE_PRIVATE_KEY, e.PAYMASTER_SIGNER_KEY, e.DEV_FAUCET_PRIVATE_KEY];
    if (others.some((k) => k && k === relayKey)) throw new Error("FACILITATOR_RELAY_PRIVATE_KEY must be its own key, with no other signing role.");
  }
  if (e.FACILITATOR_SOL_USDC && !e.FACILITATOR_TREASURY) throw new Error("Fee floats (FACILITATOR_SOL_USDC) need FACILITATOR_TREASURY to receive them.");
  // Listings are screened against the sanctions list; a production facilitator must have that list.
  if (production && e.FACILITATOR_ENABLED && !e.SANCTIONS_SCREENING_ENABLED) throw new Error("FACILITATOR_ENABLED in production needs SANCTIONS_SCREENING_ENABLED (listings are screened).");
  const minSettle = usdcUnits(e.FACILITATOR_MIN_SETTLE);
  if (minSettle <= 0n) throw new Error("FACILITATOR_MIN_SETTLE must be above 0.");
  const solUsdc = e.FACILITATOR_SOL_USDC ? usdcUnits(e.FACILITATOR_SOL_USDC) : null;
  if (solUsdc !== null && solUsdc <= 0n) throw new Error("FACILITATOR_SOL_USDC must be above 0.");
  // R3-01: one sponsored payment must cost its sender more than it can cost the fee payer.
  const worstCaseLamports = 2 * LAMPORTS_PER_SIGNATURE + Number(e.X402_MAX_PRIORITY_FEE_LAMPORTS);
  const x402SolUsdc = usdcUnits(e.X402_SOL_USDC);
  if (x402SolUsdc <= 0n) throw new Error("X402_SOL_USDC must be above 0.");
  const worstCaseFeeUnits = ceilDiv(BigInt(worstCaseLamports) * x402SolUsdc, 1_000_000_000n);
  const minPaymentUnits = usdcUnits(e.X402_MIN_PAYMENT);
  if (minPaymentUnits < 3n * worstCaseFeeUnits)
    throw new Error(`X402_MIN_PAYMENT (${e.X402_MIN_PAYMENT} USDC) must be at least three times the worst-case sponsored fee: ${worstCaseLamports} lamports at X402_SOL_USDC=${e.X402_SOL_USDC} is ${worstCaseFeeUnits} USDC base units. Raise X402_MIN_PAYMENT or lower X402_MAX_PRIORITY_FEE_LAMPORTS.`);
  return {
    /**
     * Sponsored-fee bounds (R3-01). `maxFeeUnits` is the most the network fee of one per-call payment can be, in USDC
     * base units at `solUsdc`: it is what the quote adds. What is kept back from a payment is the fee of that payment
     * (`feeUnits` of its lamports), never more. `minPaymentUnits` is the smallest quote; the budgets are lamports.
     */
    sponsor: {
      worstCaseLamports, solUsdc: x402SolUsdc, maxFeeUnits: worstCaseFeeUnits, minPaymentUnits,
      floorLamports: e.X402_FEE_PAYER_FLOOR_LAMPORTS,
      perMinLamports: e.X402_SPONSOR_LAMPORTS_PER_MIN, perDayLamports: e.X402_SPONSOR_LAMPORTS_PER_DAY,
      payerPerMin: e.X402_PAYER_PER_MIN, payerLamportsPerDay: e.X402_PAYER_LAMPORTS_PER_DAY, sourcePerMin: e.X402_SOURCE_PER_MIN,
      failedPayerBlockDays: e.X402_FAILED_PAYER_BLOCK_DAYS,
    },
    relayLamportsPerDay: e.FACILITATOR_RELAY_LAMPORTS_PER_DAY,
    enabled: e.FACILITATOR_ENABLED,
    relayKey,
    relayAddress: (relayKey ? signerAddress(relayKey) ?? undefined : undefined) as string | undefined,
    feeBps: e.FACILITATOR_FEE_BPS,
    treasury: e.FACILITATOR_TREASURY,
    minSettle,
    relayFloorLamports: e.FACILITATOR_RELAY_FLOOR_LAMPORTS,
    rpm: e.FACILITATOR_RPM,
    payerPerMin: e.FACILITATOR_PAYER_PER_MIN,
    sellerPerMin: e.FACILITATOR_SELLER_PER_MIN,
    relayLamportsPerMin: e.FACILITATOR_RELAY_LAMPORTS_PER_MIN,
    listingsPerHour: e.FACILITATOR_LISTINGS_PER_HOUR,
    feeFloat: solUsdc === null ? null : { solUsdc, bufferBps: e.FACILITATOR_FEE_BUFFER_BPS, settleLamports: BigInt(e.FACILITATOR_SETTLE_LAMPORTS) },
    /** Fee and instruction bounds of the `exact` verifier (src/solana/x402.ts ExactLimits). */
    exact: { maxComputeUnitLimit: e.X402_MAX_COMPUTE_UNIT_LIMIT, maxComputeUnitPriceMicroLamports: e.X402_MAX_COMPUTE_UNIT_PRICE, maxPriorityFeeLamports: e.X402_MAX_PRIORITY_FEE_LAMPORTS, allowAtaCreation: e.X402_ALLOW_ATA_CREATION },
  };
}
