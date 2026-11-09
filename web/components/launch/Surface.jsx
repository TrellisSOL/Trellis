'use client';
// The launch surface in the page (lib/launch-surface.js holds the allow-list and the one shared status read).
//   useLaunchSurface()  { surface: 'unknown' | 'core' | 'all', ready, core, off }
//   usePart(kind, id)   true once a part may be shown and its routes called: always for core, else only after the router said `all`
//   <NotEnabled/>       the one notice: "Not enabled on this router" and one sentence
//   <SurfaceGate/>      around a non-core page: static content until the router answers, then the page or the notice
//   <SurfacePart/>      around a non-core part of a core page that is rendered in the browser
//   <Problem/>          an error as text, or the notice when the text is the notice
//   <DocsSurfaceMarks/> marks the non-core sections of the docs hub, which stays readable
//   <SurfaceNote/>      a marker shown only in core (the stylesheet hides it otherwise)
import { useEffect, useSyncExternalStore } from 'react';
import { CORE, DOCS_NOTES, EXTRA, NOT_ENABLED_MESSAGE, NOT_ENABLED_TEXT, NOT_ENABLED_TITLE, gateView, getLaunchSurface, isNotEnabledText, loadLaunchSurface, serverLaunchSurface, subscribeLaunchSurface } from '../../lib/launch-surface.js';

export function useLaunchSurface() {
  const state = useSyncExternalStore(subscribeLaunchSurface, getLaunchSurface, serverLaunchSurface);
  useEffect(() => { loadLaunchSurface(); }, []);
  return state;
}
export function usePart(kind, id) {
  return gateView(!!CORE[kind]?.includes(id), useLaunchSurface()) === 'show';
}

/** `page`: the notice as a whole page body. `detail`: the router's own sentence, when it gave one. `off`: names to list (default: the router's). */
export default function NotEnabled({ page = false, detail = '', off }) {
  const state = useLaunchSurface();
  const listed = off ?? state.off;
  const more = <>
    {detail && <p className="help-text">{detail}</p>}
    {listed.length > 0 && <details className="not-enabled-list"><summary>What this router lists as not enabled</summary><p>{listed.join(', ')}</p></details>}
  </>;
  if (page) return <main className="page-main not-enabled-page" id="content">
    <div className="page-title" role="status"><span className="eyebrow">Launch surface / Core</span><h1>{NOT_ENABLED_TITLE}</h1><p>{NOT_ENABLED_TEXT}</p></div>
    {more}
    <p><a className="inline-link" href="/dashboard/">Open your account</a> · <a className="inline-link" href="/docs/">Read the docs</a></p>
  </main>;
  return <section className="not-enabled" role="status"><h2>{NOT_ENABLED_TITLE}</h2><p>{NOT_ENABLED_TEXT}</p>{more}</section>;
}

/** An error kept as text. The notice text (lib/api.js gives it to every 404 not_enabled) renders as the notice, not as an error. */
export function Problem({ text, className = 'error' }) {
  if (!text) return null;
  if (isNotEnabledText(text)) return <NotEnabled detail={text.slice(NOT_ENABLED_MESSAGE.length).trim()}/>;
  return <div className={className} role="alert">{text}</div>;
}

/** A part of a core page, rendered in the browser. Nothing until the router answers; in core nothing, or the notice with `notice`. */
export function SurfacePart({ kind, id, notice = false, children }) {
  const view = gateView(!!CORE[kind]?.includes(id), useLaunchSurface());
  return view === 'show' ? children : view === 'notice' && notice ? <NotEnabled/> : null;
}

/**
 * Around a page that is not on the core page list. The static export still carries the page (links, anchors and
 * readers without scripts keep working). In the browser, until the router has answered, that markup is left exactly as
 * it was served and none of it runs: it is not hydrated, so it makes no API call, and the stylesheet keeps it out of
 * sight. On the full surface the page is then rendered and runs as before; in core it is replaced by the notice.
 */
export function SurfaceGate({ page, children }) {
  const view = gateView(CORE.page.includes(page), useLaunchSurface());
  if (view === 'notice') return <NotEnabled page/>;
  if (view === 'show' || typeof window === 'undefined') return <div className="surface-gate" data-surface-gate={view === 'show' ? 'open' : 'pending'}>{children}</div>;
  // An element that sets its own HTML is not descended into, so the served markup stays and its components do not start.
  return <div className="surface-gate" data-surface-gate="pending" suppressHydrationWarning dangerouslySetInnerHTML={{ __html: '' }}/>;
}

/** A marker that only a core router shows. Plain markup: the stylesheet does the hiding. */
export function SurfaceNote({ title = NOT_ENABLED_TITLE, children }) {
  return <p className="surface-mark" data-surface-core=""><strong>{title}.</strong> {children}</p>;
}

/**
 * The docs hub stays fully readable. In core every section that is not on the core docs list (and the listed
 * sub-headings) gets a short marker under its heading, and its link in the side list is greyed. The sections are
 * static markup, so the markers are added to the document after it loads and removed again if the surface changes.
 */
export function DocsSurfaceMarks() {
  const { surface } = useLaunchSurface();
  useEffect(() => {
    if (surface !== 'core') return;
    const body = document.querySelector('.docs-body');
    if (!body) return;
    const undo = [], off = new Set();
    const mark = (id, place) => {
      const note = document.createElement('p');
      note.className = 'surface-mark';
      const strong = document.createElement('strong');
      strong.textContent = (DOCS_NOTES[id] ? 'Partly enabled on this router.' : NOT_ENABLED_TITLE + '.');
      note.append(strong, ' ' + (DOCS_NOTES[id] || 'This section describes a feature outside the core launch surface.'));
      place(note); off.add(id); undo.push(() => note.remove());
    };
    // Default-deny: a section nobody classified is marked too.
    for (const element of body.querySelectorAll('section[id], h2[id]')) {
      if (CORE.docs.includes(element.id)) continue;
      const heading = element.matches('h2') ? element : element.querySelector('h2, h3');
      mark(element.id, note => (heading ? heading.after(note) : element.prepend(note)));
    }
    for (const id of EXTRA.docs) {
      const element = off.has(id) ? null : body.querySelector('#' + CSS.escape(id));
      if (element) mark(id, note => (/^H[1-6]$/.test(element.tagName) ? element.after(note) : element.before(note)));
    }
    for (const link of document.querySelectorAll('.side-nav a[href^="#"]')) {
      if (!off.has(link.getAttribute('href').slice(1)) || DOCS_NOTES[link.getAttribute('href').slice(1)]) continue;
      link.dataset.surfaceOff = ''; link.title = NOT_ENABLED_TITLE;
      undo.push(() => { delete link.dataset.surfaceOff; link.removeAttribute('title'); });
    }
    return () => undo.forEach(fn => fn());
  }, [surface]);
  return null;
}
