// Trellis identity as vectors: a lattice mark in two halves with a centre channel, and the wordmark set in the site's
// own typeface next to it. The mark keeps one coordinate space (MARK_VIEWBOX, centre 627,618) because the homepage
// route field draws the same two paths on its canvas.
export const LOGO_VIEWBOX='0 0 1749 372';
export const MARK_VIEWBOX='136 232 982 772';
import { MARK_LEFT, MARK_RIGHT } from '../lib/brand-mark.js';
export { MARK_LEFT, MARK_RIGHT };
// Each half: an outer post, a post beside the channel and two crossed slats between them. Every subpath winds the same
// way, so the crossing stays filled under the default fill rule in SVG and on canvas.
// The mark scaled to the wordmark's height (300 of 372 units) and moved to its left edge.
const WORDMARK_MARK='translate(-70.3 -104.6) scale(.46875)';
export function Wordmark({title='Trellis',...props}){return <svg viewBox={LOGO_VIEWBOX} fill="currentColor" role="img" aria-label={title} {...props}><g transform={WORDMARK_MARK}><path d={MARK_LEFT}/><path d={MARK_RIGHT}/></g><text x="520" y="300" textLength="1200" lengthAdjust="spacingAndGlyphs" style={{font:'700 330px var(--sans)',letterSpacing:'-.02em'}}>Trellis</text></svg>}
export function Mark({signal=false,title,...props}){return <svg viewBox={MARK_VIEWBOX} fill="currentColor" role={title?'img':undefined} aria-label={title} aria-hidden={title?undefined:true} {...props}><path className="mark-half mark-l" d={MARK_LEFT}/><path className="mark-half mark-r" d={MARK_RIGHT}/>{signal&&<rect className="mark-signal" x="620" y="300" width="14" height="120"/>}</svg>}
