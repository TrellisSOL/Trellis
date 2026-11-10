'use client';
import useRunway from './useRunway.js';
import { BalanceLink } from '../nav/AccountTrigger.js';
import { usePart } from '../launch/Surface';
import s from './Runway.module.css';
export default function RunwayBalance({ apiKey, snapshot, className }) {
  // Launch surface: the runway estimate is not part of core; a core router is not asked for it.
  const runway = useRunway(usePart('part', 'runway') ? apiKey : '');
  return <BalanceLink snapshot={{ ...snapshot, runway }} className={`${className} ${s.balance}`}/>;
}
