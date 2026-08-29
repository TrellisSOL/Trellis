// One command that replaces the placeholder names of this repository with the real ones.
//
//   bun scripts/rename-placeholders.ts --dry-run                       how many of each placeholder the tree holds now, and where
//   bun scripts/rename-placeholders.ts --domain <d> --org <o> --handle <h> --support <address> --dry-run   what a run would change
//   bun scripts/rename-placeholders.ts --domain <d> --org <o> --handle <h> --support <address>             do it
//
// Every placeholder the repository uses is listed once, in PLACEHOLDERS below; nothing else in the tree knows them.
//
//   placeholder                      flag               replaced with
//   support@trellis.example          --support          the support address
//   trellis.example                  --domain           the domain (sub-domains such as relay.trellis.example follow it; the
//                                                       regex-escaped form trellis\.example is replaced in its escaped form)
//   ghcr.io/<org>                    --image-registry   the container image path prefix (default ghcr.io/<--org>)
//   example.com/trellis/sdk-go       --go-module        the Go module path (default github.com/<--org>/<--repo>/sdks/go)
//   example-org, trellis-org         --org              the GitHub organisation (fixture names such as example-org/example-model are left alone)
//   <org>/trellis, <org>/Trellis     --repo             the repository name, only when --repo is given
//   TrellisHQ                        --handle           the social handle (a leading @ in the flag value is dropped)
//
// Any subset of flags works: only the placeholders whose flag is given are replaced. Options:
//   --dry-run          print the counts and change nothing
//   --exclude <path>   leave a path prefix alone (repeatable), e.g. --exclude test
//   --from-domain, --from-support, --from-org, --from-handle, --from-image-registry, --from-go-module
//                      rename again later: the current value to replace, instead of the placeholder
//
// It reads the files git knows about (tracked, plus untracked files that are not ignored), skips binary files, the
// lockfiles and itself, and rewrites in place. Idempotent: a second run with the same values finds nothing to change.
// Values are only checked for being well formed (a host name, an address with one @, a handle, an organisation name);
// what you name things is your decision. Nothing is sent anywhere.
//
// After a real run: review `git diff --stat`, then run the suites (bun run typecheck, bun test, web: pnpm test and
// pnpm build). `.example` is a reserved top-level domain, and src/config.ts lets a production router on a reserved
// domain start without a deployment manifest; on a real domain it requires one (MAINNET.md, "Names and placeholders").
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

// TRELLIS_ROOT points the script at another checkout (used to try a rename on a copy).
const ROOT = process.env.TRELLIS_ROOT ? resolve(process.env.TRELLIS_ROOT) : resolve(import.meta.dir, "..");
const SELF = "scripts/rename-placeholders.ts";
/** Files a rename never touches: lockfiles are generated, and this file must keep the placeholder list. */
const SKIP = [SELF, "bun.lock", "Cargo.lock", "pnpm-lock.yaml", "go.sum"];
const SKIP_DIRS = [".git/", ".claude/", "node_modules/", "target/", ".data/"];

// ---- The placeholders ------------------------------------------------------------------------------------------------------
const PLACEHOLDERS = {
  support: "support@trellis.example",
  domain: "trellis.example",
  imageRegistry: "ghcr.io/<org>",
  goModule: "example.com/trellis/sdk-go",
  orgs: ["example-org", "trellis-org"],
  handle: "TrellisHQ",
  repo: "trellis",
} as const;

