export { Trellis, ChatStream, isClosureHeld } from "./client.js";
export type { TrellisMeta, AttestedOptions, ChatBody, ChatCompletion, ChatResult, ClientOptions, ClosureHeld, ClosureRefund, ClosureRefundPayment, CreditClosure, CreditClosureCancel, CreditClosureReason, CreditClosureRecord, CreditClosureRelease, CreditClosureStatus, DepositTransaction, RefundDestinationTransaction, RequestOptions } from "./client.js";
export { TrellisError, AttestationRefused, ReceiptInvalid, CREDITS_CLOSING, NOTHING_TO_CANCEL, PAYMENT_NOT_BOUND, REFUND_DESTINATION_FIXED, REFUND_IN_PROGRESS, isCreditsClosing } from "./errors.js";
export { canonical, canonicalJson } from "./canonical.js";
export { defaultEd25519Verify, UnsupportedCrypto } from "./ed25519.js";
export type { Ed25519Verifier } from "./ed25519.js";
export { TOKEN_FILE_PATH, TOKEN_FILE_VERSION, TokenFileError, buildTokenFile, mergeTokenFiles, parseTokenFile, serializeTokenFile, storedToken, tokenKeyIdOf, withoutTokens } from "./blind-file.js";
export type { StoredToken, TokenFile, TokenKeyInfo, UnconfirmedToken } from "./blind-file.js";
export { sha256, sha256Hex, sha256Sync, sha256SyncHex, sha256dHex } from "./hash.js";
export { bytesToHex, hexToBytes, base64ToBytes, bytesToBase64, bytesToBase64Url, concatBytes, equalBytes, fromUtf8, utf8 } from "./bytes.js";
export { RECEIPT_KEYS_PATH, canonicalBytes, fetchReceiptKeys, keyIdOf, parseKeySet, receiptLeaf, verifyMerkleProof, verifyReceipt } from "./receipts.js";
export type { ReceiptVerification, VerifyReceiptOptions } from "./receipts.js";
export { DEFAULT_MAX_LATE_SECONDS, KNOWN_GENESIS, MEMO_PROGRAM, anchorTrustFromDocument, anchorerKeysProblem, fetchAnchorKeys, hostRootMemoLine, jsonRpc, networkNamesGenesis, parseRootLine, rootMemoLine, verifyMemoLine, verifyPostedRoot, verifyProgramPost } from "./receipts.js";
export type { AnchorKeyDocument, AnchorTrust, AnchorerKey, PostedAnchorProof, PostedRootVerification, RootLine, SolanaRpc, VerifyPostedRootOptions } from "./receipts.js";
export { COSE_ALG_EDDSA, checkChain, chunkChain, decodeReceiptV2, receiptLeafV2, sigStructure, verifyReceiptV2 } from "./receipts-v2.js";
export type { ChainedEvent, DecodedReceiptV2, ReceiptClaimsV2, ReceiptV2Verification, VerifyReceiptV2Options } from "./receipts-v2.js";
export { verifySidecarReceipt } from "./sidecar.js";
export { HOST_ANCHOR_PROOF_PATH, HOST_ROOT_DISCRIMINATOR, decodeHostRoot, fetchHostAnchorProof, hostRootAddress, providerIdHash, readAttestedAnchor, verifyHostAnchor } from "./host-anchor.js";
export type { AttestedAnchor, AttestedAnchorReader, AttestedAnchorRef, HostAnchorProof, HostAnchorVerification, VerifyHostAnchorOptions } from "./host-anchor.js";
export { ATTEST_SAN_SUFFIX, attestSanFor, defaultAttestFetcher, digestHex, evaluateAttestation, fetchRouterAttestation, verifyProvider } from "./attestation.js";
export type { AttestDocument, AttestFetcher, Bindings, BoundIdentity, EvaluateInput, EvaluateOptions, ExpectedDigests, GpuCheckOptions, ProviderVerification, QuoteVerifier, RouterAttestation, VerifyProviderOptions } from "./attestation.js";
export { GPU_EVIDENCE_LIMITS, NRAS_DEFAULT_URL, fetchNrasJwks, verifyGpuEvidence, verifyNrasTokens } from "./gpu.js";
export type { GpuDevice, GpuDocument, GpuEvidenceRecord, GpuFailure, GpuPolicy, GpuVerification, VerifyGpuOptions } from "./gpu.js";
export { validSidecarBindingVersion, sidecarBindingsV2 } from "./sidecar-bindings.js";
export type { SidecarBindingsV2 } from "./sidecar-bindings.js";
export { parseTdxQuote } from "./tdx.js";
export type { TdxFields } from "./tdx.js";
export { parseCertificate, pemToDer } from "./x509.js";
export type { CertificateInfo } from "./x509.js";
export { HPKE_MEDIA_TYPE, sealedPost } from "./hpke.js";
export type { HpkeExchange, HpkeHook, SealedPostOptions } from "./hpke.js";
export { routingHeaders, withRouting } from "./options.js";
export { DECISION_TAG_HEADER, checkDecisionTag, decisionTag, receiptDecisionTag, withDecisionTag } from "./decision-tag.js";
export { TLOG_KINDS, TransparencyError, TransparencyLog, SplitViewDetected, bindingsDigest, blindIssuerKeyDigest, ohttpKeyConfigDigest, receiptKeyDigest, verifyConsistency as verifyTlogConsistency, verifyInclusion as verifyTlogInclusion, verifyRekorInclusion } from "./tlog.js";
export type { CheckpointStore, LoggedKey, RekorAnchor, RekorAnchorOptions, TlogKind, TransparencyOptions } from "./tlog.js";
export { defaultP256Verify, type P256Verifier } from "./ecdsa.js";
export type { DisclosureMax, Lane, RoutingOptions } from "./options.js";
export type { AnchorProof, Check, CheckStatus, Fetch, JwkKey, KeySet, ReceiptEnvelope } from "./types.js";
export { fetchPrivacyLabel, privacyLabel, privacyPath, shortLine as privacyShortLine } from "./privacy.js";
export type { LabelOptions as PrivacyLabelOptions, PrivacyLabel } from "./privacy.js";

