import { BN, BorshCoder, type Idl } from "@anchor-lang/core";
import { PublicKey, TransactionInstruction, type AccountMeta } from "@solana/web3.js";
import { bytesEqual, eventPayloads } from "./encoding.ts";

// IDL-driven Anchor client layer. Every program wrapper in this directory loads its generated IDL (src/solana/idl/*.json,
// copied from target/idl after `anchor build`) and builds instructions, decodes accounts and parses events through
// @anchor-lang/core's BorshCoder, so discriminators, argument order, account order and layouts can never drift from the
// programs: the IDL is the contract. Instruction building stays synchronous (the services and the wallet flows build
// transactions without touching the network): account metas follow the IDL's account list, PDAs with const / arg /
// account seeds are derived here, constant addresses (programs, sysvars) are filled in, and an optional account that is
// not supplied is passed as the program id (Anchor's convention for `None`).
//
// Values cross the boundary as: bigint <-> u64/i64 (BN inside the coder), Uint8Array <-> [u8; N], PublicKey <-> pubkey,
// null <-> Option::None, and enums as their variant name ("Open") <-> { Open: {} }.

type IdlType = string | { array: [IdlType, number] } | { option: IdlType } | { vec: IdlType } | { defined: { name: string } } | { coption: IdlType };
type IdlField = { name: string; type: IdlType };
type IdlSeed = { kind: "const"; value: number[] } | { kind: "arg"; path: string } | { kind: "account"; path: string; account?: string };
type IdlAccountItem = { name: string; writable?: boolean; signer?: boolean; optional?: boolean; address?: string; pda?: { seeds: IdlSeed[]; program?: { kind: string; value?: number[]; path?: string } } };
type IdlInstruction = { name: string; discriminator: number[]; accounts: IdlAccountItem[]; args: IdlField[] };
type IdlTypeDef = { name: string; type: { kind: "struct"; fields?: IdlField[] } | { kind: "enum"; variants: { name: string }[] } };
export type TrellisIdl = Idl & { address: string; instructions: IdlInstruction[]; accounts?: { name: string; discriminator: number[] }[]; events?: { name: string; discriminator: number[] }[]; types?: IdlTypeDef[] };

/** What a deployed program says about the build it is (`build_profile`). `floors` holds every i64 it returns, by name. */
export type BuildProfile = { profile: number; devnet: boolean; configTimelock: bigint; floors: Record<string, bigint> };

/**
 * Whether a pause is in force: its flag is set AND its expiry lies ahead. Every pause lapses by itself 72h after it was
 * last set (security re-review RR-02), so the flag alone says nothing once `pausedUntil` has passed.
 */
export const pauseActive = (paused: boolean, pausedUntil: bigint | number, nowSeconds: number | bigint = Math.floor(Date.now() / 1000)) => paused && BigInt(nowSeconds) < BigInt(pausedUntil);

/** Values a wrapper passes as instruction arguments and account fields. */
export type Value = bigint | number | boolean | string | Uint8Array | PublicKey | null | undefined | Value[] | { [k: string]: Value };
export type Accounts = Record<string, PublicKey | string | null | undefined>;

export class IdlProgram {
  readonly coder: BorshCoder;
  readonly programId: PublicKey;
  private readonly ixByName = new Map<string, IdlInstruction>();
  private readonly typeByName = new Map<string, IdlTypeDef>();

  constructor(readonly idl: TrellisIdl, programId?: PublicKey | string) {
    this.coder = new BorshCoder(idl);
    this.programId = programId ? new PublicKey(programId) : new PublicKey(idl.address);
    for (const ix of idl.instructions) this.ixByName.set(ix.name, ix);
    for (const t of idl.types ?? []) this.typeByName.set(t.name, t);
  }

