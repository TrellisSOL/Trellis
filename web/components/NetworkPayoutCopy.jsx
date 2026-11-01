'use client';
import { useEffect, useState } from 'react';
import { payoutStatus } from '../lib/network-payouts';
export default function NetworkPayoutCopy({ closed = 'Payouts to network hosts aren’t switched on yet. The plan is USDC per token served, from signed receipts. No amounts are promised.' }) {
  const [status, setStatus] = useState({ open: false, feeBps: 0 });
  useEffect(() => { let active = true; payoutStatus().then(s => { if (active) setStatus(s); }); return () => { active = false; }; }, []);
  return <span>{status.open ? `Paid per token served, from receipts in confirmed per-host roots. Weekly USDC payouts at the host’s full price${status.feeBps > 0 ? `, less a ${status.feeBps / 100}% network fee` : ''}.` : closed}</span>;
}
