'use client';

import { useEffect } from 'react';

// A reference can be linked directly, including on browsers that leave ancestor disclosures closed.
export default function ReferenceAnchors() {
  useEffect(() => {
    function reveal() {
      let id;
      try { id = decodeURIComponent(location.hash.slice(1)); } catch { return; }
      const target = document.getElementById(id);
      if (!target?.closest('.docs-body, [data-reference-groups]')) return;
      let group = target.closest('details');
      let changed = false;
      while (group) {
        if (!group.open) { group.open = true; changed = true; }
        group = group.parentElement?.closest('details');
      }
      if (changed) target.scrollIntoView({block: 'start'});
    }
    function sameHash(event) {
      const link = event.target.closest?.('a[href^="#"]');
      if (link && link.hash === location.hash) reveal();
    }
    reveal();
    window.addEventListener('hashchange', reveal);
    document.addEventListener('click', sameHash);
    return () => {
      window.removeEventListener('hashchange', reveal);
      document.removeEventListener('click', sameHash);
    };
  }, []);
  return null;
}
