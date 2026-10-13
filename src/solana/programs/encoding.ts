import { createHash } from "node:crypto";
import { PublicKey } from "@solana/web3.js";

// IDL-free Anchor encoding. Anchor v1 derives every 8-byte discriminator from sha256 of a namespaced name:
//   instruction  sha256("global:<snake_case_ix_name>")[0..8]
//   account      sha256("account:<PascalCaseStructName>")[0..8]
//   event        sha256("event:<PascalCaseEventName>")[0..8]
// Arguments follow as Borsh (little-endian integers, u32-length-prefixed strings and vectors, 1-byte bools, Option as a
// 0/1 tag). These helpers let the router build instructions and read accounts before the generated IDLs land in
// src/solana/idl/; when they do, the discriminators and layouts here must agree with them byte for byte.

const sha = (s: string) => createHash("sha256").update(s).digest();
export const ixDiscriminator = (name: string) => new Uint8Array(sha(`global:${name}`).subarray(0, 8));
export const accountDiscriminator = (name: string) => new Uint8Array(sha(`account:${name}`).subarray(0, 8));
export const eventDiscriminator = (name: string) => new Uint8Array(sha(`event:${name}`).subarray(0, 8));

export const bytesEqual = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

const U64_MAX = (1n << 64n) - 1n;
const I64_MIN = -(1n << 63n), I64_MAX = (1n << 63n) - 1n;

/** Append-only Borsh writer. */
export class BorshWriter {
  private parts: Uint8Array[] = [];
  u8(v: number) { if (!Number.isInteger(v) || v < 0 || v > 0xff) throw new RangeError("u8 out of range"); this.parts.push(new Uint8Array([v])); return this; }
  bool(v: boolean) { return this.u8(v ? 1 : 0); }
  u16(v: number) { if (!Number.isInteger(v) || v < 0 || v > 0xffff) throw new RangeError("u16 out of range"); const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, v, true); this.parts.push(b); return this; }
  u32(v: number) { if (!Number.isInteger(v) || v < 0 || v > 0xffffffff) throw new RangeError("u32 out of range"); const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v, true); this.parts.push(b); return this; }
  u64(v: bigint | number) { const n = BigInt(v); if (n < 0n || n > U64_MAX) throw new RangeError("u64 out of range"); const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, n, true); this.parts.push(b); return this; }
  i64(v: bigint | number) { const n = BigInt(v); if (n < I64_MIN || n > I64_MAX) throw new RangeError("i64 out of range"); const b = new Uint8Array(8); new DataView(b.buffer).setBigInt64(0, n, true); this.parts.push(b); return this; }
  /** Fixed-size byte array ([u8; N]). */
  fixed(bytes: Uint8Array, n: number) { if (bytes.length !== n) throw new RangeError(`expected ${n} bytes, got ${bytes.length}`); this.parts.push(bytes); return this; }
  pubkey(k: PublicKey | string) { return this.fixed(new PublicKey(k).toBytes(), 32); }
  /** Vec<u8> / bytes: u32 length prefix. */
  bytes(b: Uint8Array) { this.u32(b.length); this.parts.push(b); return this; }
  string(s: string) { return this.bytes(new TextEncoder().encode(s)); }
  option<T>(v: T | null | undefined, write: (w: BorshWriter, v: T) => void) { if (v === null || v === undefined) return this.u8(0); this.u8(1); write(this, v); return this; }
  vec<T>(items: readonly T[], write: (w: BorshWriter, v: T) => void) { this.u32(items.length); for (const it of items) write(this, it); return this; }
  raw(b: Uint8Array) { this.parts.push(b); return this; }
  bytesOut(): Uint8Array { const n = this.parts.reduce((a, p) => a + p.length, 0); const out = new Uint8Array(n); let o = 0; for (const p of this.parts) { out.set(p, o); o += p.length; } return out; }
}