  /** The same program at another address (deployments differ per cluster; the IDL holds the localnet id). */
  at(programId: PublicKey | string): IdlProgram {
    const id = typeof programId === "string" ? programId : programId.toBase58();
    if (id === this.programId.toBase58()) return this;
    let p = this.atCache.get(id);
    if (!p) { p = new IdlProgram(this.idl, id); if (this.atCache.size < 64) this.atCache.set(id, p); }
    return p;
  }
  private readonly atCache = new Map<string, IdlProgram>();

  get name() { return this.idl.metadata?.name ?? ""; }
  get instructionNames() { return this.idl.instructions.map((i) => i.name); }

  instructionDiscriminator(name: string) { return new Uint8Array(this.instruction_(name).discriminator); }
  accountDiscriminator(name: string) { const a = this.idl.accounts?.find((x) => x.name === name); if (!a) throw new Error(`${this.name}: no account ${name}`); return new Uint8Array(a.discriminator); }
  eventDiscriminator(name: string) { const e = this.idl.events?.find((x) => x.name === name); if (!e) throw new Error(`${this.name}: no event ${name}`); return new Uint8Array(e.discriminator); }

  private instruction_(name: string) { const ix = this.ixByName.get(name); if (!ix) throw new Error(`${this.name}: no instruction ${name}`); return ix; }

  /** Encoded instruction data: discriminator || Borsh(args in IDL order). */
  encodeArgs(name: string, args: Record<string, Value>): Buffer {
    const ix = this.instruction_(name);
    const encoded: Record<string, unknown> = {};
    for (const a of ix.args) encoded[a.name] = this.toCoder(a.type, args[a.name], `${name}.${a.name}`);
    return this.coder.instruction.encode(name, encoded);
  }

  /**
   * A TransactionInstruction for `name`: `accounts` by IDL name (missing PDAs are derived from const/arg/account seeds,
   * constant addresses are filled in, missing optional accounts become the program id); `args` by IDL name.
   */
  instruction(name: string, args: Record<string, Value>, accounts: Accounts): TransactionInstruction {
    const ix = this.instruction_(name);
    const resolved = new Map<string, PublicKey>();
    for (const [k, v] of Object.entries(accounts)) if (v !== null && v !== undefined) resolved.set(k, new PublicKey(v));
    const keys: AccountMeta[] = [];
    for (const a of ix.accounts) {
      let pubkey = resolved.get(a.name) ?? null;
      if (!pubkey && a.address) pubkey = new PublicKey(a.address);
      if (!pubkey && a.pda) pubkey = this.derivePda(a, ix, args, resolved);
      if (!pubkey) {
        if (!a.optional) throw new Error(`${this.name}.${name}: account ${a.name} is required`);
        keys.push({ pubkey: this.programId, isSigner: false, isWritable: false }); // Anchor's `None`
        continue;
      }
      resolved.set(a.name, pubkey);
      keys.push({ pubkey, isSigner: !!a.signer, isWritable: !!a.writable });
    }
    return new TransactionInstruction({ programId: this.programId, keys, data: this.encodeArgs(name, args) });
  }

  private derivePda(a: IdlAccountItem, ix: IdlInstruction, args: Record<string, Value>, resolved: Map<string, PublicKey>): PublicKey | null {
    const seeds: Buffer[] = [];
    for (const s of a.pda!.seeds) {
      if (s.kind === "const") seeds.push(Buffer.from(s.value));
      else if (s.kind === "arg") {
        const [head, ...rest] = s.path.split(".");
        const arg = ix.args.find((x) => x.name === head);
        if (!arg) return null;
        let type: IdlType = arg.type;
        let value: Value = args[head];
        for (const p of rest) {
          const def = typeof type === "object" && "defined" in type ? this.typeByName.get(type.defined.name) : undefined;
          const field = def && def.type.kind === "struct" ? def.type.fields?.find((f) => f.name === p) : undefined;
          if (!field || value === null || typeof value !== "object" || value instanceof Uint8Array || value instanceof PublicKey || Array.isArray(value)) return null;
          type = field.type;
          value = (value as Record<string, Value>)[p];
        }
        const bytes = seedBytes(type, value);
        if (!bytes) return null;
        seeds.push(bytes);
      } else {
        // "account" seeds: the pubkey of another account in this instruction, or a field of its data ("tab.payer"), which
        // the caller supplies under that dotted name.
        const direct = resolved.get(s.path);
        if (!direct) return null;
        seeds.push(direct.toBuffer());
      }
    }
    const program = a.pda!.program?.value ? new PublicKey(Buffer.from(a.pda!.program.value)) : this.programId;
    return PublicKey.findProgramAddressSync(seeds, program)[0];
  }

