'use client';
import { useEffect } from 'react';
import { applyDocumentLocale, currentLocale, useLocale } from '../../lib/i18n/use-locale.js';
import './i18n.css';

// Mounted once in app/layout.jsx, on every page (Chat has no header, so the switch cannot do this). Applies the
// stored language to <html> and shows the page again once the translated text is in (see the inline script there).
export default function LocaleSync() {
  const locale = useLocale();
  useEffect(() => {
    if (locale !== currentLocale()) return; // hydration renders English first; the stored language follows at once
    applyDocumentLocale(locale); // the translated text is already committed, so the page can show
    document.documentElement.removeAttribute('data-locale-pending');
  }, [locale]);
  return null;
}