/** Sequential Borsh reader; every read throws on truncated data. */
export class BorshReader {
  offset = 0;
  private view: DataView;
  constructor(readonly data: Uint8Array) { this.view = new DataView(data.buffer, data.byteOffset, data.byteLength); }
  get remaining() { return this.data.length - this.offset; }
  private need(n: number) { if (this.offset + n > this.data.length) throw new RangeError("borsh: truncated data"); }
  u8() { this.need(1); return this.data[this.offset++]; }
  bool() { const v = this.u8(); if (v > 1) throw new RangeError("borsh: bad bool"); return v === 1; }
  u16() { this.need(2); const v = this.view.getUint16(this.offset, true); this.offset += 2; return v; }
  u32() { this.need(4); const v = this.view.getUint32(this.offset, true); this.offset += 4; return v; }
  u64() { this.need(8); const v = this.view.getBigUint64(this.offset, true); this.offset += 8; return v; }
  i64() { this.need(8); const v = this.view.getBigInt64(this.offset, true); this.offset += 8; return v; }
  fixed(n: number) { this.need(n); const v = this.data.slice(this.offset, this.offset + n); this.offset += n; return v; }
  pubkey() { return new PublicKey(this.fixed(32)); }
  bytes() { const n = this.u32(); return this.fixed(n); }
  string() { return new TextDecoder().decode(this.bytes()); }
  option<T>(read: (r: BorshReader) => T): T | null { const tag = this.u8(); if (tag === 0) return null; if (tag !== 1) throw new RangeError("borsh: bad option tag"); return read(this); }
  vec<T>(read: (r: BorshReader) => T): T[] { const n = this.u32(); const out: T[] = []; for (let i = 0; i < n; i++) out.push(read(this)); return out; }
}

/** Instruction data: discriminator followed by the Borsh-encoded arguments `write` appends. */
export function encodeInstruction(name: string, write?: (w: BorshWriter) => void): Buffer {
  const w = new BorshWriter().raw(ixDiscriminator(name));
  write?.(w);
  return Buffer.from(w.bytesOut());
}

/** Strip and check an account discriminator; returns a reader over the fields, or null when the data is another type. */
export function openAccount(name: string, data: Uint8Array): BorshReader | null {
  if (data.length < 8 || !bytesEqual(data.subarray(0, 8), accountDiscriminator(name))) return null;
  return new BorshReader(data.subarray(8));
}

// ---- Transaction logs: which program said what ---------------------------------------------------------------------------
// A transaction's log is one list for every program it runs, so a `Program data:` line proves nothing about who wrote
// it: any program can log the bytes of another program's event (sol_log_data), and getSignaturesForAddress returns every
// transaction that merely names an address. The runtime itself brackets each invocation with
//   Program <id> invoke [<depth>]
//   Program <id> success            |   Program <id> failed: <reason>
// and prefixes everything a program writes with `Program log: ` (msg!) or `Program data: ` (sol_log_data), so a program
// cannot produce a line of the bracket forms. Walking the brackets as a stack gives the program that was executing when
// each data line was written; only that attribution is trusted.

const B58_ID = "[1-9A-HJ-NP-Za-km-z]{32,44}";
const INVOKE_RE = new RegExp(`^Program (${B58_ID}) invoke \\[(\\d{1,3})\\]$`);
const SUCCESS_RE = new RegExp(`^Program (${B58_ID}) success$`);
const FAILED_RE = new RegExp(`^Program (${B58_ID}) failed: `);
const DATA_RE = /^Program data: ([A-Za-z0-9+/=]+)$/;
/** The line the runtime writes in place of everything past its log size limit. */
export const LOG_TRUNCATED = "Log truncated";

export type AttributedData = { programId: string; depth: number; payload: Uint8Array };
export type ParsedProgramLogs = {
  /** `Program data:` payloads, each with the program on top of the invocation stack when it was written. */
  data: AttributedData[];
  /** The log hit the runtime's size limit: lines are missing, so nothing in it can be attributed. `data` is empty. */
  truncated: boolean;
  /** The invoke / success lines do not nest as the runtime writes them. `data` is empty. */
  malformed: boolean;
};