  /**
   * build_profile(): every Trellis program reports the floors compiled into the deployed binary (profile 0 = the
   * mainnet build, 1 = the `devnet` cargo feature). It changes nothing; simulate it and read the return data with
   * `decodeBuildProfile`. The IDL is the same file for both builds, so this is the only way to tell them apart on chain.
   */
  buildProfileInstruction(): TransactionInstruction {
    return this.instruction("build_profile", {}, {});
  }

  /**
   * The return data of build_profile: `profile` (u8) then this program's floors (i64 each, in the IDL's field order,
   * camelCased). Null when the bytes are not exactly that struct.
   */
  decodeBuildProfile(data: Uint8Array): BuildProfile | null {
    const def = this.typeByName.get("BuildProfile");
    if (!def || def.type.kind !== "struct" || !def.type.fields) return null;
    const fields = def.type.fields;
    if (data.length !== 1 + 8 * (fields.length - 1) || fields[0]?.name !== "profile") return null;
    const b = Buffer.from(data);
    const floors: Record<string, bigint> = {};
    fields.slice(1).forEach((f, i) => { floors[f.name.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())] = b.readBigInt64LE(1 + 8 * i); });
    if (floors.configTimelock === undefined) return null;
    return { profile: b[0]!, devnet: b[0] !== 0, configTimelock: floors.configTimelock, floors };
  }

  /** PDA by seeds under this program. */
  pda(...seeds: (Buffer | Uint8Array | PublicKey | string)[]) {
    return PublicKey.findProgramAddressSync(seeds.map((s) => (s instanceof PublicKey ? s.toBuffer() : typeof s === "string" ? Buffer.from(s) : Buffer.from(s))), this.programId)[0];
  }

  /**
   * Bytes the program allocates for an account of type `name` (discriminator included; the maximum for a layout with
   * options). An account on chain that is shorter was written by an earlier build and has to be grown before the
   * program can read it (`migrate_config`, `migrate_proposal`): `decodeAccount` reads the missing tail as zeros.
   */
  accountSize(name: string): number {
    return (this.coder.accounts as unknown as { size(name: string): number }).size(name);
  }

  /** Decode an account of type `name`; null when the data carries another discriminator (or is too short). */
  decodeAccount<T = Record<string, unknown>>(name: string, data: Uint8Array): T | null {
    const disc = this.accountDiscriminator(name);
    if (data.length < 8 || !bytesEqual(data.subarray(0, 8), disc)) return null;
    const def = this.typeByName.get(name);
    const raw = this.coder.accounts.decode(name, Buffer.from(data)) as Record<string, unknown>;
    return this.fromCoder(def, raw) as T;
  }

  /** Encode an account (tests and fixtures): discriminator || Borsh(fields). */
  encodeAccount(name: string, fields: Record<string, Value>): Uint8Array {
    const def = this.typeByName.get(name);
    if (!def || def.type.kind !== "struct") throw new Error(`${this.name}: no struct ${name}`);
    const encoded: Record<string, unknown> = {};
    for (const f of def.type.fields ?? []) encoded[f.name] = this.toCoder(f.type, fields[f.name], `${name}.${f.name}`);
    const layout = this.coder.types as unknown as { encode(name: string, v: unknown): Buffer };
    return new Uint8Array(Buffer.concat([Buffer.from(this.accountDiscriminator(name)), layout.encode(name, encoded)]));
  }

  /** Encode an event as the program logs it (`Program data: <base64>`), for tests. */
  eventLogLine(name: string, fields: Record<string, Value>): string {
    const def = this.typeByName.get(name);
    if (!def || def.type.kind !== "struct") throw new Error(`${this.name}: no event ${name}`);
    const encoded: Record<string, unknown> = {};
    for (const f of def.type.fields ?? []) encoded[f.name] = this.toCoder(f.type, fields[f.name], `${name}.${f.name}`);
    const layout = this.coder.types as unknown as { encode(name: string, v: unknown): Buffer };
    const body = layout.encode(name, encoded);
    return `Program data: ${Buffer.concat([Buffer.from(this.eventDiscriminator(name)), body]).toString("base64")}`;
  }

  /**
   * Every event THIS program (at `this.programId`) emitted in a transaction's log messages, in order. A `Program data:`
   * line counts only when it was written while this program id was on top of the invocation stack (see
   * parseProgramLogs): bytes another program logged, in a transaction that merely names this program, are not events of
   * this program however well they decode. A truncated log yields nothing (check `logsTruncated`). The program id differs
   * per cluster: decode through `at(<configured id>)`, never through the IDL's default address.
   */
  events(logs: readonly string[]): { name: string; data: Record<string, unknown> }[] {
    const out: { name: string; data: Record<string, unknown> }[] = [];
    const known = new Map((this.idl.events ?? []).map((e) => [Buffer.from(e.discriminator).toString("hex"), e.name]));
    for (const p of eventPayloads(logs, this.programId)) {
      if (p.length < 8) continue;
      const name = known.get(Buffer.from(p.subarray(0, 8)).toString("hex"));
      if (!name) continue;
      try {
        const ev = this.coder.events.decode(Buffer.from(p).toString("base64"));
        if (ev) out.push({ name: ev.name, data: this.fromCoder(this.typeByName.get(ev.name), ev.data as Record<string, unknown>) as Record<string, unknown> });
      } catch { /* a colliding prefix from another program */ }
    }
    return out;
  }

  /** Decoded `name` events this program emitted (same attribution rule as `events`). */
  eventsNamed<T = Record<string, unknown>>(name: string, logs: readonly string[]): T[] {
    return this.events(logs).filter((e) => e.name === name).map((e) => e.data as T);
  }

  // ---- value conversion ----------------------------------------------------------------------------------------------

  private toCoder(type: IdlType, v: Value, where: string): unknown {
    if (typeof type === "string") {
      switch (type) {
        case "u64": case "i64": case "u128": case "i128":
          if (v === undefined || v === null) throw new Error(`${where}: missing ${type}`);
          return new BN((typeof v === "bigint" ? v : BigInt(v as number)).toString());
        case "u8": case "u16": case "u32": case "i8": case "i16": case "i32":
          if (v === undefined || v === null) throw new Error(`${where}: missing ${type}`);
          return Number(v);
        case "bool": return !!v;
        case "pubkey": if (v === undefined || v === null) throw new Error(`${where}: missing pubkey`); return new PublicKey(v as string | PublicKey);
        case "string": return String(v);
        case "bytes": return Buffer.from(v as Uint8Array);
        default: throw new Error(`${where}: unsupported type ${type}`);
      }
    }
    if ("option" in type || "coption" in type) return v === null || v === undefined ? null : this.toCoder(("option" in type ? type.option : (type as { coption: IdlType }).coption), v, where);
    if ("array" in type) {
      const [inner, n] = type.array;
      if (inner === "u8") { const b = v as Uint8Array; if (!b || b.length !== n) throw new Error(`${where}: expected ${n} bytes`); return Array.from(b); }
      return (v as Value[]).map((x, i) => this.toCoder(inner, x, `${where}[${i}]`));
    }
    if ("vec" in type) return type.vec === "u8" ? Buffer.from(v as Uint8Array) : (v as Value[]).map((x, i) => this.toCoder(type.vec, x, `${where}[${i}]`));
    if ("defined" in type) {
      const def = this.typeByName.get(type.defined.name);
      if (!def) throw new Error(`${where}: unknown type ${type.defined.name}`);
      if (def.type.kind === "enum") {
        const variant = typeof v === "string" ? v : typeof v === "number" ? def.type.variants[v]?.name : undefined;
        if (!variant || !def.type.variants.some((x) => x.name === variant)) throw new Error(`${where}: unknown variant ${String(v)}`);
        return { [variant]: {} };
      }
      const out: Record<string, unknown> = {};
      const obj = (v ?? {}) as Record<string, Value>;
      for (const f of def.type.fields ?? []) out[f.name] = this.toCoder(f.type, obj[f.name], `${where}.${f.name}`);
      return out;
    }
    throw new Error(`${where}: unsupported type`);
  }

  private fromCoder(def: IdlTypeDef | undefined, raw: Record<string, unknown>): Record<string, unknown> {
    if (!def || def.type.kind !== "struct") return raw;
    const out: Record<string, unknown> = {};
    for (const f of def.type.fields ?? []) out[f.name] = this.fromValue(f.type, raw[f.name]);
    return out;
  }

  private fromValue(type: IdlType, v: unknown): unknown {
    if (v === null || v === undefined) return null;
    if (typeof type === "string") {
      switch (type) {
        case "u64": case "i64": case "u128": case "i128": return BigInt((v as BN).toString());
        case "bytes": return new Uint8Array(v as Buffer);
        default: return v;
      }
    }
    if ("option" in type) return this.fromValue(type.option, v);
    if ("coption" in type) return this.fromValue(type.coption, v);
    if ("array" in type) return type.array[0] === "u8" ? new Uint8Array(v as number[]) : (v as unknown[]).map((x) => this.fromValue(type.array[0], x));
    if ("vec" in type) return type.vec === "u8" ? new Uint8Array(v as Buffer) : (v as unknown[]).map((x) => this.fromValue(type.vec, x));
    if ("defined" in type) {
      const def = this.typeByName.get(type.defined.name);
      if (def?.type.kind === "enum") return Object.keys(v as object)[0];
      return this.fromCoder(def, v as Record<string, unknown>);
    }
    return v;
  }
}

