// Writes the site's copy of the router's core route table: lib/core-routes.generated.json, a JSON list of the lines of
// security/launch-surface/core-routes.txt ("<group>\t<METHOD> <path>", comments left out). lib/launch-surface.js derives
// which pages and account sections are core from it; tests/launch-surface.test.mjs (and the router's own
// test/security-r5-12-surface.test.ts) fail while the copy differs from the router's file.
//
//   node scripts/gen-core-routes.mjs                 write lib/core-routes.generated.json
//   node scripts/gen-core-routes.mjs --check         exit 1 when the committed copy is not the router's table
//   node scripts/gen-core-routes.mjs --out <file>    write (or check) another file
import fs from 'node:fs';
import path from 'node:path';

const web = path.resolve(import.meta.dirname, '..');
const source = path.join(web, '../security/launch-surface/core-routes.txt');
const args = process.argv.slice(2);
const at = args.indexOf('--out');
const out = at >= 0 ? path.resolve(args[at + 1] ?? '') : path.join(web, 'lib/core-routes.generated.json');

const lines = fs.readFileSync(source, 'utf8').split('\n').filter(line => line && !line.startsWith('#'));
if (!lines.length || lines.some(line => !/^[a-z0-9.-]+\t[A-Z]+ \/\S*$/.test(line))) {
  console.error('security/launch-surface/core-routes.txt is empty or has a line that is not "<group>\\t<METHOD> <path>".');
  process.exit(1);
}
const json = JSON.stringify(lines, null, 2) + '\n';
if (args.includes('--check')) {
  let current = null;
  try { current = fs.readFileSync(out, 'utf8'); } catch { /* missing */ }
  if (current !== json) {
    console.error(`${path.relative(web, out)} is not the router's core route table. Run: node scripts/gen-core-routes.mjs`);
    process.exit(1);
  }
} else fs.writeFileSync(out, json);
