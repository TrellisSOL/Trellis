// Chat export with receipts (update 21): one conversation from the Chat page, with the proof of every answer.
//
//   Markdown  the conversation, and under each answer its model, its cost and its receipt id, with a link that checks
//             the receipt on the verify page
//   JSON      the same conversation, every answer's signed receipt as the router keeps it, and the receipt keys that
//             were current when it was exported, so the file can be checked without asking the router again
//
// The receipts come from POST /api/v1/receipts/batch, at most 50 ids a call. Pure apart from the download itself.
import { isReceiptId, privacyHref } from './privacy.js';

export const BATCH_PATH = '/api/v1/receipts/batch';
export const MAX_BATCH = 50;
export const FORMAT = 'trellis-chat-receipts';
export const VERSION = 1;

/** The receipt ids of a conversation's answers, in order, each once. */
export function answerIds(chat) {
  const seen = new Set();
  for (const lane of chat?.lanes || []) for (const m of lane.messages || []) {
    if (m.role === 'assistant' && isReceiptId(m.receiptId)) seen.add(m.receiptId);
  }
  return [...seen];
}

/** Ask the router for the receipts, MAX_BATCH ids at a time. `post(path, body)` returns the parsed answer. */
export async function fetchReceipts(ids, post) {
  const receipts = {}, missing = [];
  let keys = null;
  for (let i = 0; i < ids.length; i += MAX_BATCH) {
    const { data } = await post(BATCH_PATH, { ids: ids.slice(i, i + MAX_BATCH) });
    for (const r of data?.receipts || []) receipts[r.id] = r;
    missing.push(...(data?.missing || []));
    keys = data?.keys ?? keys;
  }
  return { receipts, missing, keys };
}

/** A cost in dollars, as the answer reported it. */
export function costText(usage) {
  const cost = usage?.cost;
  if (typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0) return 'not recorded';
  return '$' + cost.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 12 });
}

const code = (value) => '`' + String(value).replace(/`/g, "'").replace(/[\r\n]+/g, ' ') + '`';
const heading = (value) => String(value).replace(/[\\`*_{}[\]()#+.!|>~-]/g, '\\$&').replace(/[\r\n]+/g, ' ');

/** The line under an answer: its model, its cost and its receipt. */
export function answerLine(m, bundle, origin = '') {
  const parts = [`Model: ${m.model ? code(m.model) : 'not recorded'}`, `Cost: ${costText(m.usage)}`];
  if (!m.receiptId) parts.push('Receipt: none');
  else if (bundle?.receipts?.[m.receiptId]) parts.push(`Receipt: ${code(m.receiptId)} ([check it](${origin}${privacyHref(m.receiptId)}))`);
  else parts.push(`Receipt: ${code(m.receiptId)} (not found on this router)`);
  return parts.join(' · ');
}

export function markdownWithReceipts(chat, bundle, { origin = '', now = new Date() } = {}) {
  const found = Object.keys(bundle?.receipts || {}).length;
  const lines = [`# ${heading(chat.title)}`, '', `Exported ${now.toISOString()} from ${origin || 'Trellis'}. ${found} signed receipt${found === 1 ? '' : 's'} found; the JSON export of this chat carries them in full.`, ''];
  chat.lanes.forEach((lane, i) => {
    if (chat.lanes.length > 1) lines.push(`## Conversation ${i + 1} · ${heading(lane.modelId || 'Model not recorded')}`, '');
    for (const m of lane.messages) {
      lines.push(`### ${m.role === 'user' ? 'You' : 'Assistant'}`, '', m.text, '');
      if (m.role === 'user' && m.files?.length) lines.push(`Attachment names: ${m.files.map(code).join(', ')}`, '');
      if (m.role === 'assistant') lines.push(answerLine(m, bundle, origin), '');
    }
  });
  return lines.join('\n');
}

export function jsonWithReceipts(chat, bundle, { origin = '', now = new Date() } = {}) {
  const lanes = chat.lanes.map((lane) => ({
    model_id: lane.modelId,
    messages: lane.messages.map((m) => m.role === 'user'
      ? { role: 'user', text: m.text, ...(m.files?.length ? { attachment_names: m.files } : {}) }
      : { role: 'assistant', text: m.text, model: m.model ?? null, cost_usd: typeof m.usage?.cost === 'number' ? m.usage.cost : null, receipt_id: m.receiptId ?? null, receipt: (m.receiptId && bundle?.receipts?.[m.receiptId]) || null }),
  }));
  return JSON.stringify({ format: FORMAT, version: VERSION, exported_at: now.toISOString(), router: origin || null, title: chat.title, lanes, missing_receipts: bundle?.missing || [], receipt_keys: bundle?.keys ?? null }, null, 2) + '\n';
}

export function downloadText(name, text, type, scope = globalThis) {
  const url = scope.URL.createObjectURL(new Blob([text], { type }));
  const link = scope.document.createElement('a');
  link.href = url;
  link.download = name;
  scope.document.body.append(link);
  try { link.click(); } finally { link.remove(); scope.setTimeout(() => scope.URL.revokeObjectURL(url), 1000); }
}