/**
 * Attribute every `Program data:` line of a transaction's log messages to the program that wrote it, by walking the
 * runtime's invoke / success / failed lines as a stack. Lines a program controls (`Program log:`, `Program data:`) are
 * never read as stack lines. A truncated or inconsistent log yields no data at all (and says so).
 */
export function parseProgramLogs(logs: readonly string[]): ParsedProgramLogs {
  const none = (flag: "truncated" | "malformed"): ParsedProgramLogs => ({ data: [], truncated: flag === "truncated", malformed: flag === "malformed" });
  if (logsTruncated(logs)) return none("truncated");
  const stack: string[] = [];
  const data: AttributedData[] = [];
  for (const line of logs) {
    if (typeof line !== "string") return none("malformed");
    if (line.startsWith("Program log: ")) continue; // program-controlled text: never a stack line, whatever it says
    if (line.startsWith("Program data: ")) {
      const m = DATA_RE.exec(line);
      if (!m || !stack.length) continue; // several fields, not base64, or written outside any invocation: not an event
      let payload: Uint8Array;
      try { payload = new Uint8Array(Buffer.from(m[1], "base64")); } catch { continue; }
      data.push({ programId: stack[stack.length - 1], depth: stack.length, payload });
      continue;
    }
    const invoke = INVOKE_RE.exec(line);
    if (invoke) {
      if (Number(invoke[2]) !== stack.length + 1) return none("malformed");
      stack.push(invoke[1]);
      continue;
    }
    const done = SUCCESS_RE.exec(line) ?? FAILED_RE.exec(line);
    if (done) {
      if (!stack.length || stack[stack.length - 1] !== done[1]) return none("malformed");
      stack.pop();
    }
    // Anything else (`Program <id> consumed ...`, `Program return: ...`, loader notes) carries no attribution.
  }
  return { data, truncated: false, malformed: false };
}

/** Whether a transaction's log was cut by the runtime (its events cannot be read from it). */
export const logsTruncated = (logs: readonly string[]) => logs.some((l) => typeof l === "string" && l.startsWith(LOG_TRUNCATED));

/**
 * The event payloads `programId` itself emitted in a transaction: `Program data:` lines written while that program was
 * on top of the invocation stack. Lines logged by any other program, including a program that called it or that it
 * called, are not returned; neither is anything from a truncated or malformed log.
 */
export function programEventPayloads(logs: readonly string[], programId: PublicKey | string): Uint8Array[] {
  const id = typeof programId === "string" ? programId : programId.toBase58();
  return parseProgramLogs(logs).data.filter((d) => d.programId === id).map((d) => d.payload);
}

/**
 * Anchor events appear in transaction logs as `Program data: <base64(discriminator || borsh fields)>`. Only the lines
 * `programId` itself wrote are returned (`programEventPayloads`): the program id is required, there is no "any program".
 */
export function eventPayloads(logs: readonly string[], programId: PublicKey | string): Uint8Array[] {
  return programEventPayloads(logs, programId);
}

/** Decode every `name` event among the payloads with `read`; payloads of other events are skipped. */
export function decodeEvents<T>(name: string, payloads: readonly Uint8Array[], read: (r: BorshReader) => T): T[] {
  const disc = eventDiscriminator(name);
  const out: T[] = [];
  for (const p of payloads) {
    if (p.length < 8 || !bytesEqual(p.subarray(0, 8), disc)) continue;
    try { out.push(read(new BorshReader(p.subarray(8)))); } catch { /* malformed: another program's data with a colliding prefix */ }
  }
  return out;
}

/** A 0x-hex or bare-hex 32-byte value as bytes. */
export function hex32(h: string): Uint8Array {
  const s = h.startsWith("0x") ? h.slice(2) : h;
  if (!/^[0-9a-fA-F]{64}$/.test(s)) throw new RangeError("expected a 32-byte hex value");
  return new Uint8Array(Buffer.from(s, "hex"));
}
export const toHex0x = (b: Uint8Array) => `0x${Buffer.from(b).toString("hex")}` as `0x${string}`;
export const u64le = (v: bigint | number) => new BorshWriter().u64(v).bytesOut();
