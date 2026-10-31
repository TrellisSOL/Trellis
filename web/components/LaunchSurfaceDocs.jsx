'use client';
// Launch-surface copy for the docs hub (lib/launch-surface.js holds the lists and the one shared status read).
//   <LaunchSurfaceDocs/>  the note at the top of the hub: a fixed sentence about the launch, then what THIS router
//                         reports under launch_surface in GET /api/v1/status, once the page has that answer.
//   <NotAtLaunch/>        one line under the heading of a section whose feature is written and not served at launch.
//                         On a router that reports the core surface the hub's own marker says so for that router
//                         (components/launch/Surface.jsx DocsSurfaceMarks), so this line steps aside there unless
//                         `always` is set (for a section that marker does not reach).
// Neither adds a section id: the hub's anchors and their classification stay as they are.
import { useLaunchSurface } from './launch/Surface';

const LAUNCH = 'A router at launch serves the core launch surface: chat, completions, embeddings, the model catalogue, API keys, prepaid credits, per-call payments, signed receipts and attestation records.';
const REST = 'Every other section stays here for reference and is marked “Built, not enabled at launch”: the feature is written, a router on the core surface answers its routes with 404 not_enabled, and it is switched on only after its own review.';
const BUILT = 'Built, not enabled at launch.';
const DEFAULT_LINE = 'A router on the core launch surface does not serve this. Where the text below says a feature is switched on, it describes a router that runs the full surface.';

/** Route groups a reader can recognise: the edge middleware and the static site are left out. */
const readable = groups => groups.filter(name => !/^(?:edge|site)\./.test(name));

function Reported({ state }) {
  if (!state.ready || state.unreachable) return null;
  if (state.surface === 'core') {
    const groups = readable(state.core);
    return <>
      {' '}This router reports the core surface{groups.length > 0 && <> and these route groups: {groups.join(', ')}</>}.
      {state.off.length > 0 && <> It lists as not enabled: {state.off.join(', ')}.</>}
    </>;
  }
  return <> This router reports the full surface: every feature whose own setting is on is registered, including features the launch leaves out.</>;
}

export default function LaunchSurfaceDocs() {
  const state = useLaunchSurface();
  return <p className="surface-mark" data-launch-note="">
    <strong>What this router has enabled.</strong> {LAUNCH} {REST}
    <Reported state={state}/>
  </p>;
}

export function NotAtLaunch({ always = false, children }) {
  const { surface } = useLaunchSurface();
  if (surface === 'core' && !always) return null;
  return <p className="surface-mark" data-not-at-launch=""><strong>{BUILT}</strong> {children || DEFAULT_LINE}</p>;
}
