import { expect, test } from "bun:test";
import { createHash, createPublicKey, verify as edVerify } from "node:crypto";
import { Trellis, TrellisError, base58Decode, holderVoteBody, holderVoteHeader, holderVotePath, signerFromSeed, type HolderPoll, type HolderStatus, type HolderTier, type HolderTiers, type HolderVote } from "../src/index.js";
import { json, stubFetch } from "./helpers.js";

// Addresses are stand-ins computed from repeated bytes; the signer comes from a constant seed. No network.
const SPKI = Buffer.from("302a300506032b6570032100", "hex");
const verify = (pub: Uint8Array, message: string, sig: Uint8Array) => edVerify(null, Buffer.from(message), createPublicKey({ key: Buffer.concat([SPKI, Buffer.from(pub)]), format: "der", type: "spki" }), sig);
const tier: HolderTier = { name: "Seed", min: "10000", rpm_multiplier: 2, tpm_multiplier: 2, max_agent_keys: 25, max_saved_routes: 200, max_batch_rows: null, sealed_priority: 1, early_access_hours: 12, vote_weight: 1, credits_never_expire: false, badge: true };
const tiers: HolderTiers = { enabled: true, token: { address: "mint", symbol: "TRLS", program: "token-2022" }, cache_s: 3600, tiers: [tier] };
const me: HolderStatus = { enabled: true, token: { address: "mint", symbol: "TRLS" }, wallet: "wallet", balance: "25000", balance_error: false, tier, next_tier: { name: "Vine", min: "100000", remaining: "75000" },
  perks: { limits: { rpm: 120, tpm: null, agent_keys: 25, saved_routes: 200, presets: 200, batch_rows: 1000 }, sealed_priority: 1, early_access_hours: 12, vote_weight: 1, credits_never_expire: false, badge: true } };
const poll: HolderPoll = { id: "poll_abc", kind: "model_listing", title: "Which model next?", options: ["a/one", "b/two"], status: "open", created_at: "2026-10-10T00:00:00.000Z", closes_at: null, closed_at: null, advisory: true,
  results: { options: [{ option: "a/one", votes: 1, weight: 1 }, { option: "b/two", votes: 0, weight: 0 }], total_votes: 1, total_weight: 1, final: false } };
const header = (init: RequestInit | undefined, name: string) => new Headers(init?.headers).get(name);

test("holders.tiers, me, polls and poll call the holder routes and return the router's data unchanged", async () => {
  const f = stubFetch({
    "/api/v1/holders/tiers": () => json({ data: tiers }),
    "/api/v1/holders/me": ({ init }) => { expect(header(init, "authorization")).toBe("Bearer key"); return json({ data: me }); },
    "/api/v1/holders/polls?status=open": () => json({ data: [poll] }),
    "/api/v1/holders/polls": () => json({ data: [poll, { ...poll, id: "poll_old", status: "closed" }] }),
    "/api/v1/holders/polls/poll_abc": () => json({ data: poll }),
  });
  const c = new Trellis({ baseUrl: "https://router.test", apiKey: "key", fetch: f.fetch });
  expect(await c.holders.tiers()).toEqual(tiers);
  expect(await c.holders.me()).toEqual(me);
  expect(await c.holders.polls({ status: "open" })).toEqual([poll]);
  expect((await c.holders.polls()).map((p) => p.id)).toEqual(["poll_abc", "poll_old"]);
  expect(await c.holders.poll("poll_abc")).toEqual(poll);
  expect(f.calls).toHaveLength(5);
});

test("holders.tiers reports tiers that are not switched on as the router sends them", async () => {
  const off: HolderTiers = { enabled: false, token: null, cache_s: 3600, tiers: [] };
  const c = new Trellis({ baseUrl: "https://router.test", fetch: stubFetch({ "/api/v1/holders/tiers": () => json({ data: off }) }).fetch });
  expect(await c.holders.tiers()).toEqual(off);
});

test("holders.vote signs the canonical body with the wallet and sends no API key", async () => {
  const signer = await signerFromSeed(new Uint8Array(32).fill(7));
  const vote: HolderVote = { poll_id: "poll_abc", option: "a/one", tier: "Seed", weight: 1, voted_at: "2026-10-12T12:00:00.000Z" };
  let seen: { init?: RequestInit } = {};
  const f = stubFetch({ "POST /api/v1/holders/polls/poll_abc/vote": ({ init }) => { seen = { init }; return json({ data: vote }, 201); } });
  const c = new Trellis({ baseUrl: "https://router.test", apiKey: "key", fetch: f.fetch });
  expect(await c.holders.vote("poll_abc", "a/one", signer)).toEqual(vote);
  const body = String(seen.init!.body);
  expect(body).toBe('{"option":"a/one","poll_id":"poll_abc"}');
  expect(JSON.parse(body)).toEqual(holderVoteBody("poll_abc", "a/one"));
  expect(header(seen.init, "authorization")).toBeNull();
  expect(header(seen.init, "content-type")).toBe("application/json");
  const [address, ts, sig] = header(seen.init, "x-wallet-auth")!.split(":");
  expect(base58Decode(address!)).toEqual(signer.publicKey);
  expect(Math.abs(Number(ts) - Date.now() / 1000)).toBeLessThan(5);
  const sha = createHash("sha256").update(body).digest("hex");
  // The wallet signs this one request: POST, the router's host, the vote path, the time and the body's hash.
  const message = (at: string | number, digest = sha, path = "/api/v1/holders/polls/poll_abc/vote") => `trellis:wallet-auth:v2\nPOST\nrouter.test\n${path}\n${at}\n${digest}`;
  expect(holderVotePath("poll_abc")).toBe("/api/v1/holders/polls/poll_abc/vote");
  expect(verify(signer.publicKey, message(ts!), base58Decode(sig!))).toBe(true);
  expect(verify(signer.publicKey, `trellis:${ts}:${sha}`, base58Decode(sig!))).toBe(false); // the retired v1 text
  // The standalone header helper signs the same bytes.
  const [, , fixed] = (await holderVoteHeader(signer, "router.test", "poll_abc", "a/one", 1_760_000_000)).split(":");
  expect(verify(signer.publicKey, message(1_760_000_000), base58Decode(fixed!))).toBe(true);
  expect(verify(signer.publicKey, message(1_760_000_000, createHash("sha256").update('{"option":"b/two","poll_id":"poll_abc"}').digest("hex")), base58Decode(fixed!))).toBe(false);
  // A vote signed for one poll is not a vote on another, even with the same body hash.
  expect(verify(signer.publicKey, message(1_760_000_000, sha, "/api/v1/holders/polls/poll_xyz/vote"), base58Decode(fixed!))).toBe(false);
});

test("a refused vote keeps the router's code, status and message", async () => {
  const signer = await signerFromSeed(new Uint8Array(32).fill(7));
  for (const [status, type, message] of [[403, "not_a_holder", "Voting needs a wallet that holds a tier with a vote."], [409, "already_voted", "This wallet has already voted in this poll."], [409, "poll_closed", "This poll is closed."]] as const) {
    const c = new Trellis({ baseUrl: "https://router.test", fetch: stubFetch({ "POST /api/v1/holders/polls/poll_abc/vote": () => json({ error: { code: status, type, message } }, status) }).fetch });
    const e = await c.holders.vote("poll_abc", "a/one", signer).catch((e) => e);
    expect(e).toBeInstanceOf(TrellisError);
    expect([e.status, e.code, e.message]).toEqual([status, type, message]);
  }
});
