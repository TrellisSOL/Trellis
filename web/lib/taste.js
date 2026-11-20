// Taste test (update 20): Chat's compare mode with the model names, prices, costs and receipts hidden until you pick
// the better answer. Each round the lanes are shown in a new random order as Answer A, B, C; the pick reveals who wrote
// what and what each answer cost, and is counted in this browser only.
// Pure (no React): the shuffle, the letters, when a round is ready to judge, the result line and the tally.

export const TASTE_UPDATE = 'taste';
export const TASTE_TALLY_KEY = 'trellis-taste-tally';
export const LETTERS = ['A', 'B', 'C', 'D'];
export const TIE = 'tie';
const TALLY_MODELS = 60;

/** A new display order for the lanes (Fisher-Yates). `rand` returns [0, 1). */
export function shuffle(ids, rand = Math.random) {
  const out = [...ids];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Where a lane is shown (its CSS order) and its letter. A lane missing from the order goes last. */
export function slotOf(order, laneId, count = order.length) {
  const at = order.indexOf(laneId);
  return at < 0 ? count : at;
}
export const letterOf = (order, laneId) => LETTERS[slotOf(order, laneId)] || '?';
export const answerLabel = (order, laneId) => `Answer ${letterOf(order, laneId)}`;

/** Does the order still describe these lanes? A lane added or removed starts a new order. */
export const orderFits = (order, laneIds) => order.length === laneIds.length && laneIds.every(id => order.includes(id));

/** The lane's last answer, when the lane's last message is one. */
export const lastAnswer = lane => {
  const last = lane?.messages?.[lane.messages.length - 1];
  return last && last.role === 'assistant' ? last : null;
};

/** A round can be judged when every lane has a finished answer to the same last prompt and nothing is streaming. */
export function roundReady(lanes, busy) {
  if (busy || !Array.isArray(lanes) || lanes.length < 2) return false;
  return lanes.every(lane => { const m = lastAnswer(lane); return !!m && (m.status === 'done' || m.status === 'stopped') && !m.error; });
}

/** What a round is: the lanes, their models and each lane's last message. A new prompt, a regenerated answer or a
 * changed model is a new round, shown in a new order and judged afresh. */
export const roundKey = lanes => (lanes || []).map(l => `${l.id}:${l.modelId}:${l.messages?.[l.messages.length - 1]?.id ?? ''}`).join('|');

/**
 * After the pick: one line per lane in display order, "Answer B · Model name · $0.0012", and the verdict.
 * `cost` reads a message's charged cost (null while it is pending); `money` formats it.
 */
export function revealLines({ lanes, order, picked, nameOf, cost, money }) {
  const shown = [...lanes].sort((a, b) => slotOf(order, a.id) - slotOf(order, b.id));
  const lines = shown.map(lane => {
    const m = lastAnswer(lane);
    const c = m ? cost(m) : null;
    return { laneId: lane.id, letter: letterOf(order, lane.id), name: nameOf(lane.modelId), modelId: lane.modelId, cost: c === null || c === undefined ? 'cost pending' : money(c), picked: picked === lane.id };
  });
  const winner = lines.find(l => l.picked);
  const verdict = picked === TIE ? 'You called it even.' : winner ? `You picked Answer ${winner.letter}: ${winner.name}.` : '';
  return { lines, verdict };
}

// ---- the tally, in this browser only ------------------------------------------------------------------------------

/** Reads the tally: { [modelId]: { wins, rounds } }. Anything unreadable is an empty tally. */
export function readTally(storage) {
  try {
    const raw = JSON.parse(storage?.getItem(TASTE_TALLY_KEY) || '{}');
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out = {};
    for (const [id, v] of Object.entries(raw)) if (v && Number.isInteger(v.wins) && Number.isInteger(v.rounds) && v.wins >= 0 && v.rounds >= v.wins) out[id] = { wins: v.wins, rounds: v.rounds };
    return out;
  } catch { return {}; }
}

/** The tally after one pick: every model in the round gains a round, the picked one a win (a tie: no win). */
export function addPick(tally, modelIds, pickedModelId) {
  const next = { ...tally };
  for (const id of new Set(modelIds)) {
    const was = next[id] || { wins: 0, rounds: 0 };
    next[id] = { wins: was.wins + (id === pickedModelId ? 1 : 0), rounds: was.rounds + 1 };
  }
  // Keep the most-judged models only, so the stored tally stays small.
  return Object.fromEntries(Object.entries(next).sort((a, b) => b[1].rounds - a[1].rounds).slice(0, TALLY_MODELS));
}

export function saveTally(storage, tally) {
  try { storage?.setItem(TASTE_TALLY_KEY, JSON.stringify(tally)); return true; } catch { return false; }
}

/** "3 of 5 rounds won" for the models of this round, in display order. */
export const tallyLine = (tally, modelId) => { const t = tally[modelId]; return t ? `${t.wins} of ${t.rounds} ${t.rounds === 1 ? 'round' : 'rounds'} won here` : ''; };
