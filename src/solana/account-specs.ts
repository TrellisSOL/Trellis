import { PublicKey } from "@solana/web3.js";
import { anchorPdas, decodeHostRoot, decodePendingSigner, decodeReceiptRoot, decodeSignerSet, hostRootPda, receiptRootPda, type HostRoot, type PendingSigner, type ReceiptRoot, type SignerSet } from "./programs/anchor.ts";
import { bondPdas, decodeBondConfig, decodeHostBond, decodePendingReinstate, decodeSlashLedger, decodeSlashProposal, pendingReinstatePda, proposalPda, slashLedgerPda, type BondConfig, type HostBond, type PendingReinstate, type SlashLedger, type SlashProposal } from "./programs/bond.ts";
import { capacityConfigPda, commitmentPda, decodeCapacityCommitment, decodeCapacityConfig, type CapacityCommitment, type CapacityConfig } from "./programs/capacity.ts";
import { creditsPdas, decodeCreditAccount, decodeCreditsConfig, decodeDepositorShare, decodeRefundRequest, decodeSettleLimiter, decodeSpentRoot, sharePda, spentRootPda, type CreditAccount, type CreditsConfig, type DepositorShare, type RefundRequest, type SettleLimiter, type SpentRoot } from "./programs/credits.ts";
import { decodeFeeConfig, feeRouterPdas, type FeeConfig } from "./programs/fee-router.ts";
import { decodeMeasurement, decodePendingMeasurement, decodeRegistry, measurementPda, pendingMeasurementPda, registryPda, type Measurement, type PendingMeasurement, type Registry } from "./programs/measurements.ts";
import { decodeRulebook, decodeRulesConfig, rulebookPda, rulesConfigPda, type Rulebook, type RulesConfig } from "./programs/rules.ts";
import { decodeTabAccount, decodeTabConfig, tabConfigPda, tabPdas, type TabAccount, type TabConfig } from "./programs/tab.ts";
import type { AccountSpec } from "./verified-account.ts";

// What makes each program account the account it claims to be (security review TR-02): the program that must own it
// and the PDA its own fields must derive. One entry per account type the router reads; every reader passes the entry to
// readVerifiedAccount / verifyAccountInfo (src/solana/verified-account.ts) with the program id the router is configured
// with. Seeds are the programs' own (src/solana/programs/*.ts); nothing here decides an address from request input.

type Spec<T> = (programId: PublicKey) => AccountSpec<T>;

// trellis_credits: ["config"], ["credit", key_hash], ["refund", key_hash], ["share", key_hash, depositor], ["limiter_v2"], ["spent_root", hour LE]
export const creditsConfigSpec: Spec<CreditsConfig> = (id) => ({ name: "CreditsConfig", owner: id, decode: decodeCreditsConfig, derive: creditsPdas(id).config });
export const creditAccountSpec: Spec<CreditAccount> = (id) => ({ name: "CreditAccount", owner: id, decode: decodeCreditAccount, derive: (a) => creditsPdas(id, a.keyHash).credit! });
export const refundRequestSpec: Spec<RefundRequest> = (id) => ({ name: "RefundRequest", owner: id, decode: decodeRefundRequest, derive: (a) => creditsPdas(id, a.keyHash).refundRequest! });
export const depositorShareSpec: Spec<DepositorShare> = (id) => ({ name: "DepositorShare", owner: id, decode: decodeDepositorShare, derive: (a) => sharePda(id, a.keyHash, a.depositor) });
export const settleLimiterSpec: Spec<SettleLimiter> = (id) => ({ name: "SettleLimiter", owner: id, decode: decodeSettleLimiter, derive: creditsPdas(id).limiter });
export const spentRootSpec: Spec<SpentRoot> = (id) => ({ name: "SpentRoot", owner: id, decode: decodeSpentRoot, derive: (a) => spentRootPda(id, a.hour) });

// trellis_tab: ["config"], ["tab", payer, payee, tab_id LE]
export const tabConfigSpec: Spec<TabConfig> = (id) => ({ name: "TabConfig", owner: id, decode: decodeTabConfig, derive: tabConfigPda(id) });
export const tabSpec: Spec<TabAccount> = (id) => ({ name: "Tab", owner: id, decode: decodeTabAccount, derive: (t) => tabPdas(id, t.payer, t.payee, t.tabId).tab });

