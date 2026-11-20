import { depositPingNotes } from "../deposit-pings.ts"; // B123
import { fastCreditKvNotes } from "../fast-credit.ts";
import { rushKvNotes } from "../rush.ts"; // ON3
import { telegramLinkNotes } from "../telegram-linking.ts";
import { holderKvNotes } from "../holders.ts";
import type { TableDoc } from "../types.ts";
import { CREATED, JSON_FIELDS, UPDATED, rv } from "./common.ts";

// Operations: settings an account saves, and the router's own small key-value state.

export const operationTables: Record<string, TableDoc> = {
  saved_routes: {
    category: "operations",
    purpose: "A saved routing policy an account calls as @route/<slug>: ordered fallback models, provider preferences and default sampling settings. It cannot hold prompt or system-prompt text.",
    request: "no",
    retention: "Kept until the account deletes the route (DELETE /api/v1/routes/:slug).",
    columns: {
      id: "Route id.",
      account_id: "The account that owns it.",
      slug: "The name used in @route/<slug>.",
      name: "The route's display name, up to 80 characters.",
      description: {
        purpose: "A description written by the account, up to 280 characters.",
        review: rv(["name:content"], "config", "A label the owner types about the route (limited to 280 characters). It is a setting, not a request; the API cannot tell what an owner chooses to write."),
      },
      config: {
        purpose: "The route: models, provider preferences and a closed list of sampling controls (temperature, top_p, max_tokens, seed, stop sequences and similar).",
        review: rv(["type:json"], "config", "Validated by a strict schema (routeConfigSchema) that lists the allowed fields. There is no field for messages or system prompts; the only free text is up to four stop sequences of 32 characters."),
      },
      created_by: "The key that created it.",
      created_at: CREATED,
      updated_at: UPDATED,
    },
  },

  preset_versions: {
    category: "operations",
    purpose:
      "The versions of a preset an account calls as @preset/<name>[@<version>]: one row per saved version, never changed after it is written. A preset is a saved route plus the defaults a route cannot hold: a system prompt, a response_format and tool definitions the account owner writes.",
    request: "no",
    retention: "Kept until the account deletes the preset (DELETE /api/v1/presets/:name), which deletes every version.",
    columns: {
      id: "Version id.",
      account_id: "The account that owns it.",
      name: "The name used in @preset/<name>.",
      version: "The version number: 1, 2, 3, ... per preset.",
      hash: "SHA-256 of the version's canonical JSON, so two versions with the same content have the same hash.",
      config: {
        purpose: "The preset: models, provider preferences, sampling controls and, when the owner sets them, a description (up to 280 characters), a system prompt (up to 16,000 characters), a response_format and up to 32 tool definitions.",
        review: rv(
          ["type:json"],
          "config",
          "Written by the account owner through PUT /api/v1/presets/:name and validated by a strict schema (presetDocSchema) with size caps. The system prompt is text the owner saves as a setting, not text taken from a call: requests that use the preset are not stored here or anywhere else.",
        ),
      },
      source: "put for a saved change, rollback for a version restored from an earlier one.",
      restored_from: "The version a rollback copied; empty otherwise.",
      created_by: "The key that saved the version.",
      created_at: CREATED,
    },
  },

  spend_alerts: {
    category: "operations",
    purpose: "Alert rules on spend (threshold, share of a budget, anomaly, pace toward a daily line), evaluated by the spend-watch job. They read spending totals, not requests.",
    request: "no",
    retention: "Kept until the account deletes the rule (DELETE /api/v1/spend/alerts/:id).",
    columns: {
      id: "Rule id.",
      account_id: "The account.",
      key_hash: "The key the rule watches; empty means the whole account.",
      kind: "threshold, budget_pct, anomaly or pace.",
      window: "day, week or month.",
      threshold: "The spend threshold in pico-USD, for a threshold rule, or the daily line of a pace rule.",
      pct: "The budget percentage, for a budget_pct rule.",
      webhook_url_enc: {
        purpose: "The address alerts are posted to, if the owner set one. Stored encrypted with the router's APP_SECRET.",
        review: rv(["name:network"], "config", "A destination the account owner chose for alerts, stored only as ciphertext. It is not a caller's address."),
      },
      enabled: "Whether the rule is on.",
      last_fired_at: "When it last fired.",
      last_period: "The period it last fired for, so it fires at most once per period.",
      state: { purpose: "The rule's firing history and delivery status.", review: JSON_FIELDS("Firings and their delivery status written by the spend-watch job (period, amount, status, lease); it holds spend figures, never request content.") },
      created_by: "The key that created it.",
      created_at: CREATED,
    },
  },

  status_windows: {
    category: "operations",
    purpose:
      "The public status page's record of the public lane (GET /api/v1/status/slo): per API surface and five-minute bucket, how many public-lane requests succeeded, failed with a 5xx, were refused with a 4xx or were rate limited, and how many served requests fell in each fixed latency bucket. Requests on the attested and unlinkable lanes are never counted here.",
    request: "aggregate",
    retention: "Deleted after 91 days by the status loop (services/slo.ts pruneStatus).",
    columns: {
      surface: "The API surface: chat, embeddings, batch, messages, ollama or rerank.",
      bucket: "Start of the five-minute bucket (UTC).",
      ok: "Public-lane requests answered with a 2xx or 3xx.",
      failed: "Public-lane requests answered with a 5xx: these count against availability.",
      rejected: "Public-lane requests refused with a 4xx other than 429: the caller's error, not counted against availability.",
      rate_limited: "Public-lane requests refused with a 429.",
      latency: "Served public-lane requests per fixed latency bucket (the edges in lib/dpstats.ts), in edge order: time to first token for streams, time to the full response otherwise.",
    },
  },

  status_dp_hours: {
    category: "operations",
    purpose:
      "The differentially private hourly releases of the private-lane counters (the same releases GET /api/v1/stats publishes), copied as released so the status page can show 90 days for the attested and unlinkable lanes. Copying and summing released values is post-processing: it spends no privacy budget and adds nothing about any request.",
    request: "aggregate",
    retention: "Deleted after 91 days by the status loop (services/slo.ts pruneStatus).",
    columns: {
      instance: "A random id of the router process that released the hour (a new one each start), so the releases of several processes can be summed.",
      hour: "The UTC hour the release covers.",
      epsilon: "The privacy budget the release spent (the sum over its families).",
      counts: {
        purpose: "The released noisy counts: requests per lane, refusals per fixed reason and requests per fixed latency bucket.",
        review: JSON_FIELDS("Three objects of noisy integers keyed by the fixed, public label lists of lib/dpstats.ts and services/private-stats.ts, copied from a release that was already public. No request, key or time finer than the hour."),
      },
    },
  },

  status_incidents: {
    category: "operations",
    purpose:
      "Incidents on the public status page: written by the operator through the incident API, or recorded as a suggestion when a lane's availability falls below its target (a suggestion is not shown until the operator confirms it).",
    request: "no",
    retention: "No automatic deletion: the incident history is part of the public record.",
    columns: {
      id: "Incident id (inc_... for an operator's incident, sug_... for an automatic suggestion).",
      title: {
        purpose: "The incident's headline, up to 140 characters.",
        review: rv(["name:content"], "config", "Written by the operator through POST /api/v1/status/incidents (or a fixed sentence for a suggestion). It is a status notice, not a request."),
      },
      status: "suggested, investigating, identified, monitoring, resolved or dismissed.",
      impact: "none, minor, major or critical.",
      lanes: { purpose: "The privacy lanes affected.", review: JSON_FIELDS("An array of lane names from the fixed list public, attested, unlinkable.") },
      surfaces: { purpose: "The API surfaces affected; empty for all.", review: JSON_FIELDS("An array of surface names from the fixed list in services/slo.ts.") },
      source: "operator or auto.",
      updates: {
        purpose: "The status updates, oldest first: time, status and the operator's text (up to 2,000 characters each).",
        review: rv(["type:json"], "config", "Each update is a time, a status from a fixed list and text the operator writes through POST /api/v1/status/incidents/:id/updates; a suggestion's first update is a fixed sentence with numbers. No request text is ever written here."),
      },
      evidence: {
        purpose: "For an automatic suggestion: the lanes, surfaces, window, measured availability, target, request count and whether the figure was DP-noised.",
        review: JSON_FIELDS("Numbers and names from fixed lists, computed from status_windows or status_dp_hours, which are themselves sums."),
      },
      started_at: "When the incident began.",
      resolved_at: "When it was resolved.",
      created_at: CREATED,
      updated_at: UPDATED,
    },
  },

  kv: {
    category: "operations",
    purpose: "The router's small key-value store: job status, cursors, cached facts about providers, pending sign-in challenges and Telegram bot state. No request or answer text is written here.",
    request: "no",
    retention:
      "Per key family: a wallet sign-in or team challenge is deleted when used and any older than 10 minutes is deleted when the next challenge is made; a team invite is deleted when used and expired ones when the next invite is made; a Telegram user's row is deleted by /forget; other families are overwritten in place.",
    notes: [
      ...fastCreditKvNotes,
      ...depositPingNotes, // B123
      ...telegramLinkNotes,
      ...holderKvNotes, // $TRLS holder perks
      ...rushKvNotes, // ON3
      "agent-alerts:<account id>: newest 100 metadata-only owner alerts per account, visible for up to 90 days; expired feed, denial and dedupe metadata is purged on the next alert write or enabled worker cleanup, while inactive account rows remain until operator deletion; threshold cooldowns, denial counts with up to 10,000 recent timestamps and random transaction batch markers per key (10-minute rolling retention on writes/cleanup), timestamps, optional stopped_until deadline copied from the stopped policy for timed-stop alerts (also sent in webhook and Telegram delivery), key hashes, selected channels, delivery attempts, destination rule ids or Telegram ids and per-account delivery rate/lease state. No prompt, answer, intent, kill reason, webhook URL or API key is copied. Existing Spend Watch destinations are decrypted for guarded egress; existing Telegram principal links are decrypted and permission-checked before delivery. Email has no account destination. Delivery is at-least-once; a crash after sending can repeat an attempt.",
      "telegram:offset, telegram:user:<Telegram user id>: the update cursor, and per user the API key sealed under APP_SECRET, the chosen model and the private-mode switch (services/telegram.ts). Message text is not stored.",
      "wallet-login:<nonce>: a sign-in challenge (wallet address, the router's own origin, chain id, expiry and the message to sign). Deleted when used; older ones are pruned.",
      "team-invite:<sha256 of the invite>: a single-use team invite (team, role, how to join, expiry and the inviting key's hash). The invite itself is never stored. Deleted when used; expired ones are deleted when the next invite is made.",
      "team-challenge:<id>: a team join, sign-in or owner challenge (team, method, the WebAuthn challenge or the message to sign, and the wallet address when there is one). Deleted when used; older than 10 minutes are pruned.",
      "job-health:<job>, alerts:state, alerts:lease, backup:last: when each background job last ran, a fixed failure marker (operator job snapshots and queue failures redact configured private chain RPC URLs), alert state, an alert lease and the time and checksum of the last database backup.",
      "agreement-jury:heartbeat: written by the isolated agreement-jury worker each pass after its signer keys matched the DisputeOracle's jury on chain: the escrow and oracle addresses, threshold, the jury signers' public addresses and the time. GET /api/v1/status reads it to report whether automatic rulings are on. Overwritten in place; no evidence, verdict or key material.",
      "tls-pin:<provider>, aci-gateway:<provider>, aci-gpu:<model>, attest-policy:<provider>, attest-allow:<provider>, static-models-pending:<provider>, apply-token:<application id>: facts about providers (pinned certificate keys, verified gateway keysets, operator allow-lists, a pending model list, and the SHA-256 of an application token).",
      "paywith-session:<network>:<chain key hash>: a key's pay-with session (src/solana/paywith.ts): the owner's refund wallet, the token mint and symbol, the delegate (session) key's address with its secret key sealed under APP_SECRET, the per-day cap and today's spend in raw units, and whether it is open; in swig mode (PAYWITH_SESSION_MODE=swig, src/solana/swig.ts) also the owner's Swig wallet address and id, the role id and the unsigned authorise and revoke transactions handed to the owner (public instructions only, no signature). Overwritten on open and close; the sealed secret is never returned by any route or written to a log.",
      "tab-usage:<network>:<tab address>: per-tab billing state (src/solana/tab-billing.ts): payer and payee addresses, cap and expiry, the highest voucher (cumulative_used, seq, its ed25519 signature), what was served and the last request's cost in pico-USD, the request count and the close transaction once posted. Overwritten per request; no prompt or answer.",
      "hold_exceeded, hold_exceeded:<provider id>: how often a provider reported usage priced above the amount held for a call (services/hold-watch.ts, security review R3-02): a count, the total excess in pico-USD, and the time, generation id, provider id and model id of the last event. No token counts beyond that and no request content. Overwritten in place.",
      "deposit-watch:<network>:<account id>:<signature>: a deposit signature the account registered to follow (lane and submission time); at most 20 per account; deleted once the credits indexer has credited it.",
      "escrow:checkpoints, escrow-cursor:<network>:<commitment>:<mint> (the last escrow token-account signature the escrow indexer walked), spent_settled:<epoch>, margin_unsent, ipx-oracle:*: chain cursors and settlement bookkeeping. margin_unsent retains accumulated protocol margin and provider-side fees in pico-USD; settlement reports the rounded USDC amount without transferring or clearing it.",
    ],
    columns: {
      key: "The key, a family name plus an identifier (see the families above).",
      value: {
        purpose: "The value, as JSON. Its shape depends on the key family.",
        review: rv(["type:json"], "no-request-content", "Each family is written by one piece of code from ids, hashes, timestamps, amounts and settings; the families are listed under the table. None takes a value from the body of a chat, embeddings or other inference request."),
      },
      updated_at: UPDATED,
    },
  },
};
