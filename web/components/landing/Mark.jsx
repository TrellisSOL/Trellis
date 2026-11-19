// The woven Trellis mark from the brand art: three slats each way, turned 45°, passing over and under in turn.
// A slat that passes under is cut around the slat on top, so the weave reads at any size and on any ground.
const W = .44, GAP = .12, END = 1.72, AT = [-1, 0, 1];

function segments(under) {
  const out = []; let start = -END;
  for (const t of under) { const end = t - (W + GAP); if (end > start) out.push([start, end]); start = t + (W + GAP); }
  if (END > start) out.push([start, END]);
  return out;
}

const SLATS = [];
AT.forEach((p, i) => {
  // Slat i along x: on top where (i + j) is even. Slat j along y: on top where (i + j) is odd.
  for (const [a, b] of segments(AT.filter((_, j) => (i + j) % 2))) SLATS.push([a, p, b, p]);
  for (const [a, b] of segments(AT.filter((_, j) => (i + j) % 2 === 0))) SLATS.push([p, a, p, b]);
});

export function WovenMark({ title, className, ...props }) {
  return <svg viewBox="-2.3 -2.3 4.6 4.6" className={className} role={title ? 'img' : undefined} aria-label={title} aria-hidden={title ? undefined : true} focusable="false" {...props}>
    <g transform="rotate(45)" stroke="currentColor" strokeWidth={W} strokeLinecap="round" fill="none">
      {SLATS.map(([x1, y1, x2, y2], k) => <line key={k} x1={x1} y1={y1} x2={x2} y2={y2}/>)}
    </g>
  </svg>;
}

/** The lockup: the woven mark and TRELLIS in wide caps, as in the brand art. */
export function Lockup({ className, markClass, wordClass }) {
  return <span className={className}><WovenMark className={markClass}/><span className={wordClass}>Trellis</span></span>;
}

export function Arrow({ className }) {
  return <svg viewBox="0 0 16 16" className={className} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d="M3 8H13M9 4L13 8L9 12"/></svg>;
}