/** The seed bytes of an arg of `type`, as Anchor derives them (little-endian integers, raw byte arrays, pubkeys). */
function seedBytes(type: IdlType, v: Value): Buffer | null {
  if (v === null || v === undefined) return null;
  if (typeof type === "string") {
    switch (type) {
      case "u64": case "i64": return new BN(BigInt(v as bigint | number).toString()).toTwos(64).toArrayLike(Buffer, "le", 8);
      case "u32": case "i32": return new BN(Number(v)).toTwos(32).toArrayLike(Buffer, "le", 4);
      case "u16": case "i16": return new BN(Number(v)).toTwos(16).toArrayLike(Buffer, "le", 2);
      case "u8": case "i8": return Buffer.from([Number(v) & 0xff]);
      case "pubkey": return new PublicKey(v as string | PublicKey).toBuffer();
      case "string": return Buffer.from(String(v));
      default: return null;
    }
  }
  if ("array" in type && type.array[0] === "u8") return Buffer.from(v as Uint8Array);
  return null;
}

/** Little-endian 8-byte seed of a u64/i64 (PDA seeds like `hour` and `tab_id`). */
export const le64 = (v: bigint | number) => new BN(BigInt(v).toString()).toTwos(64).toArrayLike(Buffer, "le", 8);

export const BPF_UPGRADEABLE_LOADER_ID = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
/**
 * A program's ProgramData account (the PDA of its id under the upgradeable loader). Every `init_*` instruction takes it:
 * the programs only let their upgrade authority initialise them (security review TR-13).
 */
export const programDataAddress = (programId: PublicKey | string) => PublicKey.findProgramAddressSync([new PublicKey(programId).toBuffer()], BPF_UPGRADEABLE_LOADER_ID)[0];
