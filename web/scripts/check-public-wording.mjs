import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// Shipped scripts must not carry the public wording lists the audits use.
export function auditShippedWordingLists(root) {
  const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(file) : [file];
  });
  const signatures = ['demo|test|tested|mock|simulated|placeholder', 'APY|returns|passive'];
  const scripts = walk(root).filter(file => /\.m?js$/.test(file));
  for (const file of scripts) {
    const source = fs.readFileSync(file, 'utf8');
    for (const signature of signatures) assert(!source.includes(signature), `Public wording list shipped in ${path.relative(root, file)}`);
  }
  console.log(`PASS: ${scripts.length} shipped scripts contain no public wording lists.`);
}
