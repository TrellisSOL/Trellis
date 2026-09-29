import { PublicKey } from "@solana/web3.js";
import { hostIdOf, slashAmount } from "../solana/programs/bond.ts";

// The host-bond projection: a journal of trellis_bond events (src/solana/programs/bond.ts `bondEvents`) folded into
// hosts, slash proposals and parameters. Hosts are keyed by `hostId`, the 0x-hex of the host's wallet (the on-chain
// bond is per wallet); `operator` is that wallet in base58, compared byte for byte (base58 is case-sensitive). Proposals
// are keyed by their on-chain address. No provider data is mutated, so orphaned logs are fully reversible.

/** The projection id of a host wallet (base58): the hex of its 32 bytes. */
export const bondHostId = (operator: string) => hostIdOf(new PublicKey(operator));
/** The wallet a projection id names. */
export const bondHostWallet = (hostId: string) => new PublicKey(Buffer.from(hostId.replace(/^0x/, ""), "hex"));
export const bondScope = (cfg: { chain: { id: number }; hostBonds: { address?: string } }) => `${cfg.chain.id}:${cfg.hostBonds.address}`;
export type BondHost = { operator: string; bond: string; unbond: string; availableAt: string | null; delisted: boolean };
export type DisputeState = "none" | "open" | "upheld" | "rejected";
export type BondSlash = { hostId: string; bond: string; amount: string; reason: number; bps: number; evidenceRoot: string; executableAt: string; disputeStatus: DisputeState; disputedAt: string | null; status: "pending" | "executed" | "rejected"; transactions: { event: string; hash: string }[] };
export type BondParameters = { minBond: string; slasher?: string; owner?: string; guardian?: string; paused?: boolean };
/** Which host a bond account belongs to (proposal events name the bond, not the host). */
export type BondRef = { hostId: string };
export type BondEvent = { event: string; args: Record<string, unknown>; txHash: string };
export type BondState = Map<string, BondHost | BondSlash | BondParameters | BondRef>;
export const DEFAULT_MIN_BOND = "10000000000";
export const emptyHost = (): BondHost => ({ operator: "", bond: "0", unbond: "0", availableAt: null, delisted: false });
export const parameters = (state: BondState): BondParameters => state.get("parameters:current") as BondParameters ?? { minBond: DEFAULT_MIN_BOND };
/** Journal projection; returns the keys it changed. */
export function applyBondEvent(state: BondState, e: BondEvent): string[] {
  const a = e.args;
  const changes = new Set<string>();
  const put = (key: string, data: BondHost | BondSlash | BondParameters | BondRef) => { state.set(key, data); changes.add(key); };
  const p = structuredClone(parameters(state));
  const bondKey = typeof a.bond === "string" ? `bond:${a.bond}` : null;
  const hostIdOfEvent = () => {
    if (typeof a.hostId === "string") return a.hostId.toLowerCase();
    const ref = bondKey ? (state.get(bondKey) as BondRef | undefined) : undefined;
    if (!ref) throw new Error("HostBond slash journal is incomplete; check HOST_BOND_START_BLOCK.");
    return ref.hostId;
  };
  switch (e.event) {
    case "Bonded": {
      const hostId = String(a.hostId).toLowerCase();
      const h = structuredClone(state.get(`host:${hostId}`) as BondHost ?? emptyHost());
      h.operator = String(a.operator); h.bond = String(a.total); put(`host:${hostId}`, h);
      if (bondKey) put(bondKey, { hostId });
      break;
    }
    case "UnbondRequested": case "UnbondCancelled": case "Unbonded": {
      const hostId = hostIdOfEvent();
      const h = structuredClone(state.get(`host:${hostId}`) as BondHost ?? emptyHost());
      if (e.event === "UnbondRequested") { h.unbond = typeof a.amount === "string" ? a.amount : h.bond; h.availableAt = String(a.availableAt); }
      if (e.event === "UnbondCancelled") { h.unbond = "0"; h.availableAt = null; }
      if (e.event === "Unbonded") { h.bond = (BigInt(h.bond) - BigInt(String(a.amount))).toString(); h.unbond = "0"; h.availableAt = null; }
      put(`host:${hostId}`, h);
      break;
    }
    case "SlashProposed": {
      const hostId = hostIdOfEvent();
      const h = state.get(`host:${hostId}`) as BondHost | undefined;
      const bps = Number(a.bps ?? 0);
      const fixed = BigInt(String(a.fixedAmount ?? "0"));
      const amount = fixed > 0n ? fixed : slashAmount(BigInt(h?.bond ?? "0"), bps);
      put(`slash:${a.slashId}`, { hostId, bond: String(a.bond), amount: amount.toString(), reason: Number(a.reason), bps, evidenceRoot: String(a.evidenceRoot).toLowerCase(), executableAt: String(a.executableAt), disputeStatus: "none", disputedAt: null, status: "pending", transactions: [{ event: e.event, hash: e.txHash }] });
      break;
    }
    case "SlashDisputed": case "DisputeResolved": case "SlashExecuted": case "ProposalClosed": {
      const s = structuredClone(state.get(`slash:${a.slashId}`) as BondSlash | undefined);
      if (!s) throw new Error("HostBond slash journal is incomplete; check HOST_BOND_START_BLOCK.");
      if (e.event === "SlashDisputed") { s.disputeStatus = "open"; s.disputedAt = String(a.disputedAt); }
      if (e.event === "DisputeResolved") { s.disputeStatus = a.status === "Upheld" ? "upheld" : "rejected"; if (a.status === "Rejected") s.status = "rejected"; }
      if (e.event === "SlashExecuted") {
        s.status = "executed"; s.amount = String(a.amount);
        const h = structuredClone(state.get(`host:${s.hostId}`) as BondHost ?? emptyHost());
        h.bond = typeof a.remainingBond === "string" ? a.remainingBond : (BigInt(h.bond) - BigInt(String(a.amount))).toString();
        h.delisted ||= a.delisted === true;
        put(`host:${s.hostId}`, h);
      }
      s.transactions.push({ event: e.event, hash: e.txHash }); put(`slash:${a.slashId}`, s); break;
    }
    case "BondConfigUpdated": p.minBond = String(a.minBond); p.slasher = String(a.slasher); p.owner = String(a.authority); p.guardian = String(a.guardian); put("parameters:current", p); break;
    case "BondPauseChanged": p.paused = a.paused === true; put("parameters:current", p); break;
    default: throw new Error("Unknown trellis_bond event; the IDL must match the configured program.");
  }
  return [...changes];
}
export function activeBond(h: BondHost) { return BigInt(h.bond) > BigInt(h.unbond) ? BigInt(h.bond) - BigInt(h.unbond) : 0n; }
