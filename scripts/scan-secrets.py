#!/usr/bin/env python3
"""Secret gate: Gitleaks over the whole history and over the files of the working tree.

Nothing secret is printed or stored: Gitleaks runs redacted, its report is read from a pipe (so no author metadata is
persisted either), and this script reports only the file, line and rule of a finding.

Reviewed false positives (public test vectors, synthetic fixtures, placeholder constants) are listed in
security/secret-fixtures.json. An entry approves one flagged span and nothing else: the file, the Gitleaks rule and
the SHA-256 of the exact flagged line(s). Replacing a fixture with a real key changes those bytes and fails the gate;
a move to another file or a different rule on the same line fails it too. The same entry covers that span in the
history, where it is hashed from the file as it was at the flagged commit, so an approval does not depend on a commit
id (which a commit cannot know about itself) or on a line number (which drifts with every edit above it).

  python3 scripts/scan-secrets.py                 the gate (exit 0 clean, 1 unapproved findings, 2 the scan failed)
  python3 scripts/scan-secrets.py --self-test     plants synthetic secrets in a throwaway repository and checks that
                                                  the gate catches them in the tree and in the history; then runs
                                                  the identifier scan's self-test

Identifier scan (CI step "Identifier scan"): no symbolic link is tracked in git, and no tracked file names the home
directory of a real machine. It reads the index and the tracked files as they are on disk, needs no Gitleaks, and
prints the file and the line of a finding, never the text that matched.

  python3 scripts/scan-secrets.py --identifiers               exit 0 clean, 1 findings, 2 the scan failed
  python3 scripts/scan-secrets.py --identifiers --self-test   plants a link and a home-directory path in a throwaway
                                                              repository: both must be caught, a clean one must pass
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile

# Gitleaks exits with this when it found something. Its own default (1) is also what it exits with on a fatal error
# such as an unwritable report path, which an earlier version of this gate read as "ran, found nothing".
LEAKS = 3
# Exceptions live in the reviewed baseline only; these would be a second, unreviewed way to silence a finding.
SIDE_DOORS = (".gitleaks.toml", ".gitleaksignore")
HEX64 = frozenset("0123456789abcdef")


class ScanError(Exception):
    """The scan did not run to a trustworthy result. Never carries scanner output, which may hold a credential."""


class SelfTestFailure(Exception):
    """The gate did not behave as the self-test requires."""


def span_hash(data, start, end):
    """SHA-256 of lines start..end (1-based, inclusive) of `data`, or None when that span does not exist."""
    if not isinstance(start, int) or not isinstance(end, int) or not 0 < start <= end:
        return None
    lines = data.splitlines(keepends=True)
    if end > len(lines):
        return None
    return hashlib.sha256(b"".join(lines[start - 1:end])).hexdigest()


def approved(file, rule, digest, fixtures):
    """Whether a reviewed entry names exactly this file, this rule and these bytes."""
    return digest is not None and any(x["file"] == file and x["rule"] == rule and digest in x["sha256"] for x in fixtures)


def load_baseline(path):
    try:
        fixtures = json.loads(Path(path).read_text())["fixtures"]
        for x in fixtures:
            if not (isinstance(x["file"], str) and x["file"] and isinstance(x["rule"], str) and x["rule"]
                    and isinstance(x["reason"], str) and x["reason"].strip()
                    and isinstance(x["sha256"], list) and x["sha256"]
                    and all(isinstance(h, str) and len(h) == 64 and set(h) <= HEX64 for h in x["sha256"])):
                raise ValueError("entry")
        return fixtures
    except (OSError, ValueError, KeyError, TypeError):
        raise ScanError(f"the baseline {path} is missing or malformed: every entry needs file, rule, sha256[] and a reason") from None


def scanner_env():
    # A configuration from the environment would replace the default rule set.
    return {k: v for k, v in os.environ.items() if not k.startswith("GITLEAKS_")}


def run_gitleaks(binary, mode, cwd, ignore_dir):
    try:
        result = subprocess.run(
            [binary, mode, "--redact", "--no-banner", "--log-level", "error", "--ignore-gitleaks-allow",
             "--gitleaks-ignore-path", str(ignore_dir), "--exit-code", str(LEAKS),
             "--report-format", "json", "--report-path", "-"],
            cwd=cwd, capture_output=True, text=True, env=scanner_env())
    except OSError:
        raise ScanError(f"Gitleaks could not be started ({binary})") from None
    if result.returncode not in (0, LEAKS):
        raise ScanError(f"Gitleaks {mode} failed with exit {result.returncode}")
    try:
        rows = json.loads(result.stdout)
        if not isinstance(rows, list) or not all(isinstance(r, dict) for r in rows):
            raise ValueError("shape")
    except (ValueError, TypeError):
        raise ScanError(f"Gitleaks {mode} produced no readable report") from None
    # The exit code and the report must tell the same story; an empty report beside a "found something" exit is a
    # scan that did not report, not a clean tree.
    if bool(rows) != (result.returncode == LEAKS):
        raise ScanError(f"Gitleaks {mode}: the report does not match its exit code")
    return rows


def git(root, *args):
    result = subprocess.run(["git", *args], cwd=root, capture_output=True)
    if result.returncode != 0:
        raise ScanError(f"git {args[0]} failed with exit {result.returncode}")
    return result.stdout


def export_tree(root, dest):
    """Copy what the repository holds or could be given by `git add -A`: tracked files as they are on disk and
    untracked files that are not ignored. Ignored files (dependencies, build output, local env files) are not part of
    the tree, and a scan of them would differ from one machine to the next."""
    names = git(root, "ls-files", "-z", "--cached", "--others", "--exclude-standard").split(b"\0")
    for raw in names:
        if not raw:
            continue
        relative = os.fsdecode(raw)
        source = root / relative
        if source.is_symlink() or not source.is_file():
            continue  # a deleted file, a submodule or a link; a link's target is scanned where it lives
        target = dest / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)


def gate(root, baseline_path, gitleaks="gitleaks"):
    """Scan `root`. Returns (unapproved findings, baseline entries that matched nothing)."""
    root = Path(root).resolve()
    fixtures = load_baseline(baseline_path)
    for name in SIDE_DOORS:
        if (root / name).exists():
            raise ScanError(f"{name} is present: exceptions belong in security/secret-fixtures.json, where each is bound to reviewed bytes")
    if git(root, "rev-parse", "--is-shallow-repository").strip() == b"true":
        raise ScanError("this is a shallow clone: the history scan needs every commit (fetch-depth: 0)")
    findings, used = [], set()

    def judge(mode, row, data):
        file, rule = row.get("File", ""), row.get("RuleID", "")
        start, end = row.get("StartLine"), row.get("EndLine")
        digest = span_hash(data, start, end) if data is not None else None
        if approved(file, rule, digest, fixtures):
            used.add((file, rule, digest))
            return
        finding = {"mode": mode, "rule": rule, "file": file, "start": start, "end": end, "sha256": digest}
        if mode == "history":
            finding["commit"] = str(row.get("Commit", ""))[:12]
        findings.append(finding)

    with tempfile.TemporaryDirectory(prefix="secret-gate-") as scratch:
        scratch = Path(scratch)
        empty, tree = scratch / "no-ignore-file", scratch / "tree"
        empty.mkdir()
        tree.mkdir()

        blobs = {}
        for row in run_gitleaks(gitleaks, "git", root, empty):
            key = (str(row.get("Commit", "")), str(row.get("File", "")))
            if key not in blobs:
                blobs[key] = None
                if key[1] and len(key[0]) in (40, 64) and set(key[0]) <= HEX64:  # a commit id, nothing git reads as an option
                    shown = subprocess.run(["git", "show", f"{key[0]}:{key[1]}"], cwd=root, capture_output=True)
                    blobs[key] = shown.stdout if shown.returncode == 0 else None
            judge("history", row, blobs[key])

        export_tree(root, tree)
        for row in run_gitleaks(gitleaks, "dir", tree, empty):
            path = (tree / str(row.get("File", ""))).resolve()
            inside = path.is_relative_to(tree.resolve()) and path.is_file()
            judge("tree", row, path.read_bytes() if inside else None)

    stale = [{"file": x["file"], "rule": x["rule"], "sha256": h}
             for x in fixtures for h in x["sha256"] if (x["file"], x["rule"], h) not in used]
    return findings, stale


def describe(findings, limit=200):
    """One line per place: where and which rule. Never the value, the commit author or the message."""
    places = sorted({(f["mode"], f["file"], f["start"] or 0, f["rule"], f.get("commit", "")) for f in findings})
    lines = [f"  {mode:<7} {file}:{start}  {rule}" + (f"  (commit {commit})" if commit else "")
             for mode, file, start, rule, commit in places[:limit]]
    if len(places) > limit:
        lines.append(f"  ... and {len(places) - limit} more")
    return lines


# ---- identifiers -------------------------------------------------------------------------------------------------------

LINK_MODE, SUBMODULE_MODE = b"120000", b"160000"
# The account directory under the users root of macOS, Linux or Windows, as a pattern: group 1 is the root, group 2 or
# 3 the account name. No account name is written in this file.
HOME_PATH = re.compile(rb"/(Users|home)/([A-Za-z0-9._-]+)|[A-Za-z]:\\Users\\([A-Za-z0-9._-]+)")
# Account names that images, runners and documentation use for nobody in particular, per root. Matched whole: a longer
# name that starts with one of them is a finding. The Windows form has none.
GENERIC_ACCOUNTS = {
    b"Users": frozenset((b"you", b"me", b"name", b"username", b"example", b"Shared")),
    b"home": frozenset((b"bun", b"node", b"runner", b"user", b"ubuntu", b"app", b"backup", b"nonroot", b"you", b"example")),
}


def tracked_entries(root):
    """(path, is a link) for every path of the index, once. Untracked and ignored files are not in the index."""
    entries = {}
    for record in git(root, "ls-files", "-s", "-z").split(b"\0"):
        if not record:
            continue
        meta, tab, raw = record.partition(b"\t")
        mode = meta.split(b" ", 1)[0]
        if not tab or not raw or len(mode) != 6:
            raise ScanError("git ls-files printed a record this scan cannot read")
        if mode == SUBMODULE_MODE:
            continue  # another repository's commit, not a file of this one
        entries[raw] = entries.get(raw, False) or mode == LINK_MODE
    return [(os.fsdecode(raw), link) for raw, link in sorted(entries.items())]


def identifier_scan(root):
    """Findings as {rule, file, line}: `symlink` for a tracked symbolic link (in the index, or a tracked path that is a
    link on disk), `home-path` for a home-directory path in a tracked file, `unreadable` for a tracked file that could
    not be read and so was not scanned. The matched text is never part of a finding."""
    root = Path(root).resolve()
    found = set()
    for relative, link in tracked_entries(root):
        path = root / relative
        if link or path.is_symlink():
            found.add(("symlink", relative, 0))
            continue  # a link's target is not read through the link
        try:
            data = path.read_bytes()
        except OSError:
            found.add(("unreadable", relative, 0))
            continue
        for match in HOME_PATH.finditer(data):
            if match.group(3) is None and match.group(2) in GENERIC_ACCOUNTS[match.group(1)]:
                continue
            found.add(("home-path", relative, data.count(b"\n", 0, match.start()) + 1))
    return [{"rule": rule, "file": file, "line": line or None} for rule, file, line in sorted(found)]


def describe_identifiers(findings, limit=200):
    """One line per place: the rule, the file and (for a path) the line. Never the text that matched."""
    lines = [f"  {f['rule']:<10} {f['file']}" + (f":{f['line']}" if f["line"] else "") for f in findings[:limit]]
    if len(findings) > limit:
        lines.append(f"  ... and {len(findings) - limit} more")
    return lines


def identifier_self_test():
    def check(condition, what):
        if not condition:
            raise SelfTestFailure(what)

    with tempfile.TemporaryDirectory(prefix="identifier-scan-self-test-") as scratch:
        scratch = Path(scratch)
        repo = scratch / "repo"
        repo.mkdir()
        env = {"PATH": os.environ.get("PATH", ""), "HOME": str(scratch), "GIT_CONFIG_GLOBAL": os.devnull,
               "GIT_CONFIG_SYSTEM": os.devnull, "GIT_CONFIG_NOSYSTEM": "1", "GIT_AUTHOR_NAME": "identifier-scan-self-test",
               "GIT_AUTHOR_EMAIL": "", "GIT_COMMITTER_NAME": "identifier-scan-self-test", "GIT_COMMITTER_EMAIL": "",
               "GIT_AUTHOR_DATE": "2026-01-01T00:00:00Z", "GIT_COMMITTER_DATE": "2026-01-01T00:00:00Z"}

        def run(*args):
            done = subprocess.run(["git", *args], cwd=repo, env=env, capture_output=True)
            check(done.returncode == 0, f"git {args[0]} failed in the throwaway repository")

        def places(rule):
            return [(f["file"], f["line"]) for f in identifier_scan(repo) if f["rule"] == rule]

        # Sample paths are put together here, from an account name nobody has, so that this file holds none.
        account = "selftest-" + synthetic("identifier", "abcdefghijklmnopqrstuvwxyz", 10)
        mac, linux = "/".join(("", "Users", account)), "/".join(("", "home", account))
        windows = "\\".join(("C:", "Users", account))
        generic = ["/".join(("", "Users", "you")), "/".join(("", "home", "runner")), "/".join(("", "home", "node"))]

        # 1. A clean repository passes: generic account names, and a link and a path that are NOT tracked (one
        #    untracked, one in an ignored directory).
        run("init", "-q")
        (repo / "README.txt").write_text("nothing personal here\n" + "".join(f"WORKDIR {p}/app\n" for p in generic))
        (repo / ".gitignore").write_text("ignored/\n")
        run("add", "-A")
        run("commit", "-q", "-m", "start")
        (repo / "ignored").mkdir()
        (repo / "ignored/link").symlink_to("../README.txt")
        (repo / "ignored/notes.txt").write_text(f"{mac}\n")
        (repo / "untracked-link").symlink_to("README.txt")
        (repo / "untracked.txt").write_text(f"{linux}\n")
        check(identifier_scan(repo) == [], "a clean repository (generic names, untracked and ignored files only) was flagged")

        # 2. A planted home-directory path in a tracked file is caught, in each of its three shapes, with file and
        #    line; a name that only starts like a generic one is caught too; nothing printed carries the path.
        (repo / "docs").mkdir()
        (repo / "docs/setup.md").write_text(f"# Setup\n\ncd {mac}/project\n{generic[0]}/project is fine\n{linux}\n{windows}\n{generic[1]}ner\n")
        run("add", "docs/setup.md")
        check(places("home-path") == [("docs/setup.md", 3), ("docs/setup.md", 5), ("docs/setup.md", 6), ("docs/setup.md", 7)],
              "a planted home-directory path in a tracked file was not caught at its line")
        shown = "\n".join(describe_identifiers(identifier_scan(repo)))
        check(account not in shown and "project" not in shown, "the scan printed what it matched")
        check(places("symlink") == [], "an untracked or ignored link was reported")

        # 3. A planted symbolic link that is tracked is caught wherever it is: staged or committed, to a file, to a
        #    directory or to nothing; and a tracked file swapped for a link on disk is caught although the index
        #    still says file.
        (repo / "deep/er").mkdir(parents=True)
        (repo / "deep/er/link").symlink_to("../../README.txt")
        (repo / "deep/to-a-directory").symlink_to("..")
        (repo / "dangling").symlink_to("does-not-exist")
        run("add", "deep", "dangling")
        check(places("symlink") == [("dangling", None), ("deep/er/link", None), ("deep/to-a-directory", None)], "a planted symbolic link that is tracked was not caught")
        run("commit", "-q", "-m", "plant")
        check(len(places("symlink")) == 3, "a committed symbolic link was not caught")
        (repo / "README.txt").unlink()
        (repo / "README.txt").symlink_to("docs/setup.md")
        check(("README.txt", None) in places("symlink"), "a tracked file swapped for a link on disk was not caught")

        # 4. A tracked file that is not there to be read was not scanned: that is a finding, not a pass. A directory
        #    that is no repository is a failed scan.
        (repo / "docs/setup.md").unlink()
        check(places("unreadable") == [("docs/setup.md", None)], "a tracked file that could not be read was passed over")
        try:
            identifier_scan(scratch)
        except ScanError:
            pass
        else:
            check(False, "a directory that is not a repository was read as a clean scan")
    print("Identifier scan self-test: ok (a planted tracked link and a planted home-directory path are caught; untracked and ignored ones, generic names and a clean repository pass; nothing matched is printed)")
    return 0


# ---- self-test ---------------------------------------------------------------------------------------------------------

def synthetic(label, alphabet, length):
    """A deterministic, secret-shaped string that exists nowhere but in the self-test's throwaway repository."""
    out, counter = [], 0
    while len(out) < length:
        for byte in hashlib.sha256(f"secret gate self-test:{label}:{counter}".encode()).digest():
            out.append(alphabet[byte % len(alphabet)])
        counter += 1
    return "".join(out[:length])


