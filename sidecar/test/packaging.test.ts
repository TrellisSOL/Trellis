import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, parseConfig } from "../src/config.ts";
import { SIDECAR_VERSION } from "../src/version.ts";

const root = join(import.meta.dir, "..");
const read = (f: string) => readFileSync(join(root, f), "utf8");

describe("shipped files", () => {
  test("sidecar.example.yaml parses with the strict loader", () => {
    const cfg = loadConfig({}, join(root, "sidecar.example.yaml"));
    expect(cfg.server.tls).toBe("self_signed");
    expect(cfg.attestation.provider).toBe("dstack");
    expect(cfg.classifier.enabled).toBe(false);
    expect(cfg.auth.allowAnonymous).toBe(false);
    expect(cfg.allowlist.modelDigests).toHaveLength(1);
  });

  test("the package version matches the version the sidecar reports", () => {
    expect(JSON.parse(read("package.json")).version).toBe(SIDECAR_VERSION);
  });

  test("the Dockerfile pins every base image by digest, installs from the lockfile and never as root", () => {
    const docker = read("Dockerfile");
    const bases = [...docker.matchAll(/^(?:ARG BUN_IMAGE=|FROM )(\S+)/gm)].map((m) => m[1]).filter((v) => !v.startsWith("${") && !/^[A-Za-z]+$/.test(v));
    expect(bases.length).toBeGreaterThan(0);
    for (const b of bases) expect(b).toMatch(/@sha256:[0-9a-f]{64}$/);
    expect(docker).toContain("--frozen-lockfile");
    expect(docker).toContain("--ignore-scripts");
    expect(docker).toMatch(/SOURCE_DATE_EPOCH/);
    expect(docker).toMatch(/^USER bun$/m);
    // The default image fetches nothing outside the lockfile. Only the optional GPU target, between its two markers, may.
    const [before, rest] = docker.split(/^# ---- GPU image: begin.*$/m);
    const [gpu, after] = rest.split(/^# ---- GPU image: end.*$/m);
    expect(`${before}${after}`).not.toMatch(/apt-get|curl |wget /);
    // The default image is the last stage, so a plain `docker build` still produces it, and it has no GPU tooling.
    expect(after.match(/^FROM .*$/gm)).toEqual(["FROM ${BUN_IMAGE}"]);
    expect(after).not.toMatch(/nvattest|nvidia/i);
    expect(after).toMatch(/^USER bun$/m);
  });

  test("the GPU target adds NVIDIA's nvattest from one pinned commit and still does not run as root", () => {
    const docker = read("Dockerfile");
    const gpu = docker.split(/^# ---- GPU image: begin.*$/m)[1].split(/^# ---- GPU image: end.*$/m)[0];
    expect(gpu).toMatch(/^FROM \$\{BUN_IMAGE\} AS nvattest-build$/m);
    expect(gpu).toMatch(/^FROM \$\{BUN_IMAGE\} AS gpu$/m);
    // A full commit hash, checked after the fetch: a tag or a branch could move.
    expect(gpu).toMatch(/^ARG NVAT_COMMIT=[0-9a-f]{40}$/m);
    expect(gpu).toContain('test "$(git rev-parse HEAD)" = "${NVAT_COMMIT}"');
    expect(gpu).toMatch(/^ARG RUST_VERSION=\d+\.\d+\.\d+$/m);
    expect(gpu).toContain("https://github.com/NVIDIA/attestation-sdk.git");
    expect(gpu).toContain("COPY --from=nvattest-build /opt/nvat/bin/nvattest /usr/local/bin/nvattest");
    expect(gpu).toContain("nvattest version");
    // The same sidecar files, user and entrypoint as the default image.
    const runtime = gpu.slice(gpu.indexOf("AS gpu"));
    for (const line of ["COPY --from=stage /app /app", "USER bun", 'ENTRYPOINT ["bun", "src/main.ts"]', 'CMD ["serve"]']) expect(runtime).toContain(line);
    expect(runtime.indexOf("USER bun")).toBeGreaterThan(runtime.lastIndexOf("RUN "));
  });

  test("the compose example requires pinned images, keeps the model server off the public network and unpublished", () => {
    const compose = Bun.YAML.parse(read("docker-compose.example.yml")) as {
      services: Record<string, { image: string; ports?: string[]; networks: string[]; environment?: Record<string, string> }>;
      networks: Record<string, { internal?: boolean }>;
    };
    expect(compose.services.vllm.image).toContain(":?");
    expect(compose.services.sidecar.image).toContain(":?");
    expect(compose.services.vllm.ports).toBeUndefined();
    expect(compose.services.vllm.networks).toEqual(["backend"]);
    expect(compose.networks.backend.internal).toBe(true);
    expect(compose.services.sidecar.environment?.SIDECAR_DEV_ATTESTATION).toBeUndefined();
    // The optional classifier server is pinned, on the internal network only, unpublished, and off unless its profile is chosen.
    const classifier = compose.services.classifier as (typeof compose.services)[string] & { profiles?: string[] };
    expect(classifier.image).toContain(":?");
    expect(classifier.ports).toBeUndefined();
    expect(classifier.networks).toEqual(["backend"]);
    expect(classifier.profiles).toEqual(["classifier"]);
  });

  test("the runtime dependencies are exactly two, each pinned to an exact version and locked", () => {
    const pkg = JSON.parse(read("package.json"));
    expect(Object.keys(pkg.dependencies)).toEqual(["@hpke/core", "@noble/hashes"]);
    for (const v of Object.values(pkg.dependencies)) expect(v).toMatch(/^\d+\.\d+\.\d+$/);
    const lock = read("bun.lock");
    for (const [name, version] of Object.entries(pkg.dependencies)) expect(lock).toContain(`"${name}@${version}"`);
    // @hpke/core brings one internal package and nothing else.
    expect(lock).toMatch(/"@hpke\/core": \["@hpke\/core@[^"]+", "", \{ "dependencies": \{ "@hpke\/common": "[^"]+" \} \}/);
    expect(lock).toMatch(/"@hpke\/common": \["@hpke\/common@[^"]+", "", \{\}/);
    expect(pkg.license).toBe("Apache-2.0");
  });

  test("the example configuration documents the classifier and encryption, and is complete when they are switched on", () => {
    const raw = Bun.YAML.parse(read("sidecar.example.yaml")) as Record<string, any>;
    expect(raw.classifier.enabled).toBe(false);
    expect(raw.hpke.enabled).toBe(false);
    expect(raw.allowlist.classifier_digests).toHaveLength(1);
    raw.classifier.enabled = true;
    raw.hpke.enabled = true;
    const cfg = parseConfig(raw, {});
    expect(cfg.classifier).toMatchObject({ enabled: true, kind: "openai_chat", nonTextInput: "refuse", checkResponse: false });
    expect(cfg.classifier.model.path).toBeTruthy();
    expect(cfg.hpke).toEqual({ enabled: true, clockSkewSeconds: 300 });
    expect(cfg.allowlist.classifierDigests).toHaveLength(1);
  });
});