export { e2eeChat, E2EE_SUITE } from "./e2ee.js";
export type { E2eeCompletion, E2eeChatBody, E2eeOptions, E2eeAttestationVerifier } from "./e2ee.js";

export { AgentPolicyDenied, AgentKilled, AgentApprovalRequired } from "./agent-errors.js";
export type { AgentPolicy, AgentLane, AgentRouteDefault, AgentIntent, AgentReason, AgentDecision, AgentRemaining, AgentRulebook, AgentReplay, AgentReplayExample, AgentPayInput, AgentPayDecision, AgentPayInstructions, AgentPayment, AgentPaymentStatus, AgentSignedDecision } from "./agent.js";
export type { Playbook, PlaybookChange, PlaybookFollowResult } from "./playbooks.js";
export { holderClient, holderVoteBody, holderVoteHeader, holderVotePath } from "./holders.js";
export type { EarlyAccessRefusal, HolderLimits, HolderPerks, HolderPoll, HolderPollKind, HolderStatus, HolderTier, HolderTiers, HolderVote, ModelEarlyAccess } from "./holders.js";

export { verifyRecordCertificate, isRecordCertificate, RECORD_CERTIFICATE_NOTICE } from "./record-certificate.js";
export type { RecordCertificate, RecordClaim } from "./record-certificate.js";

export { agreementClient } from "./agreements.js";
export type { AgreementPrepare, AgreementTransaction } from "./agreements.js";

// Solana payments: x402 per-call payments, tabs and vouchers, transaction signing, wallet sign-in, X-Wallet-Auth (also at ./solana).
export {
  ASSOCIATED_TOKEN_PROGRAM, COMPUTE_BUDGET_PROGRAM, EMPTY_BODY_HASH, EXACT_LIMITS, MAX_TAB_LIFETIME_SECONDS, OPEN_TAB_DISCRIMINATOR, RECLAIM_DISCRIMINATOR, SOLANA_DEVNET, SOLANA_MAINNET, SYSTEM_PROGRAM, TAB_ACCOUNT_DISCRIMINATOR, TOKEN_2022_PROGRAM, TOKEN_PROGRAM, TOP_UP_DISCRIMINATOR, USDC_DECIMALS, USDC_MINT, VOUCHER_DOMAIN, VOUCHER_MESSAGE_LENGTH, WALLET_AUTH_VERSION, WALLET_SIGN_IN_VERSION,
  TabSession, accountData, address, associatedTokenAddress, base58Decode, base58Encode, buildExactPayment, canonicalBodyHash, chatRequestHash, checkWalletChallenge, compileLegacyMessage, computeBudgetInstructions, createProgramAddress, decodeTabAccount, exactPaymentInstructions, fetchTabAccount, findProgramAddress, generateSessionKey, hostResourceHash, isOnCurve, keypairSigner, landedPaymentHeaders, latestBlockhash, openTabInstruction, openTabTransaction, parsePaymentRequired, parsePaymentResponse, parseTransaction, parseVoucherHeader, parseVoucherMessage, parseWalletSignInMessage, payPerCall, priorityFeeLamports, publicKeyBytes, randomTabId, reclaimInstruction, rulesConfigAddress, sendTransaction, serializeTransaction, signCreditClosure, signCreditClosureCancel, signRefundDestination, signTransaction, signVoucher, signerFromSeed, tabAddress, tabEnforcerAddress, tabPdas, topUpInstruction, verifyVoucher, voucherHeaders, voucherMessage, walletAuthHeader, walletAuthMessage, walletSignIn, walletSignInBody, x402PaymentHeader,
} from "./solana.js";
export type { AccountMeta, BuildExactOptions, Commitment, CompiledMessage, ConnectionLike, ExactPayment, Instruction, KeypairSigner, OpenTabOptions, OpenTabTransaction, ParsedTransaction, PaymentRequired, PaymentResponse, PerCallOptions, PerCallPayer, PublicKeyLike, RpcOptions, SignedVoucher, Signer, TabAccount, TabPdas, TabRulebook, Voucher, VoucherHeaders, VoucherScope, WalletAuthOptions, WalletAuthRequest, WalletChallenge, WalletSignInFields, WireVoucher, X402Requirement, ExactLimits } from "./solana.js";
