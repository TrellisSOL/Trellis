// Receipt export (update 15, `receipt-export`): the dashboard reads GET /api/v1/generations/export page by page and
// saves one file. Pure (no React, no DOM): the component passes in the call and does the download.

export const EXPORT_PATH = '/api/v1/generations/export';
/** The router's limits: rows per page and days per export (src/receipts/export.ts). */
export const PAGE_ROWS = 1000;
export const MAX_DAYS = 366;
/** The browser stops after this many pages (200,000 receipts) and asks for a shorter range instead of filling memory. */
export const MAX_PAGES = 200;
const DAY = 86_400_000;

const DATE = /^\d{4}-\d{2}-\d{2}$/;
/** 'YYYY-MM-DD' of a Date, in the browser's own time zone. */
export const localDate = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/**
 * Two calendar days, as the reader picked them in their own time zone, to the router's range: from the start of the
 * first day to the start of the day after the last, both as UTC instants. `{ error }` when the days do not make one.
 */
export function exportRange(fromDay, toDay) {
  if (!DATE.test(fromDay || '') || !DATE.test(toDay || '')) return { error: 'Pick a first and a last day.' };
  const [fy, fm, fd] = fromDay.split('-').map(Number), [ty, tm, td] = toDay.split('-').map(Number);
  const from = new Date(fy, fm - 1, fd), to = new Date(ty, tm - 1, td + 1);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return { error: 'Pick a first and a last day.' };
  if (from >= to) return { error: 'The first day must not be after the last.' };
  if (to - from > MAX_DAYS * DAY) return { error: `One export covers at most ${MAX_DAYS} days. Pick a shorter range.` };
  return { from: from.toISOString(), to: to.toISOString() };
}

/** The file name the download is saved under. */
export const exportFileName = (fromDay, toDay, format) => `trellis-receipts-${fromDay}-to-${toDay}.${format === 'csv' ? 'csv' : 'json'}`;

/**
 * Every page of the export. `call(path, { raw, onResponse, signal })` is lib/api.js `api` with the key bound. Resolves
 * with { text, count, pages }: the file's contents and the number of receipts in it. CSV pages are joined as the router
 * sends them (its header line comes on the first page only); JSON pages are merged into one document.
 */
export async function readExport(call, { from, to, format = 'csv', signal, onPage } = {}) {
  const csv = format === 'csv';
  const parts = [], rows = [];
  let cursor = '', count = 0, pages = 0;
  for (;;) {
    if (pages >= MAX_PAGES) throw new Error(`More than ${(MAX_PAGES * PAGE_ROWS).toLocaleString('en-US')} receipts in this range. Pick a shorter range.`);
    const query = new URLSearchParams({ from, to, format, limit: String(PAGE_ROWS) });
    if (cursor) query.set('cursor', cursor);
    let next = null;
    const page = await call(`${EXPORT_PATH}?${query}`, { raw: csv, signal, onResponse: r => { next = r?.headers?.get?.('x-next-cursor') || null; } });
    pages++;
    if (csv) {
      const text = String(page || '');
      parts.push(text);
      count += text.split('\r\n').filter(Boolean).length - (pages === 1 ? 1 : 0);
    } else {
      rows.push(...(page?.data || []));
      next = page?.next || null;
      count = rows.length;
    }
    onPage?.({ pages, count });
    if (!next) break;
    cursor = next;
  }
  const text = csv ? parts.join('') : JSON.stringify({ from, to, receipts: rows, verify: 'POST /api/v1/receipts/verify with { payload: receipt, sig: receipt_sig, key_id: receipt_key_id }' }, null, 2);
  return { text, count: Math.max(0, count), pages };
}
