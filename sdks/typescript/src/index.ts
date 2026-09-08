// @trellis/sdk: the official TypeScript SDK. A typed façade over @trellis/client, which keeps every piece of
// cryptography (receipt v1 and v2 checks, the chunk chain, attestation, blind tokens, the transparency log).

export { Trellis, DEFAULT_BASE_URL, parseJsonl } from "./client.js";
export type { TrellisOptions, CallOptions, ChatOptions, ChatResponse, CreditClosure, CreditClosureCancel, CreditClosureRecord, CreditClosureRelease, DepositTransaction, PerCallPayer, ReceiptCheck, ReceiptProof, RefundDestinationTransaction, Signer, WithMeta } from "./client.js";
export { TrellisAPIError, AuthenticationError, BadRequestError, BatchTimeoutError, CreditsClosingError, NotFoundError, RateLimitError, parseRetryAfter } from "./errors.js";
export { DISCLOSURES, LANES, isDisclosure, isLane, routingHeaders, stricterLane, supportsLane, withRouting } from "./lanes.js";
export type { DisclosureMax, Lane, RoutingOptions } from "./lanes.js";
export { TERMINAL_BATCH_STATUSES } from "./types.js";
export type {
  Batch,
  BatchEndpoint,
  BatchList,
  BatchRequestLine,
  BatchResultLine,
  BatchStatus,
  CreateBatchParams,
  EmbeddingsRequest,
  EmbeddingsResponse,
  Model,
  Preset,
  PresetDoc,
  PresetVersion,
  ProviderPrefs,
  Receipt,
  RerankRequest,
  RerankResponse,
  RerankResult,
  ResponseMeta,
} from "./types.js";

// Receipt and chain primitives, re-exported so one import covers offline verification.
export {
  TrellisError,
  AttestationRefused,
  ChatStream,
  ReceiptInvalid,
  checkChain,
  chunkChain,
  decodeReceiptV2,
  fetchReceiptKeys,
  receiptLeaf,
  receiptLeafV2,
  verifyMerkleProof,
  verifyReceipt,
  verifyReceiptV2,
} from "@trellis/client";
export type { TrellisMeta, ChatBody, ChatResult, Check, KeySet, ReceiptEnvelope, ReceiptV2Verification, ReceiptVerification } from "@trellis/client";

// Credits closure: who is paid back, why a closure is waiting, and whether it is on hold (the shapes credits.close(), closures() and friends return).
export { isClosureHeld } from "@trellis/client";
export type { ClosureHeld, ClosureRefund, ClosureRefundPayment, CreditClosureReason, CreditClosureStatus } from "@trellis/client";

// Holder tiers: membership levels that give access and priority (the shapes holders.tiers(), me(), polls() and vote() return).
export { holderVoteBody, holderVoteHeader, holderVotePath } from "@trellis/client";
export type { EarlyAccessRefusal, HolderLimits, HolderPerks, HolderPoll, HolderPollKind, HolderStatus, HolderTier, HolderTiers, HolderVote, ModelEarlyAccess } from "@trellis/client";

// Solana payments: x402 per-call payments, tabs and vouchers, transaction signing, wallet sign-in, X-Wallet-Auth (from @trellis/client).
export {
  ASSOCIATED_TOKEN_PROGRAM, COMPUTE_BUDGET_PROGRAM, CREDITS_CLOSING, EMPTY_BODY_HASH, EXACT_LIMITS, MAX_TAB_LIFETIME_SECONDS, NOTHING_TO_CANCEL, OPEN_TAB_DISCRIMINATOR, PAYMENT_NOT_BOUND, RECLAIM_DISCRIMINATOR, REFUND_DESTINATION_FIXED, REFUND_IN_PROGRESS, SOLANA_DEVNET, SOLANA_MAINNET, SYSTEM_PROGRAM, TAB_ACCOUNT_DISCRIMINATOR, TOKEN_2022_PROGRAM, TOKEN_PROGRAM, TOP_UP_DISCRIMINATOR, USDC_DECIMALS, USDC_MINT, VOUCHER_DOMAIN, VOUCHER_MESSAGE_LENGTH, WALLET_AUTH_VERSION, WALLET_SIGN_IN_VERSION,
  TabSession, accountData, address, associatedTokenAddress, base58Decode, base58Encode, buildExactPayment, canonicalBodyHash, chatRequestHash, checkWalletChallenge, compileLegacyMessage, computeBudgetInstructions, createProgramAddress, decodeTabAccount, exactPaymentInstructions, fetchTabAccount, findProgramAddress, generateSessionKey, hostResourceHash, isCreditsClosing, isOnCurve, keypairSigner, landedPaymentHeaders, latestBlockhash, openTabInstruction, openTabTransaction, parsePaymentRequired, parsePaymentResponse, parseTransaction, parseVoucherHeader, parseVoucherMessage, parseWalletSignInMessage, payPerCall, priorityFeeLamports, publicKeyBytes, randomTabId, reclaimInstruction, rulesConfigAddress, sendTransaction, serializeTransaction, signCreditClosure, signCreditClosureCancel, signRefundDestination, signTransaction, signVoucher, signerFromSeed, tabAddress, tabEnforcerAddress, tabPdas, topUpInstruction, verifyVoucher, voucherHeaders, voucherMessage, walletAuthHeader, walletAuthMessage, walletSignIn, walletSignInBody, x402PaymentHeader,
} from "@trellis/client";
export type { AccountMeta, BuildExactOptions, Commitment, CompiledMessage, ConnectionLike, ExactPayment, Instruction, KeypairSigner, OpenTabOptions, OpenTabTransaction, ParsedTransaction, PaymentRequired, PaymentResponse, PerCallOptions, PublicKeyLike, RpcOptions, SignedVoucher, TabAccount, TabPdas, TabRulebook, Voucher, VoucherHeaders, VoucherScope, WalletAuthOptions, WalletAuthRequest, WalletChallenge, WalletSignInFields, WireVoucher, X402Requirement, ExactLimits } from "@trellis/client";
