import { PublicKey, TransactionInstruction, type AddressLookupTableAccount, TransactionMessage, VersionedTransaction, type Keypair } from "@solana/web3.js";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  Actions,
  AuthorityType,
  Ed25519SessionAuthority,
  SWIG_PROGRAM_ADDRESS,
  SolPublicKey,
  Swig,
  createEd25519AuthorityInfo,
  createEd25519SessionAuthorityInfo,
  findSwigPda,
  getAddAuthorityInstructions,
  getCreateSwigInstruction,
  getEd25519SessionEncoder,
  getInstructionsFromContext,
  getRemoveAuthorityInstructions,
  getSignInstructions,
  getSwigCodec,
} from "@swig-wallet/classic";
import type { RpcLike } from "./rpc.ts";
import { withRetry } from "./rpc.ts";

// Swig smart-wallet sessions for pay-with-stock (docs/Trellis_Backend.md §6), through `@swig-wallet/classic` 2.1.0
// (the web3.js v1 flavour of the Swig TypeScript SDK; program swigypWHEksbC64pWKwah1WTeh9JXwx8H1rJHLdbQMB).
//
// The owner keeps the tokenized stock in a Swig wallet (a PDA of the Swig program, ["swig", id]) and authorises ONE role
// for Trellis: an Ed25519 *session* authority whose root is the owner's wallet key and whose session key is the router's
// per-API-key session keypair. The role's actions are the spending policy the Swig program enforces on every signed
// instruction, so the router can never move more than the owner allowed:
//   - tokenRecurringLimit(stock mint, cap per day, window = SLOTS_PER_DAY): the per-day token cap of docs §6,
//   - solRecurringLimit(a few thousand lamports a day) for the rent of any token account a Jupiter route sets up,
//   - programAll(): Jupiter routes through many DEX programs; the token and SOL limits are what bounds the spend.
// A session key is only live until its expiry slot: the owner's authorise transaction adds the role and starts the first
// session (create_session) for SESSION_MAX_SLOTS; `renewSessionInstructions` starts another one later. The router then
// signs Jupiter ExactOut swaps with the session key: the swap instructions become inner instructions of a Swig `sign`
// (getSignInstructions) and the session key is the transaction's fee payer. Closing a session hands the owner an unsigned
// remove_authority; the tokens never left the owner's Swig wallet.
//
// Everything here is offline (instruction building and account decoding); reads go through the injected connection.

export const SWIG_PROGRAM_ID: PublicKey = SWIG_PROGRAM_ADDRESS;
/** Slots per day at the cluster's ~400 ms slot time: the window of the per-day token cap. */
export const SLOTS_PER_DAY = 216_000n;
/** The longest session the role allows (docs §6: a session key is good for at most 7 days). */
export const SESSION_MAX_SLOTS = 7n * SLOTS_PER_DAY;
/** Lamports per day the role may spend from the Swig wallet on token-account rent a swap route sets up (~0.005 SOL). */
export const SWIG_RENT_LAMPORTS_PER_DAY = 5_000_000n;

/** The Swig id Trellis derives for a key: sha256("trellis:paywith-swig:" network ":" chainKeyHash). Stable, so the same wallet is reused across sessions. */
export function swigIdFor(network: string, chainKeyHash: string): Uint8Array {
  return sha256(new TextEncoder().encode(`trellis:paywith-swig:${network}:${chainKeyHash.toLowerCase().replace(/^0x/, "")}`));
}
export const swigAddressFor = (id: Uint8Array): PublicKey => findSwigPda(id);

/** A decoded Swig account plus the raw fields the SDK keeps private (role_counter is the next role id). */
export type SwigState = { swig: Swig; address: PublicKey; roleCounter: number; roles: number };

export function decodeSwig(address: PublicKey, data: Uint8Array): SwigState {
  const raw = getSwigCodec().decode(data);
  return { swig: Swig.fromRawAccountData(address, data), address, roleCounter: raw.role_counter, roles: raw.roles };
}

/** The Swig account at `address`, or null when it does not exist yet. */
export async function readSwig(conn: Pick<RpcLike, "getAccountInfo">, address: PublicKey): Promise<SwigState | null> {
  const info = await withRetry(() => conn.getAccountInfo(address));
  if (!info) return null;
  if (!info.owner.equals(SWIG_PROGRAM_ID)) throw new Error("account is not a Swig wallet");
  return decodeSwig(address, new Uint8Array(info.data));
}

/** What the chain says about the Trellis role of a session key. */
export type SwigSessionRole = {
  roleId: number;
  /** The owner's wallet key the role answers to. */
  owner: PublicKey;
  sessionKey: PublicKey;
  /** Last slot the session key may sign at; 0 until the owner starts a session. */
  expirySlot: bigint;
  maxDurationSlots: bigint;
  /** The recurring token cap on `mint` (raw units per window) and what is left in the current window, or null without a token action. */
  tokenCapRaw: bigint | null;
  tokenRemainingRaw: bigint | null;
  windowSlots: bigint | null;
  /** The slot the current window started at; the program opens a fresh window (full cap) on the first spend past lastReset + window. */
  lastResetSlot: bigint | null;
};

