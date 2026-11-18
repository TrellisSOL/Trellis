import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { MARK_LEFT, MARK_RIGHT } from '../lib/brand-mark.js';
import { SPLASH_SCREENS } from '../lib/splash-screens.js';

// Home-screen icons and iPhone launch screens in the Night garden style: the lattice mark in amber on the night
// ground, with a soft glow. Run with `node scripts/pwa-icons.mjs`; the output is committed under public/pwa/.
// Reuse Next's installed image tooling; this script adds no package.
const require = createRequire(import.meta.url);
const sharp = createRequire(require.resolve('next/package.json'))('sharp');
const root = new URL('../', import.meta.url);
const NIGHT = '#09090b';
const VIEW = { x: 136, y: 232, w: 982, h: 772 }; // components/Logo.jsx MARK_VIEWBOX

/** An SVG of the mark, `markWidth` px wide, centred in a w×h night tile with an amber glow behind it. */
function art(w, h, markWidth, { glow = 0.55, tile = true } = {}) {
  const s = markWidth / VIEW.w, mh = VIEW.h * s;
  const x = (w - markWidth) / 2 - VIEW.x * s, y = (h - mh) / 2 - VIEW.y * s;
  const r = Math.max(markWidth * 1.15, 1);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <defs>
    <radialGradient id="ground" cx="50%" cy="38%" r="75%"><stop offset="0" stop-color="#17130e"/><stop offset=".6" stop-color="#0d0c0b"/><stop offset="1" stop-color="${NIGHT}"/></radialGradient>
    <radialGradient id="glow" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="#f2b66d" stop-opacity="${glow * 0.42}"/><stop offset="1" stop-color="#f2b66d" stop-opacity="0"/></radialGradient>
    <linearGradient id="amber" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f8cd92"/><stop offset="1" stop-color="#e59f4c"/></linearGradient>
  </defs>
  ${tile ? `<rect width="${w}" height="${h}" fill="url(#ground)"/>` : ''}
  <circle cx="${w / 2}" cy="${h / 2}" r="${r}" fill="url(#glow)"/>
  <g transform="translate(${x.toFixed(2)} ${y.toFixed(2)}) scale(${s.toFixed(5)})" fill="url(#amber)"><path d="${MARK_LEFT}"/><path d="${MARK_RIGHT}"/></g>
</svg>`;
}

const png = (svg) => sharp(Buffer.from(svg)).png({ compressionLevel: 9, palette: false });
const dir = new URL('public/pwa/', root);
const splashDir = new URL('public/pwa/splash/', root);
await fs.mkdir(splashDir, { recursive: true });

const icons = [];
for (const [size, purpose] of [[180, 'apple'], [192, 'any'], [512, 'any'], [192, 'maskable'], [512, 'maskable']]) {
  // iOS rounds the corners itself; maskable artwork stays inside the central 80% safe circle.
  const svg = art(size, size, Math.round(size * (purpose === 'maskable' ? 0.5 : 0.6)));
  const name = purpose === 'apple' ? 'apple-touch-icon.png' : `icon-${size}${purpose === 'maskable' ? '-maskable' : ''}.png`;
  await png(svg).toFile(fileURLToPath(new URL(name, dir)));
  if (purpose !== 'apple') icons.push({ src: `/pwa/${name}`, sizes: `${size}x${size}`, type: 'image/png', purpose });
}
for (const screen of SPLASH_SCREENS) {
  const w = screen.width * screen.ratio, h = screen.height * screen.ratio;
  await png(art(w, h, Math.round(w * 0.26), { glow: 0.45 })).toFile(fileURLToPath(new URL(screen.file, splashDir)));
}
await fs.writeFile(new URL('public/manifest.webmanifest', root), JSON.stringify({
  id: '/harness/', name: 'Trellis', short_name: 'Trellis', description: 'Install Trellis on your phone or desktop',
  start_url: '/harness/', scope: '/', display: 'standalone', orientation: 'any', background_color: NIGHT, theme_color: NIGHT, icons,
}, null, 2) + '\n');
console.log(`Wrote ${icons.length + 1} icons and ${SPLASH_SCREENS.length} launch screens.`);
