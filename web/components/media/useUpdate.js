'use client';
import { useEffect, useState } from 'react';
import { API_BASE } from '../../lib/api.js';

// The release switches of the router this site talks to (GET /api/v1/status, `updates`): which prepared updates it
// has released. Read once per page load and shared. `undefined` until the answer is in; `null` when the router
// reports no such update (an older router): a caller treats both as off.
let pending = null;
const load = () => (pending ??= fetch(API_BASE + '/api/v1/status').then(r => (r.ok ? r.json() : null)).then(d => d?.data?.updates || []).catch(() => []));

export function useUpdate(name) {
  const [update, setUpdate] = useState(undefined);
  useEffect(() => { let live = true; load().then(list => { if (live) setUpdate(list.find(u => u.name === name) || null); }); return () => { live = false; }; }, [name]);
  return update;
}