// trellis_rules: ["config"], ["rulebook", owner, rulebook_id LE]
export const rulesConfigSpec: Spec<RulesConfig> = (id) => ({ name: "RulesConfig", owner: id, decode: decodeRulesConfig, derive: rulesConfigPda(id) });
export const rulebookSpec: Spec<Rulebook> = (id) => ({ name: "Rulebook", owner: id, decode: decodeRulebook, derive: (r) => rulebookPda(id, r.owner, r.rulebookId) });

// trellis_bond: ["config"], ["bond", host], ["proposal", bond, proposal_id LE]
export const bondConfigSpec: Spec<BondConfig> = (id) => ({ name: "BondConfig", owner: id, decode: decodeBondConfig, derive: bondPdas(id).config });
export const hostBondSpec: Spec<HostBond> = (id) => ({ name: "HostBond", owner: id, decode: decodeHostBond, derive: (b) => bondPdas(id, b.host).bond! });
export const slashProposalSpec: Spec<SlashProposal> = (id) => ({ name: "SlashProposal", owner: id, decode: decodeSlashProposal, derive: (p) => proposalPda(id, p.bond, p.proposalId) });
// ["slash_ledger", bond], ["pending_reinstate", bond]
export const slashLedgerSpec: Spec<SlashLedger> = (id) => ({ name: "SlashLedger", owner: id, decode: decodeSlashLedger, derive: (l) => slashLedgerPda(id, l.bond) });
export const pendingReinstateSpec: Spec<PendingReinstate> = (id) => ({ name: "PendingReinstate", owner: id, decode: decodePendingReinstate, derive: (p) => pendingReinstatePda(id, p.bond) });

// trellis_capacity: ["config"], ["commitment", host, commitment_id LE] (lots and the HVX feed: src/capacity/chain.ts, src/solana/hvx-publish.ts)
export const capacityConfigSpec: Spec<CapacityConfig> = (id) => ({ name: "CapacityConfig", owner: id, decode: decodeCapacityConfig, derive: capacityConfigPda(id) });
export const capacityCommitmentSpec: Spec<CapacityCommitment> = (id) => ({ name: "CapacityCommitment", owner: id, decode: decodeCapacityCommitment, derive: (c) => commitmentPda(id, c.host, c.commitmentId) });

// trellis_anchor: ["signer_set"], ["root", hour LE], ["host_root", provider_id_hash, hour LE]
export const signerSetSpec: Spec<SignerSet> = (id) => ({ name: "SignerSet", owner: id, decode: decodeSignerSet, derive: anchorPdas(id).signerSet });
export const pendingSignerSpec: Spec<PendingSigner> = (id) => ({ name: "PendingSigner", owner: id, decode: decodePendingSigner, derive: anchorPdas(id).pendingSigner });
export const receiptRootSpec: Spec<ReceiptRoot> = (id) => ({ name: "ReceiptRoot", owner: id, decode: decodeReceiptRoot, derive: (r) => receiptRootPda(id, r.hour) });
export const hostRootSpec: Spec<HostRoot> = (id) => ({ name: "HostRoot", owner: id, decode: decodeHostRoot, derive: (r) => hostRootPda(id, r.providerIdHash, r.hour) });

// trellis_fee_router: ["fee_config"]
export const feeConfigSpec: Spec<FeeConfig> = (id) => ({ name: "FeeConfig", owner: id, decode: decodeFeeConfig, derive: feeRouterPdas(id).feeConfig });

// trellis_measurements: ["registry"], ["measurement", kind, digest]
export const registrySpec: Spec<Registry> = (id) => ({ name: "Registry", owner: id, decode: decodeRegistry, derive: registryPda(id) });
export const measurementSpec: Spec<Measurement> = (id) => ({ name: "Measurement", owner: id, decode: decodeMeasurement, derive: (m) => measurementPda(id, m.kindCode, m.digest) });
// ["pending_measurement", [kind], digest]: a registration or reinstatement waiting out the 24 h timelock
export const pendingMeasurementSpec: Spec<PendingMeasurement> = (id) => ({ name: "PendingMeasurement", owner: id, decode: decodePendingMeasurement, derive: (m) => pendingMeasurementPda(id, m.kindCode, m.digest) });
