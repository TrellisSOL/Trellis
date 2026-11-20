'use client';
import { useT } from '../../lib/i18n/use-locale.js';

export function openSiteSearch() {
  window.dispatchEvent(new Event('trellis:site-search'));
}

// The label is its own component so SearchButton stays a plain function of its props (tests call it directly).
function Label({ id }) { return useT()(id); }

// hint=false drops the ⌘K label (the Harness uses ⌘K to switch models); the button still opens search.
export default function SearchButton({ homepage = false, onOpen, hint = true }) {
  return <button type="button" className={homepage ? 'ar-button task-search' : 'site-search-button'} onClick={() => { onOpen?.(); openSiteSearch(); }} aria-haspopup="dialog" aria-controls="site-search">
    <span><Label id={homepage ? 'nav.searchEverything' : 'nav.search'}/></span>{!homepage && hint && <kbd aria-hidden="true">⌘K</kbd>}
  </button>;
}
