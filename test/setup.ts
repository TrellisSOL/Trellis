import { beforeEach, setDefaultTimeout } from "bun:test";

process.env.TRELLIS_ENV ??= "test";
// Tests that build a router without test/helpers.ts get the full surface too (see the note there); the default of the
// product is `core`, and test/launch-surface.test.ts checks that default with the variable unset.
process.env.LAUNCH_SURFACE ??= "all";
process.env.LAUNCH_TIER ??= "full"; // R4-21: production needs an explicit tier; the older production-config tests assume the old default
process.env.LAUNCH_SURFACE_ACK ??= "i-have-reviewed-the-extra-features"; // production-config tests of other features load the full surface

// The per-test and per-hook budget is 20 s, and it is the --timeout 20000 flag that sets it: `bun run test`,
// `bun run test:pg` and CI pass it. Bun reads no timeout from bunfig.toml, and it resets the default at the start of
// every test file, so the call below reaches only the first file of a run (measured on Bun 1.3.14). It stays for a bare
// `bun test <one file>`. Without the flag every other file has Bun's 5 s for its tests and its beforeAll, which a
// cold first router start on a CI runner does not fit in. A test that waits on a chain or the network for longer says
// so itself.
setDefaultTimeout(20_000);

// Rate limits count in fixed windows that start on the wall-clock minute (and hour). A test that fills one and expects
// the next request to be refused failed whenever its burst crossed the boundary. No test starts in the last seconds
// of a minute, so every burst lands in one window; the wait costs a few seconds per full run.
const WINDOW_GUARD_MS = 5_000;
beforeEach(async () => {
  const left = 60_000 - (Date.now() % 60_000);
  if (left < WINDOW_GUARD_MS) await Bun.sleep(left + 10);
});

// With TEST_PG_URL / TEST_REDIS_URL every harness uses that server. If it is not running, each test would retry it
// until its own timeout and the run would end in dozens of unrelated failures: stop here with one message instead.
const shown = (url: string) => {
  const u = new URL(url);
  if (u.password) u.password = "***";
  return u.toString();
};
const unreachable = (name: string, url: string, error: unknown) =>
  new Error(`${name}=${shown(url)} is not reachable (${(error as Error)?.message ?? error}). Start it (bun run services:up), or unset ${name} to run without it.`);

if (process.env.TEST_PG_URL) {
  const url = process.env.TEST_PG_URL;
  const sql = (await import("postgres")).default(url, { max: 1, connect_timeout: 5, onnotice: () => {} });
  try {
    await sql`select 1`;
  } catch (error) {
    throw unreachable("TEST_PG_URL", url, error);
  } finally {
    await sql.end({ timeout: 1 });
  }
}
if (process.env.TEST_REDIS_URL) {
  const url = process.env.TEST_REDIS_URL;
  const redis = new (await import("ioredis")).Redis(url, { lazyConnect: true, connectTimeout: 5_000, maxRetriesPerRequest: 0, retryStrategy: () => null, enableOfflineQueue: false });
  let cause: unknown;
  redis.on("error", (error) => (cause ??= error)); // the socket error, rather than "Connection is closed."
  try {
    await redis.connect();
    await redis.ping();
  } catch (error) {
    throw unreachable("TEST_REDIS_URL", url, cause ?? error);
  } finally {
    redis.disconnect();
  }
}
