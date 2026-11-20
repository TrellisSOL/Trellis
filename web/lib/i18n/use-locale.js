// The chosen language for this browser: one small store shared by every component, kept in localStorage.
// The server and the first client render always use English, so a static page hydrates without a mismatch; the
// stored choice takes over straight after (useSyncExternalStore), and the inline script in app/layout.jsx keeps the
// page hidden until then when the stored choice is not English.
import { useCallback, useSyncExternalStore } from 'react';
import { DEFAULT_LOCALE, STORAGE_KEY, isLocale, translate } from './index.js';

let current = null;
const listeners = new Set();

function stored() {
  try { const value = window.localStorage.getItem(STORAGE_KEY); return isLocale(value) ? value : DEFAULT_LOCALE; }
  catch { return DEFAULT_LOCALE; }
}
const getSnapshot = () => (current ??= stored());
const getServerSnapshot = () => DEFAULT_LOCALE;
const notify = () => listeners.forEach(listener => listener());
const onStorage = event => { if (event.key === STORAGE_KEY) { current = stored(); applyDocumentLocale(current); notify(); } };

function subscribe(listener) {
  listeners.add(listener);
  if (listeners.size === 1) window.addEventListener('storage', onStorage); // another tab changed the language
  return () => { listeners.delete(listener); if (!listeners.size) window.removeEventListener('storage', onStorage); };
}

/** Sets <html lang> and marks the parts of the page that are not translated yet as English. */
export function applyDocumentLocale(locale) {
  const root = document.documentElement;
  root.lang = locale;
  root.dataset.locale = locale;
  for (const main of document.querySelectorAll('main:not([data-i18n])')) {
    if (locale === DEFAULT_LOCALE) main.removeAttribute('lang'); else main.setAttribute('lang', DEFAULT_LOCALE);
  }
}

export function setLocale(locale) {
  if (!isLocale(locale)) return;
  current = locale;
  try { window.localStorage.setItem(STORAGE_KEY, locale); } catch { /* private mode or storage off: the choice lasts for this page only */ }
  applyDocumentLocale(locale);
  notify();
}

/** The stored choice, which can differ from useLocale() while a static page is still hydrating. */
export const currentLocale = getSnapshot;

export const useLocale = () => useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

/** t(key[, fallback][, vars]) in the current language. */
export function useT() {
  const locale = useLocale();
  return useCallback((key, fallback, vars) => translate(locale, key, fallback, vars), [locale]);
}
