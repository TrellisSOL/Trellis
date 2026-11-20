import { z } from "zod";
import type { generations } from "../db/schema.ts";
import { fail } from "../lib/errors.ts";
import { picoToUsdString } from "../lib/money.ts";
import { csvCell } from "../agents/ledger.ts";

// Receipt export (update 15, src/features.json `receipt-export`): a caller's signed receipts for a date range, as JSON
// or CSV, paged. Each row carries what a later check needs without asking the router again for the row itself: the
// signed payload, its Ed25519 signature and the receipt key id (POST /api/v1/receipts/verify takes exactly those three),
// the v1 Merkle leaf, and the hour's anchor index once it is anchored (GET /api/v1/receipts/:id/proof gives the path).

/** Rows per page: at most this many, whatever `limit` asks. */
export const EXPORT_PAGE_MAX = 1000;
/** The longest range one export reads. */
export const EXPORT_RANGE_MAX_DAYS = 366;
const DAY = 86_400_000;

const instant = z.string().max(40).datetime({ offset: true });
const generationId = z.string().min(1).max(128).regex(/^[\w.:-]+$/);

export function exportQuery(q: Record<string, string>) {
  const parsed = z
    .object({
      from: instant,
      to: instant,
      format: z.enum(["json", "csv"]).default("json"),
      limit: z.coerce.number().int().min(1).max(EXPORT_PAGE_MAX).default(EXPORT_PAGE_MAX),
      cursor: generationId.optional(),
    })
    .safeParse(q);
  if (!parsed.success) fail(400, "Pass from and to as ISO 8601 times (for example 2026-11-01T00:00:00Z), format=json|csv, limit from 1 to 1000, and the cursor from the previous page if there is one.", "invalid_request");
  const v = parsed.data!;
  const from = new Date(v.from), to = new Date(v.to);
  if (from.getTime() >= to.getTime()) fail(400, "from must be before to.", "invalid_request");
  if (to.getTime() - from.getTime() > EXPORT_RANGE_MAX_DAYS * DAY) fail(400, `One export covers at most ${EXPORT_RANGE_MAX_DAYS} days. Split the range.`, "invalid_request");
  return { from, to, format: v.format, limit: v.limit, cursor: v.cursor };
}
export type ExportQuery = ReturnType<typeof exportQuery>;

type Generation = typeof generations.$inferSelect;

/** One exported receipt. `receipt` is the signed payload exactly as stored: re-encoding it changes nothing it signs. */
export function exportRow(g: Generation) {
  return {
    id: g.id,
    receipt_id: g.receiptId ?? g.id,
    created_at: g.ts.toISOString(),
    model: g.modelId,
    provider: g.providerId,
    cost_usd: picoToUsdString(g.cost),
    mode: g.mode,
    private: g.private,
    receipt_key_id: g.receiptKeyId,
    receipt_sig: g.receiptSig,
    receipt: g.receipt ?? null,
    receipt_leaf: g.receiptLeaf,
    receipt_v2_cose: g.receiptCose,
    anchor_index: g.anchorIndex,
    receipt_url: `/api/v1/receipts/${encodeURIComponent(g.id)}`,
  };
}
export type ExportRow = ReturnType<typeof exportRow>;

// The CSV keeps the signature as hex: a base64 signature can begin with "+", which spreadsheets read as a formula and
// the CSV guard would prefix. Hex never does (the v2 COSE bytes are hex in the CSV for the same reason). Buffer.from(hex, "hex").toString("base64") gives back the `sig` that
// POST /api/v1/receipts/verify takes. The payload is its JSON text, which begins with "{".
export const EXPORT_CSV_COLUMNS = ["id", "receipt_id", "created_at", "model", "provider", "cost_usd", "mode", "private", "receipt_key_id", "receipt_sig_hex", "receipt_payload", "receipt_leaf", "receipt_v2_cose_hex", "anchor_index", "receipt_url"] as const;

const sigHex = (b64: string | null) => (b64 ? Buffer.from(b64, "base64").toString("hex") : "");

export function exportCsv(rows: ExportRow[], header = true) {
  const line = (r: ExportRow) => {
    const cells: Record<(typeof EXPORT_CSV_COLUMNS)[number], unknown> = {
      ...r,
      receipt_sig_hex: sigHex(r.receipt_sig),
      receipt_payload: r.receipt == null ? "" : JSON.stringify(r.receipt),
      receipt_v2_cose_hex: r.receipt_v2_cose ? Buffer.from(r.receipt_v2_cose, "base64").toString("hex") : "",
    };
    return EXPORT_CSV_COLUMNS.map((c) => csvCell(cells[c])).join(",") + "\r\n";
  };
  return (header ? EXPORT_CSV_COLUMNS.join(",") + "\r\n" : "") + rows.map(line).join("");
}
