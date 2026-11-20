'use client';
import { useEffect, useState } from 'react';
import { TIE, addPick, lastAnswer, letterOf, readTally, revealLines, roundReady, saveTally, slotOf, tallyLine } from '../../lib/taste.js';
import t from './TasteTest.module.css';

// Taste test (update 20): the bar under Chat's compare lanes. Before the pick it asks which answer is better, with the
// lanes named Answer A, B, C only; the pick reveals each model and what its answer cost (the receipts show again on the
// replies), and is counted in this browser's tally. Harness.jsx hides names, prices, costs and receipts meanwhile.
const store = () => { try { return window.localStorage; } catch { return null; } };

export default function TasteTest({ lanes, order, picked, busy, onPick, nameOf, cost, money }) {
  const [tally, setTally] = useState({});
  useEffect(() => setTally(readTally(store())), []);
  const ready = roundReady(lanes, busy);
  if (!ready && !picked) return <p className={t.bar} role="status">Taste test: the names, prices and receipts stay hidden until you pick the better answer.</p>;
  if (!picked) {
    const shown = [...lanes].sort((a, b) => slotOf(order, a.id) - slotOf(order, b.id));
    const pick = id => {
      const winner = id === TIE ? null : lanes.find(l => l.id === id)?.modelId;
      const next = addPick(readTally(store()), lanes.map(l => l.modelId), winner);
      saveTally(store(), next);
      setTally(next);
      onPick(id);
    };
    return <div className={t.bar} role="group" aria-label="Which answer is better?">
      <span className={t.ask}>Which answer is better?</span>
      {shown.map(l => <button key={l.id} type="button" className={t.pick} onClick={() => pick(l.id)} disabled={!lastAnswer(l)}>Answer {letterOf(order, l.id)}</button>)}
      <button type="button" className={t.even} onClick={() => pick(TIE)}>About the same</button>
    </div>;
  }
  const { lines, verdict } = revealLines({ lanes, order, picked, nameOf, cost, money });
  return <div className={t.bar} role="status" aria-live="polite">
    <span className={t.ask}>{verdict}</span>
    <ul className={t.reveal}>{lines.map(l => <li key={l.laneId} data-picked={l.picked || undefined}>
      <b>Answer {l.letter}</b><span>{l.name}</span><span className={t.cost}>{l.cost}</span>{tallyLine(tally, l.modelId) && <small>{tallyLine(tally, l.modelId)}</small>}
    </li>)}</ul>
    <small className={t.note}>Send the next prompt for a new round, in a new order. The tally is kept in this browser only.</small>
  </div>;
}