/** The role whose session key is `sessionKey`, read through the SDK's role deserialiser, or null. */
export function sessionRole(state: SwigState, sessionKey: PublicKey, mint: PublicKey): SwigSessionRole | null {
  const role = state.swig.findRoleBySessionKey(sessionKey);
  if (!role || role.authorityType !== AuthorityType.Ed25519Session) return null;
  const a = role.authority as Ed25519SessionAuthority;
  const spend = role.actions.tokenSpend(mint);
  return {
    roleId: role.id,
    owner: new PublicKey(a.ed25519PublicKey.toBytes()),
    sessionKey: new PublicKey(a.sessionKey.toBytes()),
    expirySlot: a.expirySlot,
    maxDurationSlots: a.maxDuration,
    tokenCapRaw: spend.isAllowed ? (spend.recurringLimit ?? spend.spendLimit) : null,
    tokenRemainingRaw: spend.isAllowed ? spend.spendLimit : null,
    windowSlots: spend.isAllowed ? spend.window : null,
    lastResetSlot: spend.isAllowed ? (spend.lastReset ?? null) : null,
  };
}

/** The actions of the Trellis role: the per-day cap on the stock mint, rent money, and the programs a route may touch. */
export function trellisRoleActions(mint: PublicKey, capRawPerDay: bigint): Actions {
  return Actions.set()
    .tokenRecurringLimit({ mint, recurringAmount: capRawPerDay, window: SLOTS_PER_DAY })
    .solRecurringLimit({ recurringAmount: SWIG_RENT_LAMPORTS_PER_DAY, window: SLOTS_PER_DAY })
    .programAll()
    .get();
}

/** The authority info of the Trellis role: an Ed25519 session authority rooted in the owner's key with the session key preset. */
export const trellisRoleAuthority = (owner: PublicKey, sessionKey: PublicKey) => createEd25519SessionAuthorityInfo(owner, SESSION_MAX_SLOTS, new SolPublicKey(sessionKey.toBytes()));

/**
 * The owner's authorise transaction, as instructions (fee payer = owner): creates the Swig wallet when it does not exist
 * (owner = root authority, role 0), adds the Trellis session role with `trellisRoleActions`, and starts the first session
 * for `durationSlots` so the session key can sign at once. The role id is the account's role counter (role 1 of a new
 * wallet); the caller records it with the session and checks it against the chain after the transaction lands.
 */
export async function authorizeSessionInstructions(o: { owner: PublicKey; id: Uint8Array; state: SwigState | null; sessionKey: PublicKey; mint: PublicKey; capRawPerDay: bigint; durationSlots?: bigint; currentSlot: bigint }): Promise<{ instructions: TransactionInstruction[]; swig: PublicKey; roleId: number }> {
  const swigAddress = swigAddressFor(o.id);
  const actions = trellisRoleActions(o.mint, o.capRawPerDay);
  const authority = trellisRoleAuthority(o.owner, o.sessionKey);
  const duration = o.durationSlots ?? SESSION_MAX_SLOTS;
  if (duration <= 0n || duration > SESSION_MAX_SLOTS) throw new Error("session duration must be between 1 and SESSION_MAX_SLOTS slots");
  const instructions: TransactionInstruction[] = [];
  let roleId: number;
  let ownerRoleId = 0;
  if (!o.state) {
    instructions.push(await getCreateSwigInstruction({ payer: o.owner, id: o.id, actions: Actions.set().all().get(), authorityInfo: createEd25519AuthorityInfo(o.owner) }));
    roleId = 1;
    // The account does not exist yet, so the add goes through a Swig built from what create_v1 will write.
    const created = decodeSwig(swigAddress, Uint8Array.from(getSwigCodec().encode({ discriminator: 1, bump: 0, id: o.id, roles: 1, role_counter: 1, reserved_lamports_or_bump: 0n, roles_buffer: rootRoleBytes(o.owner) })));
    instructions.push(...(await getAddAuthorityInstructions(created.swig, 0, authority, actions, { payer: o.owner, currentSlot: o.currentSlot })));
  } else {
    if (!swigAddress.equals(o.state.address)) throw new Error("Swig id does not match the account");
    const ownerRole = o.state.swig.findRolesByEd25519SignerPk(o.owner).find((r) => r.actions.canManageAuthority() || r.actions.isRoot());
    if (!ownerRole) throw new Error("the owner's wallet holds no role that may manage this Swig's authorities");
    ownerRoleId = ownerRole.id;
    roleId = o.state.roleCounter;
    instructions.push(...(await getAddAuthorityInstructions(o.state.swig, ownerRoleId, authority, actions, { payer: o.owner, currentSlot: o.currentSlot })));
  }
  // create_session for the role that add_authority is about to create: built from the same authority bytes, signed by the owner.
  instructions.push(...(await startSessionInstructions({ swig: swigAddress, owner: o.owner, roleId, sessionKey: o.sessionKey, durationSlots: duration })));
  return { instructions, swig: swigAddress, roleId };
}

