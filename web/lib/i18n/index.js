// Site languages. Strings live in one file per language (en.js, zh-Hans.js), nested by page or part.
// To translate another page: add its keys to en.js and zh-Hans.js, then read them with useT() (./use-locale.js).
// A key missing from a language falls back to English, then to the fallback the component passes, then to the key.
import en from './en.js';
import zhHans from './zh-Hans.js';

export const DEFAULT_LOCALE = 'en';
export const STORAGE_KEY = 'trellis-locale'; // localStorage; read before first paint by the inline script in app/layout.jsx
export const LOCALES = [
  { id: 'en', short: 'EN', name: 'English' },
  { id: 'zh-Hans', short: '中文', name: '简体中文' },
];
const DICTIONARIES = { en, 'zh-Hans': zhHans };

export const isLocale = value => Object.hasOwn(DICTIONARIES, value);

const lookup = (dictionary, key) => key.split('.').reduce((node, part) => (node == null ? undefined : node[part]), dictionary);
const fill = (value, vars) => (typeof value === 'string' && vars ? value.replace(/\{(\w+)\}/g, (match, name) => (name in vars ? String(vars[name]) : match)) : value);

/** translate(locale, key[, fallback][, vars]): the string (or array) for key, with {name} placeholders filled from vars. */
export function translate(locale, key, fallback, vars) {
  if (fallback && typeof fallback === 'object' && !Array.isArray(fallback)) { vars = fallback; fallback = undefined; }
  const value = lookup(DICTIONARIES[isLocale(locale) ? locale : DEFAULT_LOCALE], key) ?? lookup(en, key) ?? fallback ?? key;
  return fill(value, vars);
}