def planted_file(label):
    alnum = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
    token = "ghp" + "_" + synthetic(label, alnum, 36)  # the shape of a hosted-git access token
    body = synthetic(label + ":pem", alnum + "+/", 320)
    dashes = "-" * 5
    pem = [f"{dashes}BEGIN RSA PRIVATE" + f" KEY{dashes}"] + [body[i:i + 64] for i in range(0, len(body), 64)] + [f"{dashes}END RSA PRIVATE" + f" KEY{dashes}"]
    return f"deploy_token = \"{token}\"\n" + "\n".join(pem) + "\n"


def self_test(gitleaks):
    def check(condition, what):
        if not condition:
            raise SelfTestFailure(what)

    with tempfile.TemporaryDirectory(prefix="secret-gate-self-test-") as scratch:
        scratch = Path(scratch)
        repo, baseline = scratch / "repo", scratch / "baseline.json"
        repo.mkdir()
        # A repository of its own, with no configuration from this machine: no signing, no hooks, no identity.
        env = {"PATH": os.environ.get("PATH", ""), "HOME": str(scratch), "GIT_CONFIG_GLOBAL": os.devnull,
               "GIT_CONFIG_SYSTEM": os.devnull, "GIT_CONFIG_NOSYSTEM": "1", "GIT_AUTHOR_NAME": "secret-gate-self-test",
               "GIT_AUTHOR_EMAIL": "", "GIT_COMMITTER_NAME": "secret-gate-self-test", "GIT_COMMITTER_EMAIL": "",
               "GIT_AUTHOR_DATE": "2026-01-01T00:00:00Z", "GIT_COMMITTER_DATE": "2026-01-01T00:00:00Z"}

        def run(*args):
            done = subprocess.run(["git", *args], cwd=repo, env=env, capture_output=True)
            check(done.returncode == 0, f"git {args[0]} failed in the throwaway repository")

        def commit(message):
            run("add", "-A")
            run("commit", "-q", "-m", message)

        def write_baseline(fixtures):
            baseline.write_text(json.dumps({"fixtures": fixtures}))

        def rules(findings, mode):
            return sorted({f["rule"] for f in findings if f["mode"] == mode and f["file"] == "planted/settings.conf"})

        run("init", "-q")
        (repo / "README.txt").write_text("nothing secret here\n")
        commit("start")
        write_baseline([])
        findings, _ = gate(repo, baseline, gitleaks)
        check(findings == [], "a repository with nothing in it was flagged")

        # 1. A planted secret that is only in the working tree (not yet committed) is caught there.
        (repo / "planted").mkdir()
        (repo / "planted/settings.conf").write_text(planted_file("first"))
        findings, _ = gate(repo, baseline, gitleaks)
        check(rules(findings, "tree") == ["github-pat", "private-key"], "a planted token and private key in the tree were not caught")
        check(rules(findings, "history") == [], "an uncommitted file was reported from the history")

        # 2. Committed and then deleted: gone from the tree, still caught in the history.
        commit("plant")
        (repo / "planted/settings.conf").unlink()
        commit("remove")
        findings, _ = gate(repo, baseline, gitleaks)
        check(rules(findings, "tree") == [], "a deleted file was reported from the tree")
        check(rules(findings, "history") == ["github-pat", "private-key"], "a planted secret that was committed and deleted was not caught in the history")
        check(all(f["sha256"] for f in findings), "a history finding has no span hash")

        # 3. An approval binds file, rule and bytes: the reviewed spans pass (in the history and, put back, in the
        #    tree); a different secret on the same lines does not, nor does the same content in another file.
        write_baseline([{"file": f["file"], "rule": f["rule"], "sha256": [f["sha256"]], "reason": "self-test"} for f in findings])
        (repo / "planted/settings.conf").write_text(planted_file("first"))
        findings, stale = gate(repo, baseline, gitleaks)
        check(findings == [] and stale == [], "reviewed spans were not accepted")
        (repo / "planted/settings.conf").write_text(planted_file("second"))
        findings, _ = gate(repo, baseline, gitleaks)
        check(rules(findings, "tree") == ["github-pat", "private-key"], "a changed secret passed on the approval of the one it replaced")
        (repo / "planted/settings.conf").write_text(planted_file("first"))
        (repo / "elsewhere.conf").write_text(planted_file("first"))
        findings, _ = gate(repo, baseline, gitleaks)
        check(sorted({f["rule"] for f in findings if f["file"] == "elsewhere.conf"}) == ["github-pat", "private-key"],
              "approved bytes passed in a file they were not approved for")
        (repo / "elsewhere.conf").unlink()

        # 4. An inline allow comment or an ignore file is not a way around the baseline.
        (repo / "planted/settings.conf").write_text(planted_file("third").replace("\"\n", "\" # gitleaks:allow\n", 1))
        findings, _ = gate(repo, baseline, gitleaks)
        check("github-pat" in rules(findings, "tree"), "an inline allow comment silenced a finding")
        (repo / ".gitleaksignore").write_text("\n")
        try:
            gate(repo, baseline, gitleaks)
        except ScanError as error:
            check(".gitleaksignore" in str(error), "an ignore file was refused for the wrong reason")
        else:
            check(False, "an ignore file in the repository was accepted")
        (repo / ".gitleaksignore").unlink()

        # 5. A scanner that fails is a failed scan, never a clean one.
        broken = scratch / "broken-gitleaks"
        broken.write_text("#!/bin/sh\nexit 1\n")
        broken.chmod(0o755)
        for stub, body in ((broken, None), (scratch / "silent-gitleaks", f"#!/bin/sh\nexit {LEAKS}\n"), (scratch / "absent-gitleaks", "")):
            if body:
                stub.write_text(body)
                stub.chmod(0o755)
            try:
                gate(repo, baseline, str(stub))
            except ScanError:
                continue
            check(False, f"a scanner that does not report ({stub.name}) was read as a clean scan")
    print("Secret gate self-test: ok (planted secrets caught in the tree and in the history; approvals bind file, rule and bytes; a failed scan is not a pass)")
    return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    here = Path(__file__).resolve().parent.parent
    parser.add_argument("--gitleaks", default="gitleaks")
    parser.add_argument("--output", default="release-evidence/secrets.json")
    parser.add_argument("--root", default=str(here), help="the repository to scan (default: this one)")
    parser.add_argument("--baseline", default=None, help="reviewed false positives (default: <root>/security/secret-fixtures.json)")
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("--identifiers", action="store_true", help="the identifier scan instead of the secret gate: tracked symbolic links and home-directory paths")
    args = parser.parse_args()
    name = "Identifier scan" if args.identifiers else "Secret gate"
    try:
        if args.self_test:
            if args.identifiers:
                return identifier_self_test()
            self_test(args.gitleaks)
            name = "Identifier scan"
            return identifier_self_test()
        root = Path(args.root).resolve()
        if args.identifiers:
            found = identifier_scan(root)
            print(f"Identifier scan: {len(found)} findings (file and line only; what was matched is never printed)")
            for line in describe_identifiers(found):
                print(line)
            return 1 if found else 0
        findings, stale = gate(root, args.baseline or root / "security/secret-fixtures.json", args.gitleaks)
    except ScanError as error:
        print(f"{name}: {error}", file=sys.stderr)
        return 2
    except SelfTestFailure as error:
        print(f"{name} self-test FAILED: {error}", file=sys.stderr)
        return 1
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps({"ok": not findings, "findings": findings, "stale_exceptions": stale}, indent=2) + "\n")
    print(f"Secret gate: {len(findings)} unapproved findings; values and identities omitted")
    for line in describe(findings):
        print(line)
    if stale:
        print(f"Secret gate: note: {len(stale)} baseline entries match nothing any more and can be removed:")
        for line in sorted({f"  {x['file']}  {x['rule']}" for x in stale}):
            print(line)
    return 1 if findings else 0


if __name__ == "__main__":
    sys.exit(main())