/** The roles buffer create_v1 writes for an owner-rooted wallet: one Ed25519 role with the `all` action. */
function rootRoleBytes(owner: PublicKey): Uint8Array {
  const authority = owner.toBytes();
  const actions = Actions.set().all().get().bytes();
  const position = Buffer.alloc(16);
  position.writeUInt16LE(AuthorityType.Ed25519, 0);
  position.writeUInt16LE(authority.length, 2);
  position.writeUInt16LE(actions.length ? 1 : 0, 4);
  position.writeUInt32LE(0, 8);
  position.writeUInt32LE(16 + authority.length + actions.length, 12);
  return new Uint8Array(Buffer.concat([position, Buffer.from(authority), Buffer.from(actions)]));
}

/** create_session(roleId, sessionKey, duration) for an Ed25519 session role, signed by the owner (the role's root key). */
async function startSessionInstructions(o: { swig: PublicKey; owner: PublicKey; roleId: number; sessionKey: PublicKey; durationSlots: bigint; maxDurationSlots?: bigint }): Promise<TransactionInstruction[]> {
  // The on-chain authority record (80 bytes: the 72-byte create payload plus current_session_expiration), as the SDK
  // decodes it; create_session only needs the owner's key out of it, the chain holds the rest.
  const data = getEd25519SessionEncoder().encode({ publicKey: o.owner.toBytes(), sessionKey: o.sessionKey.toBytes(), maxSessionLength: o.maxDurationSlots ?? SESSION_MAX_SLOTS, currentSessionExpiration: 0n });
  const authority = new Ed25519SessionAuthority(new Uint8Array(data));
  const context = await authority.createSession({ payer: o.owner, swigAddress: o.swig, roleId: o.roleId, newSessionKey: o.sessionKey, sessionDuration: o.durationSlots });
  return getInstructionsFromContext(context);
}

/** Another session for an existing role (after the previous one expired), signed by the owner. */
export async function renewSessionInstructions(o: { state: SwigState; role: SwigSessionRole; sessionKey: PublicKey; durationSlots?: bigint }): Promise<TransactionInstruction[]> {
  const duration = o.durationSlots ?? o.role.maxDurationSlots;
  if (duration <= 0n || duration > o.role.maxDurationSlots) throw new Error("session duration exceeds the role's maximum");
  return startSessionInstructions({ swig: o.state.address, owner: o.role.owner, roleId: o.role.roleId, sessionKey: o.sessionKey, durationSlots: duration, maxDurationSlots: o.role.maxDurationSlots });
}

/** remove_authority for the Trellis role, signed by the owner: what closing a session hands back. */
export async function revokeSessionInstructions(o: { state: SwigState; role: SwigSessionRole; currentSlot: bigint }): Promise<TransactionInstruction[]> {
  const ownerRole = o.state.swig.findRolesByEd25519SignerPk(o.role.owner).find((r) => r.actions.canManageAuthority() || r.actions.isRoot());
  if (!ownerRole) throw new Error("the owner's wallet holds no role that may manage this Swig's authorities");
  return getRemoveAuthorityInstructions(o.state.swig, ownerRole.id, o.role.roleId, { payer: o.role.owner, currentSlot: o.currentSlot });
}

/** Whether the role's session key may sign at `slot` (the program refuses once slot > expiry). */
export const sessionLive = (role: SwigSessionRole, slot: bigint) => role.expirySlot > 0n && slot <= role.expirySlot;

/**
 * Wrap `inner` (a Jupiter route: setup, swap, cleanup) in the Swig `sign` of the role, to be signed by the session key as
 * fee payer. Compute-budget instructions stay top-level (the runtime reads them from the transaction, not from a CPI).
 */
export async function signWithSession(o: { state: SwigState; role: SwigSessionRole; inner: TransactionInstruction[]; currentSlot: bigint }): Promise<TransactionInstruction[]> {
  return getSignInstructions(o.state.swig, o.role.roleId, o.inner, false, { payer: o.role.sessionKey, currentSlot: o.currentSlot });
}

/** A v0 transaction of `instructions` paid and signed by the session key, with the route's lookup tables. */
export function sessionTransaction(o: { sessionKey: Keypair; instructions: TransactionInstruction[]; recentBlockhash: string; lookupTables?: AddressLookupTableAccount[] }): VersionedTransaction {
  const message = new TransactionMessage({ payerKey: o.sessionKey.publicKey, recentBlockhash: o.recentBlockhash, instructions: o.instructions }).compileToV0Message(o.lookupTables ?? []);
  const tx = new VersionedTransaction(message);
  tx.sign([o.sessionKey]);
  return tx;
}

/** A Jupiter `/swap/v1/swap-instructions` instruction object as a TransactionInstruction. */
export type JupiterInstruction = { programId: string; accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[]; data: string };
export const jupiterInstruction = (i: JupiterInstruction): TransactionInstruction =>
  new TransactionInstruction({ programId: new PublicKey(i.programId), keys: i.accounts.map((k) => ({ pubkey: new PublicKey(k.pubkey), isSigner: k.isSigner, isWritable: k.isWritable })), data: Buffer.from(i.data, "base64") });