// ---- Arguments -------------------------------------------------------------------------------------------------------------
const VALUED = ["--domain", "--org", "--handle", "--support", "--image-registry", "--go-module", "--repo", "--exclude", "--from-domain", "--from-support", "--from-org", "--from-handle", "--from-image-registry", "--from-go-module"];
const opts = new Map<string, string>();
const excludes: string[] = [];
let dryRun = false;
const argv = process.argv.slice(2);
const die = (m: string): never => { console.error(m); process.exit(2); };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]!;
  if (a === "--dry-run") dryRun = true;
  else if (a === "--help" || a === "-h") { console.log(readFileSync(join(import.meta.dir, "rename-placeholders.ts"), "utf8").split("\n").filter((l) => l.startsWith("//")).map((l) => l.slice(3)).join("\n")); process.exit(0); }
  else if (VALUED.includes(a)) {
    const v = argv[++i];
    if (v === undefined || v.startsWith("--")) die(`${a} needs a value`);
    if (a === "--exclude") excludes.push(v!.replace(/^\.\//, "").replace(/\/?$/, "/"));
    else opts.set(a, v!.trim());
  } else die(`unknown argument ${a}; see --help`);
}

// ---- Well-formedness only ----------------------------------------------------------------------------------------------------
const HOST = /^(?=.{4,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
function checkDomain(v: string, flag: string): string {
  if (!HOST.test(v)) die(`${flag} "${v}" is not a host name: lower case, no scheme, no path, no @ (for example trellis.example)`);
  return v;
}
function checkSupport(v: string, flag: string): string {
  const parts = v.split("@");
  if (parts.length !== 2 || !/^[A-Za-z0-9._+-]{1,64}$/.test(parts[0]!) || !HOST.test(parts[1]!.toLowerCase())) die(`${flag} is not an address of the form mailbox@host`);
  return v;
}
function checkOrg(v: string, flag: string): string {
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(v) || v.includes("--")) die(`${flag} "${v}" is not a GitHub organisation name (letters, digits and single hyphens, at most 39 characters)`);
  return v;
}
function checkHandle(v: string, flag: string): string {
  const h = v.replace(/^@/, "");
  if (!/^[A-Za-z0-9_]{1,30}$/.test(h)) die(`${flag} "${v}" is not a handle (letters, digits and underscores, at most 30 characters)`);
  return h;
}
function checkPath(v: string, flag: string, what: string): string {
  if (!/^[a-z0-9][a-z0-9.-]*(?::\d{2,5})?(?:\/[A-Za-z0-9._~-]+)+$/.test(v)) die(`${flag} "${v}" is not ${what} (host/path, no scheme, no spaces)`);
  return v;
}
function checkRepo(v: string, flag: string): string {
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(v)) die(`${flag} "${v}" is not a repository name`);
  return v;
}

const to = {
  domain: opts.has("--domain") ? checkDomain(opts.get("--domain")!, "--domain") : null,
  support: opts.has("--support") ? checkSupport(opts.get("--support")!, "--support") : null,
  org: opts.has("--org") ? checkOrg(opts.get("--org")!, "--org") : null,
  handle: opts.has("--handle") ? checkHandle(opts.get("--handle")!, "--handle") : null,
  repo: opts.has("--repo") ? checkRepo(opts.get("--repo")!, "--repo") : null,
  imageRegistry: null as string | null,
  goModule: null as string | null,
};
to.imageRegistry = opts.has("--image-registry") ? checkPath(opts.get("--image-registry")!, "--image-registry", "an image path prefix such as ghcr.io/your-org") : to.org ? `ghcr.io/${to.org.toLowerCase()}` : null;
to.goModule = opts.has("--go-module") ? checkPath(opts.get("--go-module")!, "--go-module", "a Go module path") : to.org ? `github.com/${to.org}/${to.repo ?? PLACEHOLDERS.repo}/sdks/go` : null;
const from = {
  domain: opts.has("--from-domain") ? checkDomain(opts.get("--from-domain")!, "--from-domain") : PLACEHOLDERS.domain,
  support: opts.has("--from-support") ? checkSupport(opts.get("--from-support")!, "--from-support") : null as string | null,
  orgs: opts.has("--from-org") ? [checkOrg(opts.get("--from-org")!, "--from-org")] : [...PLACEHOLDERS.orgs],
  handle: opts.has("--from-handle") ? checkHandle(opts.get("--from-handle")!, "--from-handle") : PLACEHOLDERS.handle,
  imageRegistry: opts.get("--from-image-registry") ?? PLACEHOLDERS.imageRegistry,
  goModule: opts.get("--from-go-module") ?? PLACEHOLDERS.goModule,
};
from.support ??= `support@${from.domain}`;
if (to.support && to.domain && !to.support.toLowerCase().endsWith(`@${to.domain}`) && !to.support.toLowerCase().endsWith(`.${to.domain}`)) console.log(`note: the support address is not on ${to.domain}`);

// ---- Rules, in the order they are applied ----------------------------------------------------------------------------------
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
type Rule = { name: string; shown: string; target?: string | null; pattern: RegExp; replace: ((m: string, ...g: string[]) => string) | null };
// A domain or handle is matched only where it is not part of a longer name (so "trellis.example" inside
// "nottrellis.example" or "TrellisHQx" is left alone); a sub-domain is "longer" on the left and still matches.
// The domain as it appears inside regular expressions and JSON-escaped ones: trellis\.example, trellis\\.example.
const domainEscaped = from.domain.split(".").map(esc).map((label, i) => (i === 0 ? label : i === 1 ? `(\\\\+)\\.${label}` : `\\\\+\\.${label}`)).join("");
const rules: Rule[] = [
  { name: "support address", shown: from.support!, target: to.support, pattern: new RegExp(`(?<![A-Za-z0-9._+-])${esc(from.support!)}(?![A-Za-z0-9-])`, "g"), replace: to.support ? () => to.support! : null },
  { name: "domain", shown: from.domain, target: to.domain, pattern: new RegExp(`(?<![A-Za-z0-9-])${esc(from.domain)}(?![A-Za-z0-9-]|\\.[a-z])`, "g"), replace: to.domain ? () => to.domain! : null },
  { name: "domain (regex-escaped)", shown: from.domain.replace(/\./g, "\\."), target: to.domain?.replace(/\./g, "\\."), pattern: new RegExp(`(?<![A-Za-z0-9-])${domainEscaped}(?![A-Za-z0-9-])`, "g"), replace: to.domain ? (_m, backslashes) => to.domain!.split(".").join(`${backslashes}.`) : null },
  { name: "container image path", shown: from.imageRegistry, target: to.imageRegistry, pattern: new RegExp(`${esc(from.imageRegistry)}(?=/)`, "g"), replace: to.imageRegistry ? () => to.imageRegistry! : null },
  { name: "Go module path", shown: from.goModule, target: to.goModule, pattern: new RegExp(`(?<![A-Za-z0-9.-])${esc(from.goModule)}(?![A-Za-z0-9_-])`, "g"), replace: to.goModule ? () => to.goModule! : null },
  // The organisation, with the repository name beside it when --repo is given. "example-org/example-model" and
  // "example-org/example-repo" are fixture names (a model repository, a sample source pin), not this repository's org.
  ...from.orgs.map((org): Rule => ({
    name: `GitHub organisation (${org})`, shown: org, target: to.org ? `${to.org}${to.repo ? ` (repository ${to.repo})` : ""}` : null,
    pattern: new RegExp(`(?<![A-Za-z0-9-])${esc(org)}(?![A-Za-z0-9-])(?!/example-)(/[Tt]rellis(?![A-Za-z0-9_-]))?`, "g"),
    replace: to.org ? (_m, repo) => to.org! + (repo ? (to.repo ? `/${to.repo}` : repo) : "") : null,
  })),
  { name: "social handle", shown: from.handle, target: to.handle, pattern: new RegExp(`(?<![A-Za-z0-9_])${esc(from.handle)}(?![A-Za-z0-9_])`, "g"), replace: to.handle ? () => to.handle! : null },
];

// ---- Files -----------------------------------------------------------------------------------------------------------------
const listed = Bun.spawnSync(["git", "-C", ROOT, "ls-files", "-co", "--exclude-standard", "-z"]);
if (listed.exitCode !== 0) die("git ls-files failed: run this inside the repository");
const files = listed.stdout.toString().split("\0").filter((f) => f && !SKIP.includes(f) && !SKIP.some((s) => f.endsWith(`/${s}`)) && !SKIP_DIRS.some((d) => f.startsWith(d) || f.includes(`/${d}`)) && !excludes.some((e) => f.startsWith(e)));

type Count = { occurrences: number; files: Set<string>; byTop: Map<string, number> };
const counts = new Map<string, Count>(rules.map((r) => [r.name, { occurrences: 0, files: new Set(), byTop: new Map() }]));
const changed: string[] = [];
for (const f of files) {
  let bytes: Buffer;
  try { bytes = readFileSync(join(ROOT, f)); } catch { continue; } // listed but gone (a deleted tracked file)
  if (bytes.subarray(0, 8192).includes(0)) continue; // binary
  let text = bytes.toString("utf8");
  if (Buffer.from(text, "utf8").length !== bytes.length) continue; // not UTF-8: leave it byte for byte
  const before = text;
  // A placeholder with no flag is counted and then parked behind a private-use marker, so a later rule cannot count it
  // again (the support address contains the domain); the parked text is put back unchanged below.
  const parked: string[] = [];
  for (const r of rules) {
    const n = text.match(r.pattern)?.length ?? 0;
    if (!n) continue;
    const c = counts.get(r.name)!;
    c.occurrences += n;
    c.files.add(f);
    const top = f.includes("/") ? f.slice(0, f.indexOf("/")) : f;
    c.byTop.set(top, (c.byTop.get(top) ?? 0) + n);
    text = text.replace(r.pattern, r.replace ? (r.replace as (m: string, ...g: string[]) => string) : (m) => `\uE000${parked.push(m) - 1}\uE001`);
  }
  text = text.replace(/\uE000(\d+)\uE001/g, (_m, i) => parked[Number(i)]!);
  if (text !== before) { changed.push(f); if (!dryRun) writeFileSync(join(ROOT, f), text); }
}

// ---- Report ----------------------------------------------------------------------------------------------------------------
const anyTarget = rules.some((r) => r.replace);
console.log(`${dryRun ? "Dry run: nothing is written." : anyTarget ? "Renamed." : "No replacement flag given: counting only."} ${files.length} files read.`);
const rows = [["placeholder", "now", "occurrences", "files", "becomes"]];
for (const r of rules) {
  const c = counts.get(r.name)!;
  const sample = !r.replace ? "(no flag: left as is)" : !c.occurrences ? "(none found)" : r.target ?? "";
  rows.push([r.name, r.shown, String(c.occurrences), String(c.files.size), sample]);
}
const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => r[i]!.length)));
for (const r of rows) console.log("  " + r.map((c, i) => c.padEnd(widths[i]!)).join("  ").trimEnd());
console.log("\nBy top-level path");
for (const r of rules) {
  const c = counts.get(r.name)!;
  if (!c.occurrences) continue;
  console.log(`  ${r.name}: ${[...c.byTop.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(", ")}`);
}
const total = [...counts.values()].reduce((s, c) => s + c.occurrences, 0);
if (anyTarget) {
  console.log(`\n${dryRun ? "Would change" : "Changed"} ${changed.length} file(s).`);
  const tests = changed.filter((f) => /(^|\/)(tests?|__tests__)\//.test(f) || /\.test\.[a-z]+$/.test(f));
  if (tests.length) console.log(`  ${tests.length} of them are tests or fixtures: run the suites after renaming (bun run typecheck, bun test, cd web && pnpm test && pnpm build).`);
  if (!dryRun && changed.length) console.log("  Review with: git diff --stat");
} else console.log(`\n${total} placeholder occurrence(s) in the tree. Pass --domain, --org, --handle and --support to replace them.`);
