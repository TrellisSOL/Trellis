'use client';
import { LOCALES } from '../../lib/i18n/index.js';
import { setLocale, useLocale, useT } from '../../lib/i18n/use-locale.js';
import './i18n.css';

/** EN | 中文 in the header. Two toggle buttons; the pressed one is the page's language. Colours follow the bar. */
export default function LanguageSwitch({ className = '' }) {
  const locale = useLocale();
  const t = useT();
  return <div className={`lang-switch${className ? ' ' + className : ''}`} role="group" aria-label={t('lang.label')}>
    {LOCALES.map(option => <button key={option.id} type="button" lang={option.id} aria-label={option.name} title={option.name}
      aria-pressed={locale === option.id} onClick={() => setLocale(option.id)}>{option.short}</button>)}
  </div>;
}
