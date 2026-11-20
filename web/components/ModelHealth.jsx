'use client';
import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { HEALTH_PATH, HEALTH_UPDATE, healthById } from '../lib/model-health.js';
import { useUpdate } from './media/useUpdate';

// Model health (update 17): the router's per-model figures for the last 24 hours, read only where the router's status
// lists the update as on. Returns null while it is off or not yet read, and a Map by model id once read.
export function useModelHealth(model) {
  const update = useUpdate(HEALTH_UPDATE);
  const on = update?.on === true;
  const [map, setMap] = useState(null);
  useEffect(() => {
    if (!on) return undefined;
    let live = true;
    api(HEALTH_PATH + (model ? '?model=' + encodeURIComponent(model) : '')).then(r => { if (live) setMap(healthById(r.data)); }).catch(() => { if (live) setMap(null); });
    return () => { live = false; };
  }, [on, model]);
  return on ? map : null;
}
