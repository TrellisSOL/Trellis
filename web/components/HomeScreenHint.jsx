'use client';
// "Add Trellis to your Home Screen" for iPhone visitors (lib/home-hint.js decides when). Styles live in app/mobile.css.
import { useEffect, useState } from 'react';
import { isIOS, isInstalled } from '../lib/harness-pwa.js';
import { HINT_DELAY_MS, HINT_KEY, shouldHint } from '../lib/home-hint.js';

const ShareGlyph = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 3v12M8 7l4-4 4 4" /><path d="M6 11H5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1h-1" />
  </svg>
);

export default function HomeScreenHint() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let dismissedAt = null;
    try { dismissedAt = localStorage.getItem(HINT_KEY); } catch { /* private mode: show it, it closes for this visit */ }
    if (!shouldHint({ ios: isIOS(navigator), installed: isInstalled(navigator, matchMedia), path: location.pathname, dismissedAt })) return;
    const t = setTimeout(() => setOpen(true), HINT_DELAY_MS);
    return () => clearTimeout(t);
  }, []);
  if (!open) return null;
  const close = () => { setOpen(false); try { localStorage.setItem(HINT_KEY, String(Date.now())); } catch { /* ignore */ } };
  return (
    <aside className="home-hint" aria-label="Add Trellis to your Home Screen">
      <img src="/pwa/apple-touch-icon.png" alt="" width="48" height="48" />
      <div>
        <b>Put Trellis on your Home Screen</b>
        <p>Tap <ShareGlyph />Share, then <strong>Add to Home Screen</strong>. It opens full screen, like an app.</p>
      </div>
      <button type="button" onClick={close} aria-label="Close">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
      </button>
    </aside>
  );
}
