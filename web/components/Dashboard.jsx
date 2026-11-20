"use client";
import DepositCreditStatus from './account/DepositCreditStatus'; // V97
import DepositProgress from './account/DepositProgress'; // V97B
import FundsCenter from "./funds/FundsCenter";
import DepositNextLine from './account/DepositNextLine'; // V97B
import TrackDeposit from './account/TrackDeposit'; // V97B
import { depositSender } from '../lib/deposit-progress.js'; // V97B
import AddFunds from "./account/AddFunds"; import { CLOSE_CANCEL_NOTE, CLOSE_MOVE_NOTE, CLOSE_NEEDS_WALLET, CLOSE_NOTE, CLOSE_NO_REDIRECT_NOTE, CLOSE_SIGNING_NOTE, NO_WALLET_NOTE, REVOKE_HOLDS_CLOSURE_NOTE, cancelMessage, closingMessage, closureHeldNotice, closureRefunds, closureView, releasedMessage, fundingAmount, fundingError, fundingOptions, solanaPayLink, validateDepositTransaction } from "../lib/add-funds.js"; // ON1
import PayWithSetting from "./account/PayWithSetting"; import SolanaPayCode from "./account/SolanaPayCode"; import { loadPayWith } from "../lib/pay-with.js";
import { chainOf } from "../lib/solana.js";
import { defaultFundingOption } from "../lib/funding-display.js"; // V96
import AccountStatements from "./account/AccountStatements"; import AccountExport from "./account/AccountExport"; // V87
import AccountProofPack from "./account/AccountProofPack"; // U100
import AccountLaneReport from "./account/AccountLaneReport"; // Lane report
import AccountInsights from "./account/AccountInsights"; // V88: spend insights.
import AccountInbox from "./account/AccountInbox"; // U78: account inbox.
import AccountActivity from "./account/AccountActivity";
import ReceiptExport from "./account/ReceiptExport"; // Update 15: signed receipts for a date range, as CSV or JSON.
import AccountUnusedKeys from "./account/AccountUnusedKeys"; import KeyLastUsed from "./account/KeyLastUsed.js"; // B125
import ProofBadge from "./ProofBadge"; // U76: account receipt marks.
import AccountShell from "./account/AccountShell";
import ChatPage from "./account/ChatPage"; // The Playground as a chat.
import AccountAnchors from "./account/AccountAnchors.js";
import AccountHome from "./account/AccountHome";
import { useAccountKey } from "./account/useAccountKey";
import { groupHash, sectionFromHash, sectionHash } from "./account/account-state.js";
import TelegramLink from "../app/agents/TelegramLink";
import { useEffect, useRef, useState } from "react";
import { models as sampleModels, providers as sampleProviders, initialWorkspace, storageKey, routeCall, validWorkspace, money, spendable } from "../lib/demo";
import { modelUnavailable } from "../lib/model-availability.js"; // ON5
import { earlyAccessMessage } from "../lib/holders.js"; // holder tiers: the 403 for a model still in early access.
import { API_BASE, ApiError, api, clearKey, downloadJSON, loadKey, loadWorkspace, setMode, streamChat, toCatalogModel, toProvider, toReceiptRow } from "../lib/api";
import { cancelClosure, closeCredits, connect, hasWallet, moveRefundDestination, prepareClosure, sendTransactions, shortAddress } from "../lib/wallet";
import { Button, Modal, Code, CopyButton } from "./UI";
import ModelCatalog from "./ModelCatalog";
import SavedRoutes from "./features/SavedRoutes";
import Presets from "./features/Presets";
import Characters from "./features/Characters";
import EvalLab from "./features/EvalLab";
import BatchStudio from "./features/BatchStudio";
import AgentSessions from "./features/AgentSessions";
import Teams from "./features/Teams";
import Skills from "./features/Skills";
import SpendWatch from "./features/SpendWatch";
import Tracing from "./features/Tracing";
import KeyLimits from "./limits/KeyLimits"; // U102: spending limits for any key.
import Playbooks from "./limits/Playbooks"; // U115: one rulebook many keys follow.
import { KEY_BUDGET_WORDS, topupCardText } from "../lib/spending-limits"; // U104: a key's total budget lives in its spending limits. U107: auto top-up.
// Launch surface: on a core router the non-core panels of this page are left out and their routes are not called.
import { Problem, usePart } from "./launch/Surface";
import { useUpdate } from "./media/useUpdate.js"; // release switches the router reports (GET /api/v1/status, `updates`)
import { endDateFrom, endDateText, ended, toLocalInput } from "../lib/key-end-dates.js"; // Update 16: key end dates.
import { NOT_ENABLED_MESSAGE, isNotEnabled, isNotEnabledText } from "../lib/launch-surface.js";

// Account shell: preserve feature sections and their dashboard hashes.
const tabId = sectionHash;

function Field({ label, id, children }) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children}
    </div>
  );
}

/** Decimal token amount -> raw base units (exact, no floats). */
function toRaw(amount, decimals) {
  const [whole, frac = ""] = String(amount).trim().split(".");
  if (!/^\d+$/.test(whole || "0") || !/^\d*$/.test(frac) || frac.length > decimals) throw new Error(`Use at most ${decimals} decimal places.`);
  return (BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt((frac + "0".repeat(decimals)).slice(0, decimals) || "0")).toString();
}
const fromRaw = (raw, decimals) => Number(BigInt(raw || "0")) / 10 ** decimals;

/** Settled swaps replace the accrual estimate with the exact token units and the swap transaction. */
function paidWithText(receipt, full) {
  const pw = full?.paid_with;
  if (!pw) return receipt.paidWith + (receipt.units ? " · " + receipt.units.toFixed(10) + " units" : "");
  const units = pw.raw_units ? (Number(pw.raw_units) / 10 ** (receipt.decimals ?? 18)).toFixed(10) : "0";
  return `${pw.token} · ${units} units · ${pw.status === "settled" ? "swapped in " + String(pw.swap_tx).slice(0, 12) + "…" : "accrued, swaps at the next settlement"}`;
}

// How often the router runs a periodic job, in words ("hourly", "every 2 minutes").
const cadence = (ms) => {
  if (!ms || ms === 3_600_000) return "hourly";
  if (ms % 3_600_000 === 0) return `every ${ms / 3_600_000} hours`;
  const m = Math.max(1, Math.round(ms / 60_000));
  return m === 1 ? "every minute" : `every ${m} minutes`;
};

function ReceiptDetails({ receipt, onClose, apiKey, status }) {
  const anchorEvery = cadence(status?.receipts?.anchor_interval_ms);
  const [checked, setChecked] = useState(false);
  const [full, setFull] = useState(null);
  const [verdict, setVerdict] = useState(null);
  const [error, setError] = useState("");
  const live = !!receipt.live;
  useEffect(() => {
    if (!live) return;
    api("/api/v1/generation?id=" + encodeURIComponent(receipt.id), { key: apiKey })
      .then((r) => setFull(r.data))
      .catch((e) => setError(e.message));
  }, [live, receipt.id, apiKey]);
  async function check() {
    setChecked(true);
    if (!live) return;
    if (!full) return setError("The receipt is still loading.");
    try {
      const anchor = full.anchor ? { root: full.anchor.root, proof: full.anchor.proof, index: full.anchor.index } : undefined;
      setVerdict((await api("/api/v1/receipts/verify", { method: "POST", body: { payload: full.receipt, sig: full.receipt_sig, key_id: full.receipt_key_id, anchor } })).data);
    } catch (e) {
      setError(e.message);
    }
  }
  const rows = [
    ["ID", receipt.id],
    ["Model", receipt.model],
    ["Provider", receipt.provider],
    ["Tokens", receipt.input + " input / " + receipt.output + " output"],
    ["Inference", money(receipt.inference, 8) + " USDC"],
    ["Creator royalty", money(receipt.royalty, 8) + " USDC"],
    ...(receipt.margin ? [["Per-call margin", money(receipt.margin, 8) + " USDC"]] : []),
    ["Total", money(receipt.cost, 8) + " USDC"],
    ["Paid with", paidWithText(receipt, full)],
    ["Route", live ? (receipt.private ? "Private · " + (full?.attestation_hash ? "attestation " + full.attestation_hash.slice(0, 18) + "…" : "attested provider") : "Standard") : receipt.private ? "Sample private route" : "Sample standard route"],
    ["Signature", live ? (full ? "Ed25519 · key " + full.receipt_key_id : "Loading…") : "Not connected"],
    ["Anchor", live ? (full ? (full.anchor ? `Batch #${full.anchor.index} · ${full.anchor.status}` : `Pending (anchored ${anchorEvery})`) : "Loading…") : "Not connected"],
  ];
  return (
    <Modal title="Generation receipt" onClose={onClose}>
      <span className={"badge" + (live ? " green" : "")}>{live ? (full ? (full.anchor ? "Signed · anchored" : "Signed · anchor pending") : receipt.status) : "Sample / not signed"}</span>
      <dl className="detail-list">
        {rows.map(([key, value]) => (
          <div key={key}>
            <dt>{key}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {error && (
        <Problem text={error} />
      )}
      {checked && !live && (
        <div className="note" role="status">
          This sample contains no cryptographic signature or chain anchor. Its cost components add up, but it cannot establish provider identity, attestation or settlement.
        </div>
      )}
      {checked && live && verdict && (
        <div className={verdict.valid ? "success" : "error"} role="status">
          Signature {verdict.signature_valid ? "valid" : "INVALID"} (key from {verdict.key_source === "chain" ? "the on-chain registry" : "the router"}).{" "}
          {verdict.inclusion_valid == null ? `Not anchored yet: inclusion can be checked after the next anchor (${anchorEvery}).` : verdict.inclusion_valid ? "Included under its hour's root" + (verdict.onchain_status === "verified" || (verdict.onchain_status == null && verdict.onchain_root) ? ", and the router found that root on chain." : verdict.onchain_status === "unknown" ? "; the chain was not consulted this time (try again in a minute)." : verdict.onchain_status === "not_posted" ? "; that root is not posted on chain yet." : verdict.onchain_status === "unverified" ? "; that root was NOT found on chain as an anchor (missing, late, or not the first root signed for its hour)." : ".") : "Anchor inclusion FAILED."} A valid receipt proves what the router recorded and charged; it does not by itself prove how the provider ran the model.
        </div>
      )}
      <div className="button-row">
        <Button onClick={() => downloadJSON(live ? full || receipt : receipt, receipt.id + ".json")}>Export JSON</Button>
        <Button secondary onClick={check}>
          Check proof status
        </Button>
      </div>
    </Modal>
  );
}

function ReceiptTable({ receipts, onInspect, emptyAction, live, emptyTitle, emptyText }) {
  return receipts.length ? (
    <div className="table-wrap">
      <table className="data-table">
        <thead>
          <tr>
            <th>Generation</th>
            <th>Route</th>
            <th className="num">Tokens</th>
            <th className="num">Cost / USDC</th>
            <th>Payment</th>
            <th>
              <span className="sr-only">Receipt</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {receipts.map((r, i) => (
            <tr key={r.id} style={{ "--i": Math.min(i, 12) }}>
              <td className="cell-primary">
                <strong>{r.model}</strong>
                <small>{new Date(r.time).toLocaleString("en-GB")}</small>
              </td>
              <td data-label="Route">
                <ProofBadge evidence={{ source: "generation", data: r }} /> {/* U76: private alone is not hardware evidence. */}
                <small>{r.provider}</small>
              </td>
              <td className="num" data-label="Tokens">
                {r.tokens.toLocaleString("en-US")}
              </td>
              <td className="num" data-label="Cost / USDC">
                {money(r.cost, 6)}
              </td>
              <td data-label="Payment">{r.paidWith}</td>
              <td className="cell-action">
                <button className="text-button" onClick={() => onInspect(r)} aria-label={"Inspect receipt " + r.id}>
                  Inspect →
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  ) : (
    <div className="empty">
      <h3>{emptyTitle || "No generations yet."}</h3>
      <p>{emptyText || (live ? "Your calls will appear here, each with a signed receipt." : "Your sample calls will appear here with an itemized receipt.")}</p>
      {emptyAction && <Button onClick={emptyAction}>Run your first call</Button>}
    </div>
  );
}

// U104: creates a key (with an optional starting total budget) or renames one. A live key's total budget is changed
// afterwards in its Spending limits, beside the caps. Update 16 (`endDates`): a live key's end date, set or changed here.
function KeyDialog({ existing, onSave, onClose, live, rules = true, endDates = false }) {
  const [name, setName] = useState(existing?.name || "");
  const withEnd = live && endDates;
  const [endAt, setEndAt] = useState(() => toLocalInput(existing?.expiresAt));
  const [budget, setBudget] = useState(existing?.budget == null ? (existing ? "" : "10") : String(existing.budget));
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const noun = live ? "key" : "sample key";
  const withBudget = !existing || !live;
  return (
    <Modal title={existing ? (live && !withEnd ? "Rename key" : "Edit " + noun) : "Create a " + noun} onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          const n = !withBudget || (budget === "" && live) ? null : Number(budget);
          if (!name.trim() || name.length > 60 || (n !== null && (!Number.isFinite(n) || n <= 0 || n > 100000))) {
            setError(withBudget ? "Enter a name (up to 60 characters) and a budget greater than 0, up to 100,000 USDC" + (live ? " (leave empty for no budget limit)." : ".") : "Enter a name of up to 60 characters.");
            return;
          }
          const end = withEnd ? endDateFrom(endAt, { creating: !existing }) : {};
          if (end.error) return setError(end.error);
          // An existing key's end date is sent only when it changed; a new key's only when one was set.
          const before = existing?.expiresAt ? new Date(existing.expiresAt).toISOString() : null;
          const endValue = !withEnd ? {} : existing ? (end.expires_at !== before ? { expires_at: end.expires_at } : {}) : end.expires_at ? { expires_at: end.expires_at } : {};
          setBusy(true);
          try {
            await onSave({ ...(withBudget ? { name: name.trim(), budget: n } : { name: name.trim() }), ...endValue });
          } catch (err) {
            setError(err.message);
            setBusy(false);
          }
        }}
      >
        {error && (
          <Problem text={error} />
        )}
        <Field label="Key name" id="key-name">
          <input id="key-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} required placeholder="e.g. Research agent" autoFocus />
        </Field>
        {withBudget && (
          <Field label={live ? KEY_BUDGET_WORDS.label : "Total sample budget / USDC"} id="key-budget">
            <input id="key-budget" type="number" min="0.000001" max="100000" step="any" value={budget} onChange={(e) => setBudget(e.target.value)} required={!live} placeholder={live ? "No total budget" : undefined} />
          </Field>
        )}
        {withEnd && (
          <Field label="End date (optional)" id="key-end">
            <input id="key-end" type="datetime-local" value={endAt} onChange={(e) => setEndAt(e.target.value)} />
            <span className="help-text">After this moment the router refuses the key. Leave it empty for no end date{existing ? "; a past time ends the key now" : ""}. In your own time zone.</span>
          </Field>
        )}
        <div className="note">
          {live
            ? (existing ? "" : "Sub-keys share this workspace’s USDC balance and stop at their own budget. The secret is shown once; the router stores only its hash. ") + `Change a key’s total budget${rules ? " and caps" : ""} in its Spending limits.`
            : "Sample keys work only in this browser preview. They cannot authenticate with an API."}
        </div>
        <Button type="submit" disabled={busy}>
          {busy ? "Saving…" : existing ? "Save changes" : "Create " + noun}
        </Button>
      </form>
    </Modal>
  );
}

function SecretDialog({ secret, deposit, onClose, title = "Your new API key" }) {
  return (
    <Modal title={title} onClose={onClose}>
      <p>Copy this key now. It is shown once; the router stores only its hash.</p>
      <Code label="API key">{secret}</Code>
      {deposit?.key_hash && (
        <dl className="detail-list">
          <div>
            <dt>Deposit to</dt>
            <dd className="mono">{deposit.key_hash}</dd>
          </div>
          <div>
            <dt>Credits program</dt>
            <dd className="mono">{deposit.credits_program || deposit.credits_contract || "Not configured on this router"}</dd>
          </div>
        </dl>
      )}
      <div className="button-row modal-actions">
        <Button onClick={onClose}>I saved it</Button>
      </div>
    </Modal>
  );
}

function DepositDialog({ onClose, apiKey, credits, status, onDone }) {
  const [amount, setAmount] = useState("10");
  const [step, setStep] = useState("");
  const [error, setError] = useState("");
  const [wallet, setWallet] = useState(false);
  useEffect(() => setWallet(hasWallet()), []);
  const chain = chainOf(status);
  const [option] = fundingOptions({ credits, chain: status?.chain });
  const deposit = credits?.deposit || {};
  const payLink = option ? solanaPayLink(option, amount) : null;
  return (
    <Modal title="Deposit USDC" onClose={onClose}>
      <p>Add USDC to this key’s credit account on {chain.name}. Prepaid calls carry a 0% router fee. Credits are spend-only: they are not withdrawn, only spent or refunded when the account is closed.</p>
      {error && (
        <Problem text={error} />
      )}
      {step && (
        <div className="success" role="status">
          {step}
        </div>
      )}
      <Field label="Amount / USDC" id="deposit-amount">
        <input id="deposit-amount" type="number" min="0.000001" step="any" value={amount} onChange={(e) => setAmount(e.target.value)} disabled={!!step} />
      </Field>
      <dl className="detail-list">
        <div>
          <dt>Key hash</dt>
          <dd className="mono">{deposit.key_hash}</dd>
        </div>
        <div>
          <dt>Credits program</dt>
          <dd className="mono">{deposit.credits_program || deposit.credits_contract || "Not configured on this router"}</dd>
        </div>
        <div>
          <dt>USDC mint</dt>
          <dd className="mono">{deposit.token}</dd>
        </div>
        {deposit.cap_usdc != null && (
          <div>
            <dt>Cap per key</dt>
            <dd>{deposit.cap_usdc} USDC</dd>
          </div>
        )}
      </dl>
      <div className="button-row modal-actions">
        <Button
          disabled={!!step || !option}
          onClick={async () => {
            setError("");
            try {
              const raw = fundingAmount(amount, option);
              const from = await connect();
              const tx = (await api("/api/v1/credits/deposit-tx", { key: apiKey, method: "POST", body: { amount: amount.trim(), payer: from } })).data;
              await sendTransactions(from, validateDepositTransaction(tx, option, raw), depositSender(apiKey, "usdc", setStep), { network: chain.network }); // V97B
              setStep("Deposited. Waiting for the router to index it…");
              await onDone(Number(amount));
            } catch (e) {
              setError(e?.message || String(e));
              setStep("");
            }
          }}
        >
          {wallet ? "Deposit with wallet" : "Connect a Solana wallet"}
        </Button>
        <CopyButton text={deposit.key_hash || ""} label="Copy key hash" />
      </div>
      <DepositNextLine info={credits} lane="usdc"/><DepositProgress apiKey={apiKey}/> {/* V97B */}
      {payLink ? <SolanaPayCode url={payLink} /> : <p className="help-text">{NO_WALLET_NOTE}</p>}
      <TrackDeposit apiKey={apiKey} lane="usdc"/> {/* V97B */}
      {status?.dev_faucet && (
        <>
          <div className="note">Development chain: add sample USDC to this key without a wallet. It has no value and exists only on this machine’s chain.</div>
          <div className="button-row modal-actions">
            <Button
              secondary
              disabled={!!step}
              onClick={async () => {
                setError("");
                try {
                  if (!/^\d+(\.\d{1,6})?$/.test(amount) || Number(amount) <= 0 || Number(amount) > 1000) throw new Error("Enter up to 1000 test USDC.");
                  setStep("Minting and depositing test USDC…");
                  await api("/api/v1/dev/faucet", { key: apiKey, method: "POST", body: { amount } });
                  await onDone(Number(amount), "test");
                } catch (e) {
                  setError(e?.message || String(e));
                  setStep("");
                }
              }}
            >
              Add {/^\d+(\.\d{1,6})?$/.test(amount) ? amount : "10"} test USDC
            </Button>
          </div>
        </>
      )}
    </Modal>
  );
}

/** Who a closure pays back: one line per wallet that paid in, with the account its share goes to. */
function RefundList({ refunds }) {
  if (!refunds?.length) return null;
  return (
    <ul className="refund-list" aria-label="Where the refund goes">
      {refunds.map((r) => (
        <li key={r.depositor}>
          Wallet <span className="mono" title={r.depositor}>{shortAddress(r.depositor)}</span> {r.text}
          {r.moved ? <> · sent to wallet <span className="mono" title={r.owner}>{shortAddress(r.owner)}</span>, as that wallet asked</> : <> · back to the account it paid from</>} (<span className="mono" title={r.account}>{shortAddress(r.account)}</span>)
        </li>
      ))}
    </ul>
  );
}

/**
 * Close the account: the only customer-initiated outflow (docs/Trellis_Backend.md §5.1). Queues a refund; never pays on
 * demand. The closure is authorised by the key itself: the router returns the close_account transaction already signed
 * by the key (it signs from the key this page sends, and keeps neither), and the connected wallet adds its signature as
 * fee payer and sends it (lib/wallet.js closeCredits). Any wallet can pay the fee; depositing gave no wallet power here.
 *
 * Nobody types a destination (security re-review RR-05): what is left goes back to the wallets that paid in, and the
 * dialog shows that list (the router's `refunds`) before a wallet opens. While the waiting period runs the closure can
 * be taken back; a closure whose key was disabled is on hold until an owner releases it.
 */
function CloseAccountDialog({ onClose, apiKey, credits, chain, onDone }) {
  const [rows, setRows] = useState(null);
  const [review, setReview] = useState(null); // the router's answer to a closure request that has not been sent yet
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [step, setStep] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [moveTo, setMoveTo] = useState("");
  const reload = () =>
    api("/api/v1/credits/close", { key: apiKey })
      .then((r) => setRows(r.data || []))
      .catch(() => setRows([]));
  useEffect(() => {
    reload();
  }, [apiKey]);
  const views = (rows || []).map(closureView);
  const open = views.find((c) => c.open);
  const onChain = open && !open.canSend; // registered: the key is frozen and the waiting period runs
  const declined = (e) => e?.code === 4001 || /user (rejected|denied)/i.test(String(e?.message));
  const run = async (work, declinedText) => {
    setError("");
    setBusy(true);
    try {
      await work();
    } catch (e) {
      setStep("");
      setError(declined(e) ? declinedText : cancelMessage(e) || e?.message || String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="Close account and get your balance back" onClose={onClose}>
      <p>{CLOSE_NOTE}</p>
      <p className="help-text">{CLOSE_NO_REDIRECT_NOTE}</p>
      {error && (
        <Problem text={error} />
      )}
      {step && (
        <div className="success" role="status">
          {step}
        </div>
      )}
      {rows === null && <p className="help-text">Reading earlier closure requests…</p>}
      {onChain && (
        <div className="note">
          <strong>{open.status}.</strong> {open.detail}
          <RefundList refunds={open.refunds} />
          {open.canCancel && (
            <>
              <p className="help-text">{CLOSE_CANCEL_NOTE}</p>
              <div className="button-row">
                <Button
                  secondary
                  disabled={busy || !hasWallet()}
                  onClick={() =>
                    run(async () => {
                      const { sent } = await cancelClosure({ apiKey, network: chain?.network, onStep: (text) => setStep(text) });
                      setStep(`Closure ${open.id} taken back (transaction ${sent[0]}). The key opens again with its balance once this is on chain.`);
                      await reload();
                      await onDone?.();
                    }, "You declined it in your wallet. Nothing was sent, and the closure stands.")
                  }
                >
                  Take the closure back
                </Button>
              </div>
            </>
          )}
        </div>
      )}
      {rows !== null && !onChain && (
        <>
          <p>
            Unspent balance: <strong>{spendable(credits?.available ?? 0, 4)} USDC</strong>
            {credits?.held ? ` (plus ${money(credits.held, 6)} held for calls in progress)` : ""}. After the closure is on chain the key stops spending, and what is left is paid back to the wallets that paid in.
          </p>
          {open?.canSend && <div className="note">{open.detail}</div>}
          {!review && (
            <div className="button-row modal-actions">
              <Button
                secondary
                disabled={busy || !hasWallet()}
                onClick={() =>
                  run(async () => {
                    // Asking shows who is paid back. Nothing is sent, and the key keeps working, until the wallet signs.
                    const { closure } = await prepareClosure({ apiKey });
                    setReview(closure);
                    setConfirm(false);
                    await reload();
                  }, "You declined to connect your wallet. Nothing was sent.")
                }
              >
                Show where the refund goes
              </Button>
            </div>
          )}
          {review && (
            <>
              <h3>Where the refund goes</h3>
              {closureRefunds(review).length ? (
                <RefundList refunds={closureRefunds(review)} />
              ) : (
                <p className="help-text">The router has not listed the wallets that paid into this key yet. Nothing is paid until it has, and only to those wallets.</p>
              )}
              <div className="button-row modal-actions">
                <label className="check-label">
                  <input type="checkbox" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} disabled={busy} /> I understand the refund goes to the wallets above after at least 72 hours, and this key stops spending.
                </label>
                <Button
                  disabled={busy || !confirm || !hasWallet()}
                  onClick={() =>
                    run(async () => {
                      // A fresh transaction (the reviewed one may have expired); it is sent only if it still pays the wallets shown.
                      const { closure: r, sent } = await closeCredits({ apiKey, reviewed: review.refunds, network: chain?.network, onStep: (text) => setStep(text) });
                      setStep(sent.length ? `Closure ${r.id} sent (transaction ${sent[0]}). This key stops spending once it is on chain. You can take the closure back until the refund starts being paid.` : `Closure ${r.id} is already on chain.`);
                      setReview(null);
                      await reload();
                      await onDone?.();
                    }, "You declined it in your wallet. Nothing was sent, and the key keeps working.")
                  }
                >
                  Close account and send the refund home
                </Button>
              </div>
            </>
          )}
          <p className="help-text">{hasWallet() ? CLOSE_SIGNING_NOTE : CLOSE_NEEDS_WALLET}</p>
        </>
      )}
      <details className="refund-move">
        <summary>Paid in from a wallet you no longer want the refund in?</summary>
        <p className="help-text">{CLOSE_MOVE_NOTE}</p>
        <Field label="Wallet that should receive the connected wallet’s share" id="refund-move-to">
          <input id="refund-move-to" className="mono" value={moveTo} onChange={(e) => setMoveTo(e.target.value.trim())} placeholder="base58 address" disabled={busy} spellCheck={false} autoComplete="off" />
        </Field>
        <div className="button-row">
          <Button
            secondary
            disabled={busy || !hasWallet() || !moveTo}
            onClick={() =>
              run(async () => {
                const { depositor, sent } = await moveRefundDestination({ apiKey, refundTo: moveTo, network: chain?.network, onStep: (text) => setStep(text) });
                setStep(`Wallet ${shortAddress(depositor)} asked for its share of a refund from this key to go to ${shortAddress(moveTo)} (transaction ${sent[0]}). No money moved.`);
                setReview(null);
              }, "You declined it in your wallet. Nothing changed.")
            }
          >
            Sign with the wallet that paid in
          </Button>
        </div>
      </details>
      {views.length > 0 && (
        <dl className="detail-list">
          {views.map((c) => (
            <div key={c.id}>
              <dt>{c.status}</dt>
              <dd>
                <span className="mono">{c.id}</span>
                {c.amountUnits ? ` · ${money(fromRaw(c.amountUnits, 6), 2)} USDC` : ""}
                {c.paidTo.length > 0 && (
                  <>
                    {" "}· paid to{" "}
                    {c.paidTo.map((w, i) => (
                      <span key={w}>
                        {i ? ", " : ""}
                        <span className="mono" title={w}>{shortAddress(w)}</span>
                      </span>
                    ))}
                  </>
                )}{" "}
                {c.detail}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </Modal>
  );
}

export default function Dashboard() {
  // ---- mode & connection ----
  const [mode, setModeState] = useState(null); // "live" | "demo"
  const [connection, setConnection] = useState("checking"); // checking | ok | unreachable
  const [status, setStatus] = useState(null);
  const [apiKey, setApiKey] = useAccountKey();
  const [ws, setWs] = useState(null); // live workspace
  const [secrets, setSecrets] = useState({}); // key hash -> secret, for keys created in this session
  const [catalog, setCatalog] = useState([]);
  const [liveProviders, setLiveProviders] = useState(null);
  const [payWithTick, setPayWithTick] = useState(0); // bumps when the pay-with preference of a key changes
  const [reveal, setReveal] = useState(null);
  // ---- sample workspace (explicit demo mode) ----
  const [state, setState] = useState(initialWorkspace);
  const [loaded, setLoaded] = useState(false);
  const [storageError, setStorageError] = useState("");
  // ---- shared UI ----
  const [tab, setTab] = useState("Home");
  const shownTab = useRef(""); shownTab.current = tab;
  const [modal, setModal] = useState(null);
  const [notice, setNotice] = useState("");
  const [modelId, setModelId] = useState(sampleModels[0].id);
  const [prompt, setPrompt] = useState("Explain how a generation receipt makes AI usage easier to audit.");
  const [privateRoute, setPrivate] = useState(false);
  const [payWith, setPayWith] = useState("USDC");
  const [keyId, setKeyId] = useState("key_seed");
  const [forceFailure, setForceFailure] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [errorKind, setErrorKind] = useState("");
  const [result, setResult] = useState(null);
  const [streamText, setStreamText] = useState("");
  const [receiptQuery, setReceiptQuery] = useState("");
  const [receiptMode, setReceiptMode] = useState("All");
  const lock = useRef(false);
  const timer = useRef(null);
  const abort = useRef(null);
  const sectionRef = useRef(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const live = mode === "live";
  // Launch surface (lib/launch-surface.js): each is true only once the router has said it serves more than core.
  const payWithOn = usePart("part", "pay-with"), tracingOn = usePart("part", "tracing"), telegramOn = usePart("part", "telegram"), rulesOn = usePart("part", "agents"), topupOn = usePart("part", "key-topup");
  const endDatesOn = useUpdate("key-end-dates")?.on === true; // Update 16: shown only where the router released key end dates.
  const exportOn = usePart("section", "account-export");
  // U106: ⌘K's New API key links to /dashboard/?new=key#api-keys; Create key opens once a key is connected.
  useEffect(() => {
    if (!live || !apiKey || !ws || new URLSearchParams(window.location.search).get("new") !== "key") return;
    const url = new URL(window.location.href);
    url.searchParams.delete("new");
    window.history.replaceState(null, "", url.pathname + url.search + url.hash);
    setModal({ type: "key" });
  }, [live, apiKey, ws]);

  async function refresh(key = apiKey) {
    const next = await loadWorkspace(key);
    setWs(next);
    return next;
  }
  async function signInWith(key, remember) {
    const next = await loadWorkspace(key);
    setApiKey(key);
    setWs(next);
    setKeyId(next.me.hash);
    setSecrets((s) => ({ ...s, [next.me.hash]: key }));
    setNotice("Connected with " + next.me.label + ".");
  }
  async function connectLive() {
    setConnection("checking");
    try {
      const s = await api("/api/v1/status");
      setStatus(s.data);
      setConnection("ok");
      api("/api/v1/models").then((r) => setCatalog(r.data.map(toCatalogModel))).catch(() => setCatalog([]));
      const stored = loadKey();
      if (stored) {
        try {
          const next = await loadWorkspace(stored);
          if (loadKey() !== stored) return;
          setApiKey(stored);
          setWs(next);
          setKeyId(next.me.hash);
          setSecrets((x) => ({ ...x, [next.me.hash]: stored }));
        } catch (e) {
          if (e instanceof ApiError && (e.status === 401 || e.status === 403) && loadKey() === stored) setApiKey("");
          else setError(e.message);
        }
      }
    } catch {
      setConnection("unreachable");
    }
  }

  useEffect(() => {
    const m = "live";
    setModeState(m);
    if (m === "live") connectLive().finally(() => setLoaded(true));
    else {
      try {
        const saved = localStorage.getItem(storageKey);
        if (saved) {
          const parsed = JSON.parse(saved);
          if (validWorkspace(parsed)) {
            setState(parsed);
            setKeyId(parsed.keys.find((k) => k.active)?.id || "");
          } else setStorageError("The saved workspace could not be read. A fresh in-memory sample is open; reset it in Settings to resume saving.");
        }
      } catch {
        setStorageError("Browser storage is unavailable or contains unreadable data. Changes will stay in memory for this visit.");
      }
      setLoaded(true);
    }
    const selectHash = () => {
      const next = sectionFromHash(window.location.hash);
      // U104: a tab id (#keys) opens that tab's first section, shown under the section's own hash.
      if (groupHash(window.location.hash.slice(1)) && window.location.hash !== "#" + tabId(next)) window.history.replaceState(null, "", "#" + tabId(next));
      // A notice belongs to the section that raised it; following a link to another section must not carry it along.
      if (shownTab.current && shownTab.current !== next) setNotice("");
      setTab(next);
    };
    selectHash();
    const model = new URLSearchParams(window.location.search).get("model");
    if (model) setModelId(model);
    window.addEventListener("hashchange", selectHash);
    return () => {
      window.removeEventListener("hashchange", selectHash);
      clearTimeout(timer.current);
      abort.current?.abort();
    };
  }, []);
  useEffect(() => {
    if (mode !== "demo" || !loaded || storageError) return;
    try {
      localStorage.setItem(storageKey, JSON.stringify(state));
    } catch {
      setStorageError("This browser could not save the workspace. Changes remain available for this visit.");
    }
  }, [state, loaded, storageError, mode]);
  useEffect(() => {
    if (live && connection === "ok" && tab === "Providers" && !liveProviders)
      api("/api/v1/providers")
        .then((r) => setLiveProviders(r.data.map(toProvider)))
        .catch((e) => setError(e.message));
  }, [live, connection, tab, liveProviders]);
  useEffect(() => {
    if (live && catalog.length && !catalog.some((m) => m.id === modelId)) setModelId(catalog.find((m) => m.type !== "Embeddings")?.id || catalog[0].id);
  }, [live, catalog, modelId]);
  // Hash links select a workspace section and move assistive-technology focus
  // once its content is ready, including on direct links and browser Back/Forward.
  useEffect(() => {
    if (loaded && window.location.hash === "#" + tabId(tab)) {
      const frame = requestAnimationFrame(() => sectionRef.current?.focus({ preventScroll: true }));
      return () => cancelAnimationFrame(frame);
    }
  }, [tab, loaded]);

  function switchMode(next) {
    setMode(next);
    window.location.reload();
  }
  function navigate(next) {
    window.location.hash = tabId(next);
    setTab(next);
    setNotice("");
    setError("");
  }
  function update(fn) {
    setState((previous) => {
      const next = fn(previous);
      stateRef.current = next;
      return next;
    });
  }

  // ---- normalized view (same shapes for both workspaces) ----
  const decimalsOf = (sym) => ws?.tokens?.find((t) => t.symbol === sym)?.decimals ?? 18;
  const liveKeys = (ws?.keys || []).map((k) => ({
    id: k.hash,
    name: k.name || k.label,
    token: k.label,
    budget: k.limit,
    reset: k.limit_reset ?? null,
    topup: k.topup ?? null,
    spent: k.usage_period ?? k.usage ?? 0,
    active: !k.disabled,
    chainKeyHash: k.chain_key_hash,
    expiresAt: k.expires_at ?? null, // update 16
    current: k.hash === ws?.me?.hash,
    secret: secrets[k.hash],
  }));
  const liveSession = ws?.session
    ? {
        id: "session",
        token: ws.session.symbol,
        cap: fromRaw(ws.session.cap_raw_per_day, ws.session.decimals),
        spent: fromRaw(ws.session.spent_raw_today, ws.session.decimals),
        active: ws.session.active && ws.session.pay_with_default === ws.session.symbol,
        open: ws.session.active,
        wallet: ws.session.wallet,
        debt: ws.session.open_debt_usd,
        decimals: ws.session.decimals,
        allowance: ws.session.allowance,
        awaiting: ws.session.charges_awaiting_signature ?? 0,
        day: new Date().toISOString().slice(0, 10),
      }
    : null;
  const view = live
    ? { balance: ws?.credits?.available ?? 0, keys: liveKeys, sessions: liveSession ? [liveSession] : [], receipts: ws?.receipts || [] }
    : { balance: state.balance, keys: state.keys, sessions: state.sessions, receipts: state.receipts };
  const playModels = live ? catalog.filter((m) => m.type !== "Embeddings") : sampleModels;
  const payWithMint = live && keyId && payWithOn && payWithTick >= 0 ? loadPayWith(keyId) : ""; // the X-Pay-With mint kept in this browser for the selected key
  const walletPayment = live && payWith === "USDC per message";
  const payOptions = ["USDC", ...(live ? ["USDC per message"] : []), ...(payWithMint ? [payWithMint] : [])];
  const providerRows = live ? liveProviders || [] : sampleProviders;
  const signedIn = !live || (!!apiKey && !!ws);

  // ---- actions ----
  function run(e) {
    e.preventDefault();
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    setResult(null);
    setStreamText("");
    if (!live) {
      const args = { modelId, prompt, privateRoute, payWith, keyId, forceFailure };
      timer.current = setTimeout(() => {
        try {
          const outcome = routeCall({ state: stateRef.current, ...args });
          stateRef.current = outcome.state;
          setState(outcome.state);
          setResult(outcome.receipt);
          setNotice("Sample call completed. Its receipt is ready.");
        } catch (err) {
          setError(err.message);
        } finally {
          lock.current = false;
          setBusy(false);
        }
      }, 750);
      return;
    }
    const k = view.keys.find((x) => x.id === keyId);
    const ctl = new AbortController();
    abort.current = ctl;
    setErrorKind("");
    (async () => {
      try {
        if (!walletPayment && !k?.secret) throw new Error("Choose a key whose secret is available in this browser (your signed-in key or one created this session).");
        if (modelUnavailable(catalog.find(m => m.id === modelId))) throw new Error("This model is temporarily unavailable. Choose another model."); // ON5
        if (!prompt.trim()) throw new Error("Enter a prompt before routing a call.");
        const out = await streamChat({ walletPayment, key: walletPayment ? undefined : k.secret, body: liveRequest.body, headers: liveRequest.headers, signal: ctl.signal, onDelta: setStreamText });
        const g = walletPayment ? { id: out.id, mode: "per_call", model: out.model, provider_name: out.provider, tokens_prompt: out.usage?.prompt_tokens, tokens_completion: out.usage?.completion_tokens, total_cost: out.usage?.cost, receipt_key_id: out.receipt?.key_id, created_at: new Date().toISOString() } : (await api("/api/v1/generation?id=" + encodeURIComponent(out.id), { key: k.secret })).data;
        setResult({ ...toReceiptRow({ ...g, anchored: !!g.anchor, created_at: g.created_at }, ws?.tokens), text: out.text });
        setNotice(out.error ? "The provider stopped mid-stream; the delivered part was billed. Its receipt is ready." : "Call completed. Its signed receipt is ready.");
        refresh().catch(() => {});
      } catch (err) {
        if (err?.name === "AbortError") return;
        const hint = err?.metadata?.pay_with ? " (" + err.metadata.pay_with + ")" : "";
        setErrorKind(!walletPayment && fundingError(err) ? "insufficient_credits" : err?.type || ""); // ON1
        setError(earlyAccessMessage(err) || err.message + hint);
        // 404 not_enabled on the chat route: the router's own sentence says what it refused (a key setting, a header).
        if (isNotEnabled(err)) setError(NOT_ENABLED_MESSAGE + (err.detail ? " " + err.detail : ""));
        if (closingMessage(err)) setError(closingMessage(err)); // 409 credits_closing: the key is frozen while its closure is paid; adding funds does not help
      } finally {
        lock.current = false;
        setBusy(false);
      }
    })();
  }
  function cancel() {
    if (!live) {
      clearTimeout(timer.current);
      lock.current = false;
      setBusy(false);
      setError("Sample request cancelled. No balance or budget was spent.");
      return;
    }
    abort.current?.abort();
    lock.current = false;
    setBusy(false);
    setError("Request cancelled. Anything the provider already generated is billed and appears in Receipts.");
    setTimeout(() => refresh().catch(() => {}), 1500);
  }
  async function saveKeyValues(values) {
    if (!live) {
      if (modal.data) update((s) => ({ ...s, keys: s.keys.map((k) => (k.id === modal.data.id ? { ...k, ...values } : k)) }));
      else {
        const id = crypto.randomUUID();
        update((s) => ({ ...s, keys: [...s.keys, { ...values, id, token: "demo_key_" + id.replaceAll("-", "").slice(0, 20), spent: 0, active: true }] }));
        setKeyId(id);
      }
      setNotice(modal.data ? "Sample key updated." : "Sample key created. It is not a production credential.");
      setModal(null);
      return;
    }
    if (modal.data) {
      await api("/api/v1/keys/" + modal.data.id, { key: apiKey, method: "PATCH", body: { name: values.name, ...(values.expires_at !== undefined ? { expires_at: values.expires_at } : {}) } }); // U104: the budget saves in Spending limits.
      setNotice(values.expires_at !== undefined ? "Key saved." : "Key renamed.");
    } else {
      const r = await api("/api/v1/keys", { key: apiKey, method: "POST", body: { name: values.name, limit: values.budget, ...(values.expires_at ? { expires_at: values.expires_at } : {}) } });
      setSecrets((s) => ({ ...s, [r.data.hash]: r.key }));
      setReveal({ secret: r.key, deposit: r.deposit });
      setNotice("Key created. Copy its secret now; it is shown once.");
    }
    setModal(null);
    await refresh();
  }
  // Pay-with-stock sessions are Swig session keys opened from the SDKs; the dashboard only keeps the X-Pay-With preference (PayWithSetting).
  async function confirmAction() {
    if (modal.type === "reset") {
      if (live) {
        clearKey();
        setApiKey("");
        setWs(null);
        setSecrets({});
        setResult(null);
        setNotice("Signed out of this browser. Your key and balance are unchanged.");
      } else {
        setState(structuredClone(initialWorkspace));
        setStorageError("");
        setResult(null);
        setKeyId("key_seed");
        setPayWith("USDC");
        setNotice("Sample workspace reset.");
      }
    } else if (modal.type === "revoke") {
      if (live) {
        const gone = await api("/api/v1/keys/" + modal.data.id, { key: apiKey, method: "DELETE" });
        await refresh();
        // Revoking a key stops a closure it started: the refund is held until an owner or admin releases it.
        const held = closureHeldNotice(gone?.data);
        setNotice("Key revoked. It stops working immediately." + (held ? " " + held.text : ""));
      } else {
        update((s) => ({ ...s, keys: s.keys.map((k) => (k.id === modal.data.id ? { ...k, active: false } : k)) }));
        setNotice("Sample key revoked.");
      }
    }
    setModal(null);
  }

  const filtered = view.receipts.filter(
    (r) => (r.id + " " + r.model + " " + r.provider).toLowerCase().includes(receiptQuery.toLowerCase()) && (receiptMode === "All" || (receiptMode === "Private" ? r.private : !r.private)),
  );
  const sampleRequest = {
    model: modelId,
    messages: [{ role: "user", content: prompt }],
    provider: { private: privateRoute, allow_fallbacks: true },
    ...(payWith !== "USDC" ? { headers: { "X-Pay-With": payWith } } : {}),
  };
  const liveRequest = {
    headers: !walletPayment && payWith !== "USDC" ? { "X-Pay-With": payWith } : {},
    body: { model: modelId, messages: [{ role: "user", content: prompt }], max_tokens: 512, provider: { ...(privateRoute ? { private: true } : {}), allow_fallbacks: !forceFailure } },
  };
  const origin = typeof window !== "undefined" ? API_BASE || window.location.origin : "";
  const currentKey = liveKeys.find((k) => k.current);
  // Until the mode is read from the URL and storage, label nothing as live or sample.
  const booting = mode === null;
  const workspaceState = booting ? "loading" : !live ? "demo" : connection;

  return (
    <main className="dashboard-main" id="content" data-workspace={workspaceState}>
      <AccountAnchors/>
      <AccountShell app current={tab} apiKey={signedIn ? apiKey : ""} onConnect={signInWith} onNavigate={navigate} publicContent={tab === "Teams" && typeof window !== "undefined" && new URLSearchParams(window.location.search).has("join")}
        onDisconnect={() => { clearKey(); setApiKey(""); setWs(null); setSecrets({}); setResult(null); setModal(null); setError(""); setNotice(""); abort.current?.abort(); }}>
      <section ref={sectionRef} className="dashboard-section" tabIndex={-1} aria-label={`${tab} workspace section`}>
      {storageError && (
        <div className="error" role="alert">
          {storageError}
        </div>
      )}
      {notice && (
        <div className="success" role="status">
          {notice}
        </div>
      )}
      {error && ["Saved Routes", "Presets", "Characters", "Eval Lab", "Batch Studio", "Agent Sessions", "Spend Watch"].includes(tab) && (
        <Problem text={error} />
      )}
      {!loaded ? (
        <div className="empty loading-state" role="status">
          <span className="loading-bar" aria-hidden="true" />
          Connecting to Trellis…
        </div>
      ) : live && connection === "unreachable" ? (
        <section className="router-status dark" aria-labelledby="router-status-title">
          <span className="empty-grid" aria-hidden="true" />
          <div className="router-status-head">
            <span className="status-dot" aria-hidden="true" />
            <span>No response</span>
            <code>GET {origin || ""}/api/v1/status</code>
          </div>
          <h2 id="router-status-title">The Trellis API is not reachable.</h2>
          <p>
            Tried {origin || "this site"}/api/v1. Your balance and receipts are safe; this page just cannot reach the router right now. No account data is shown while the router is unreachable.
          </p>
          <div className="button-row">
            <Button light onClick={() => connectLive()}>
              Retry
            </Button>

          </div>
        </section>
      ) : live && !signedIn && tab !== "Teams" ? null : (
        <div className="tab-panel" key={tab}>
          {tab === "Statements" && apiKey && <AccountStatements key={apiKey} apiKey={apiKey}/>} {tab === "Export your data" && apiKey && <AccountExport key={apiKey} apiKey={apiKey}/>} {/* V87 */}
          {tab === "Statements" && apiKey && <AccountLaneReport key={`lane-report-${apiKey}`} apiKey={apiKey}/>} {/* Lane report */}
          {tab === "Statements" && apiKey && <AccountProofPack key={`proof-pack-${apiKey}`} apiKey={apiKey}/>} {/* U100 */}
          {tab === "Insights" && signedIn && <AccountInsights key={apiKey} apiKey={apiKey}/>} {/* V88: no figures before connection. */}
          {tab === "Inbox" && apiKey && <AccountInbox key={apiKey} apiKey={apiKey}/>}
          {tab === "Playbooks" && <Playbooks key={apiKey} live={live && signedIn} apiKey={apiKey}/>} {/* U115 */}
          {tab === "Activity" && ws && <AccountActivity apiKey={apiKey} keys={ws.keys}/>}
          {tab === "Home" && ws && <AccountHome apiKey={apiKey} workspace={ws} onRefresh={() => refresh()} onReceipt={receipt => setModal({ type: "receipt", data: receipt })}/>}
          {tab === "Playground" && (
            <ChatPage live={live} busy={busy} prompt={prompt} setPrompt={setPrompt} modelId={modelId} setModelId={setModelId}
              modelLabel={(() => { const m = playModels.find((x) => x.id === modelId); return m ? (live ? m.id : m.name) : modelId; })()}
              modelOptions={playModels.map((m) => (
                <option key={m.id} value={m.id} disabled={modelUnavailable(m)}>
                  {live ? m.id + (modelUnavailable(m) ? " · temporarily unavailable" : "") : m.name}
                </option>
              ))}
              keyId={keyId} setKeyId={setKeyId}
              keyOptions={view.keys.filter((k) => k.active && (!live || k.secret)).map((k) => <option key={k.id} value={k.id}>{k.name}</option>)}
              showPayWith payWith={payWith} setPayWith={setPayWith} payOptions={payOptions}
              privateRoute={privateRoute} setPrivate={setPrivate} forceFailure={forceFailure} setForceFailure={setForceFailure}
              onRun={run} onCancel={cancel} streamText={streamText} result={result} money={money}
              request={live
                ? JSON.stringify({ url: origin + "/api/v1/chat/completions", headers: { Authorization: "Bearer " + (view.keys.find((k) => k.id === keyId)?.token || "sk-tr-v1-…"), ...liveRequest.headers }, body: liveRequest.body }, null, 2)
                : JSON.stringify(sampleRequest, null, 2)}
              onReceipt={(data) => setModal({ type: "receipt", data })}
              funding={live && errorKind === "insufficient_credits" && <AddFunds onWalletKey={signInWith} onPayUsdc={() => { setPayWith("USDC per message"); setError(""); setErrorKind(""); setNotice("Press Send to review the USDC quote."); }} key={keyId} apiKey={view.keys.find(k => k.id === keyId)?.secret || apiKey} balance={ws?.credits?.available} force onBalance={() => refresh()} onResume={() => run({ preventDefault() {} })} disabled={busy}/>} /* ON1 */
              problem={error && (isNotEnabledText(error) ? <Problem text={error} /> : (
                <div className="error" role="alert">
                  {error}

                </div>
              ))}
            />
          )}
          {tab === "Models" && (
            <ModelCatalog
              source={live ? "live" : "demo"}
              onChoose={(id) => {
                setModelId(id);
                navigate("Playground");
              }}
            />
          )}
          {tab === "API keys" && (
            <>
              <div className="panel-heading">
                <div>
                  <h2>A key for every workload.</h2>
                  <p className="help-text">{live ? `Sub-keys share this workspace’s balance. Secrets are shown once. Set each key’s total budget${rulesOn ? " and caps" : ""} in its Spending limits.` : "Local sample keys with enforced sample budgets."}</p>
                </div>
                <Button onClick={() => setModal({ type: "key" })}>Create key</Button>
              </div>
              {live && ws?.keysError && <div className="note">This key can’t list the workspace’s other keys ({ws.keysError}).</div>}
              {live && !ws?.keysError && <AccountUnusedKeys key={apiKey} apiKey={apiKey} keys={ws?.keys || []} currentHash={ws?.me?.hash} onChanged={refresh}/>} {/* B125 */}
              {view.keys.length ? (
                <div className="key-list">
                  {view.keys.map((k, i) => (
                    <article className={"key-card" + (k.active ? "" : " is-revoked")} key={k.id} style={{ "--i": i }}>
                      <div>
                        <h3>{k.name}</h3>
                        <span className={"badge " + (k.active && !(live && endDatesOn && ended(k.expiresAt)) ? "green" : "")}>{k.active ? (live && endDatesOn && ended(k.expiresAt) ? "Ended" : k.current ? "Active · this browser" : "Active") : "Revoked"}</span>
                      </div>
                      <code className="key-token">{k.token}</code>
                      {live && <KeyLastUsed value={ws?.keys?.find(key => key.hash === k.id)?.last_used} current={k.current}/>} {/* B125 */}
                      {live && endDatesOn && k.expiresAt && <p className="help-text key-end-date">{endDateText(k.expiresAt)}</p>} {/* Update 16 */}
                      <div className="budget-line">
                        <span>
                          {money(k.spent, 6)} / {k.budget == null ? "no limit" : money(k.budget, 2) + " USDC"}
                        </span>
                        <span>{k.budget == null ? "No budget limit" : Math.min(100, (k.spent / k.budget) * 100).toFixed(1) + "% used"}</span>
                      </div>
                      <progress max={k.budget ?? 1} value={k.budget == null ? 0 : Math.min(k.spent, k.budget)} aria-label={"Budget used by " + k.name} />
                      {(!live || topupOn) && <>{k.topup && <p className="help-text">{topupCardText(k.topup)}</p>}</>}
                      <div className="button-row">
                        <CopyButton text={live ? k.chainKeyHash : k.token} label={live ? "Copy deposit hash" : "Copy sample key"} />
                        <button className="text-button" onClick={() => setModal({ type: "key", data: k })}>
                          {live ? (endDatesOn ? "Edit" : "Rename") : "Edit budget"}
                        </button>
                        {live && k.active && (
                          <button className="text-button" onClick={() => setModal({ type: "limits", data: k })}>
                            Spending limits
                          </button>
                        )}
                        {k.active ? (
                          <button className="text-button" disabled={live && k.current} title={live && k.current ? "A key cannot revoke itself. Use Sign out, or revoke it from another management key." : undefined} onClick={() => setModal({ type: "revoke", data: k })}>
                            Revoke
                          </button>
                        ) : (
                          <button
                            className="text-button"
                            onClick={async () => {
                              if (!live) {
                                update((s) => ({ ...s, keys: s.keys.map((x) => (x.id === k.id ? { ...x, active: true } : x)) }));
                                setNotice("Sample key restored.");
                                return;
                              }
                              try {
                                await api("/api/v1/keys/" + k.id, { key: apiKey, method: "PATCH", body: { disabled: false } });
                                await refresh();
                                setNotice("Key restored.");
                              } catch (e) {
                                setError(e.message);
                              }
                            }}
                          >
                            {live ? "Restore key" : "Restore sample key"}
                          </button>
                        )}
                        {live && !k.active && (
                          <button
                            className="text-button"
                            title="If this key asked to close its credits before it was revoked, the refund is on hold. Releasing lets it be paid, back to the wallets that paid in."
                            onClick={async () => {
                              try {
                                // An owner or admin lets a held closure go ahead on purpose; the key is named by its hash.
                                const r = await api("/api/v1/credits/close/release", { key: apiKey, method: "POST", body: { key: k.id } });
                                setNotice(releasedMessage(r.data));
                              } catch (e) {
                                setError(e?.status === 404 ? "This key has no closure waiting to be released." : e.message);
                              }
                            }}
                          >
                            Release held refund
                          </button>
                        )}
                      </div>
                      <div className="card-ramp" />
                    </article>
                  ))}
                </div>
              ) : (
                <div className="empty">
                  <h3>No keys yet.</h3>
                  <p>{live ? "Create a key to start routing." : "Create a sample key to start routing."}</p>
                </div>
              )}
              {(!live || tracingOn) && <Tracing live={live && signedIn} apiKey={apiKey} ws={ws} notify={setNotice} fail={setError} />}
              {error && (
                <Problem text={error} />
              )}
            </>
          )}
          {tab === "Receipts" && (
            <>
              <div className="panel-heading">
                <h2>Every call, accounted for.</h2>
                <Button secondary disabled={!view.receipts.length} onClick={() => downloadJSON(view.receipts, live ? "trellis-receipts.json" : "trellis-sample-receipts.json")}>
                  Export receipts
                </Button>
              </div>
              {live && <ReceiptExport key={apiKey} apiKey={apiKey} />}
              <div className="catalog-tools">
                <input aria-label="Search receipts" className="search-field" placeholder="Search model, provider or receipt…" value={receiptQuery} onChange={(e) => setReceiptQuery(e.target.value)} />
                <select aria-label="Filter receipts" value={receiptMode} onChange={(e) => setReceiptMode(e.target.value)}>
                  <option>All</option>
                  <option>Private</option>
                  <option>Standard</option>
                </select>
              </div>
              {filtered.length || !view.receipts.length ? (
                <ReceiptTable live={live} receipts={filtered} onInspect={(r) => setModal({ type: "receipt", data: r })} emptyAction={() => navigate("Playground")} />
              ) : (
                <div className="empty">
                  <h3>No matching receipts</h3>
                  <p>Try another search or route type.</p>
                  <Button
                    secondary
                    onClick={() => {
                      setReceiptQuery("");
                      setReceiptMode("All");
                    }}
                  >
                    Clear filters
                  </Button>
                </div>
              )}
              {live && ws?.next && (
                <button
                  className="text-button"
                  onClick={async () => {
                    try {
                      const more = await api("/api/v1/generations?limit=100&before=" + encodeURIComponent(ws.next), { key: apiKey });
                      setWs((w) => ({ ...w, receipts: [...w.receipts, ...more.data.map((g) => toReceiptRow(g, w.tokens))], next: more.next }));
                    } catch (e) {
                      setError(e.message);
                    }
                  }}
                >
                  Load older receipts →
                </button>
              )}
            </>
          )}
          {live && tab === "Payments" && (
            <FundsCenter key={`funds:${apiKey}`} onWalletKey={signInWith} apiKey={apiKey} ws={ws} status={status} onRefresh={() => refresh()} onClose={() => setModal({ type: "close" })}>
              {payWithOn && <PayWithSetting key={apiKey} keyHash={ws?.me?.hash} onChange={() => setPayWithTick((t) => t + 1)} />}
            </FundsCenter>
          )}
          {!live && tab === "Payments" && (
            <>
              <div className="panel-heading">
                <h2>One balance. Your choice.</h2>
                <span className="badge">Sample funds only</span>
              </div>
              <div className="payment-balance">
                <div>
                  <span className="eyebrow">AVAILABLE SAMPLE USDC</span>
                  <strong>{money(view.balance, 4)}</strong>
                  <p>No real funds or financial account.</p>
                </div>
                <div className="button-row">
                  <Button onClick={() => setModal({ type: "credits" })}>Add sample credits</Button>
                </div>
              </div>
            </>
          )}
          {["Saved Routes", "Presets", "Characters", "Eval Lab", "Batch Studio", "Agent Sessions", "Teams", "Skills", "Spend Watch"].includes(tab) &&
            (() => {
              const featureProps = { live, apiKey, ws, status, catalog, refresh, notify: setNotice, fail: setError, navigate };
              if (tab === "Saved Routes") return <SavedRoutes {...featureProps} />;
              if (tab === "Presets") return <Presets {...featureProps} />;
              if (tab === "Characters") return <Characters {...featureProps} />;
              if (tab === "Eval Lab") return <EvalLab {...featureProps} />;
              if (tab === "Batch Studio") return <BatchStudio {...featureProps} />;
              if (tab === "Agent Sessions") return <AgentSessions {...featureProps} />;
              if (tab === "Skills") return <Skills {...featureProps} />;
              if (tab === "Teams") return <Teams {...featureProps} signedIn={signedIn} onKey={signInWith} onSecret={(secret, deposit, title) => setReveal({ secret, deposit, title })} />;
              return <SpendWatch {...featureProps} />;
            })()}
          {tab === "Providers" && (
            <>
              <div className="panel-heading">
                <h2>Know who serves the call.</h2>
                <span className="badge">{live ? "Live provider registry" : "Fictional providers"}</span>
              </div>
              <p className="catalog-note">
                {live
                  ? "Uptime is the 30-day share of successful calls and probes; latency is time to first token (p50). Attestation is re-verified every 10 minutes."
                  : "Names, health and attestation states are sample values. No provider partnership is implied."}
              </p>
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Provider</th>
                      <th className="num">{live ? "Uptime (30d)" : "Sample uptime"}</th>
                      <th className="num">{live ? "Latency (p50)" : "Sample latency"}</th>
                      <th>Private route</th>
                      <th>
                        <span className="sr-only">Details</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {providerRows.map((p, i) => (
                      <tr key={p.name} style={{ "--i": i }}>
                        <td className="cell-primary">
                          <strong>{p.name}</strong>
                          <small>{p.quant}</small>
                        </td>
                        <td className="num" data-label={live ? "Uptime (30d)" : "Sample uptime"}>
                          {p.uptime == null ? "No data yet" : p.uptime + "%"}
                        </td>
                        <td className="num" data-label={live ? "Latency (p50)" : "Sample latency"}>
                          {p.latency == null ? "No data yet" : Math.round(p.latency) + " ms"}
                        </td>
                        <td data-label="Private route">
                          <span className={"route-tag" + (p.private ? " private" : " off")}>{p.private ? (live ? "Attested TEE" : "Sample TEE") : "Unavailable"}</span>
                        </td>
                        <td className="cell-action">
                          <button className="text-button" onClick={() => setModal({ type: "provider", data: p })}>
                            Details →
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {live && !providerRows.length && <div className="empty">{liveProviders ? "No live providers yet." : "Loading providers…"}</div>}
              <div className="note">
                {live
                  ? "Providers are onboarded by the operator. No bond or deposit is required."
                  : "Providers are onboarded by the operator. No bond or deposit is required."}
              </div>
            </>
          )}
          {tab === "Settings" && (
            <>
              <div className="panel-heading">
                <h2>{live ? "Your workspace." : "Your sample workspace."}</h2>
              </div>
              {live && apiKey && telegramOn && <TelegramLink key={apiKey} principalKey={apiKey}/>}
              <div className="settings-grid">
                <div className="settings-panel">
                  <h3>{live ? "This browser" : "Browser-local data"}</h3>
                  <p>
                    {live
                      ? `Signed in with ${ws?.me?.label ?? "—"}. The key is kept in this browser (this tab session only). Read What we keep for router storage and retention.${exportOn ? " Open Export your data to download accessible account records with a manifest; key secrets are excluded." : ""}`
                      : "Changes persist only in this browser. No account has been created. The workspace export contains sample keys, receipt metadata, sessions and sample balances; it contains no prompt text."}
                  </p>
                  <div className="button-row">
                    {(!live || exportOn) && (
                    <Button
                      secondary
                      onClick={() =>
                        live ? navigate("Export your data") : downloadJSON(state, "trellis-sample-workspace.json")
                      }
                    >
                      {live ? "Open data export" : "Export workspace"}
                    </Button>
                    )}
                    <Button secondary onClick={() => setModal({ type: "reset" })}>
                      {live ? "Sign out of this browser" : "Reset sample workspace"}
                    </Button>
                  </div>
                </div>
                <div className="settings-panel">
                  <h3>{live ? "Connect your app" : "Production integration"}</h3>
                  <p>
                    {live
                      ? `Point any OpenAI- or OpenRouter-compatible client at ${origin}/api/v1 and use this key (or a budgeted sub-key). Requests, streaming, provider preferences and usage fields work unchanged.`
                      : "Authentication, server storage, inference, payments and verified receipts need backend services. This preview never treats a connected wallet as a payment or entitlement."}
                  </p>
                  <div className="button-row">
                    <Button href="/docs/">Read the docs</Button>
                    {live ? (
                      <>
                        <CopyButton text={origin + "/api/v1"} label="Copy base URL" />

                      </>
                    ) : (
                      <button className="text-button" onClick={() => switchMode("live")}>
                        Connect to the live API
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
      )}
      </section>
      </AccountShell>
      {modal?.type === "receipt" && <ReceiptDetails receipt={modal.data} apiKey={apiKey} status={status} onClose={() => setModal(null)} />}
      {modal?.type === "key" && <KeyDialog live={live} rules={!live || rulesOn} endDates={endDatesOn} existing={modal.data} onClose={() => setModal(null)} onSave={saveKeyValues} />}
      {modal?.type === "limits" && <KeyLimits apiKey={apiKey} keyHash={modal.data.id} name={modal.data.name} current={modal.data.current} topup={modal.data.topup} budget={modal.data.budget} reset={modal.data.reset} spent={modal.data.spent} onSaved={() => refresh().catch(() => {})} onClose={() => setModal(null)} />}
      {modal?.type === "provider" && (
        <Modal title={modal.data.name} onClose={() => setModal(null)}>
          <span className="badge">{live ? "Provider record · " + modal.data.status : "Fictional provider record"}</span>
          <dl className="detail-list">
            <div>
              <dt>Quantization</dt>
              <dd>{modal.data.quant}</dd>
            </div>
            <div>
              <dt>{live ? "Attestation" : "Sample attestation"}</dt>
              <dd>{live ? (modal.data.private ? `${modal.data.tee?.toUpperCase() || "TEE"} · ${modal.data.attestation?.slice(0, 22)}… · ${new Date(modal.data.attestedAt).toLocaleString("en-GB")}` : "Not attested") : modal.data.private ? "TEE example — not verified" : "Unavailable"}</dd>
            </div>
            <div>
              <dt>{live ? "Data policy" : "Sample data policy"}</dt>
              <dd>
                {live
                  ? `${modal.data.policy.training ? "May train on data" : "No training"} · ${modal.data.policy.retains_prompts ? "Retains prompts" : "Does not retain prompts"}${modal.data.policy.zdr ? " · Zero data retention" : ""}`
                  : "Model requests are not sent in this preview."}
              </dd>
            </div>
            {live && (
              <div>
                <dt>Models served</dt>
                <dd>{modal.data.models}</dd>
              </div>
            )}
          </dl>
          <p className="note">{live ? "Health comes from routed traffic and 15-second probes; a provider with two failures in 30 seconds is skipped until it recovers." : "A production record must show verified provider terms, health provenance, bond contract and attestation evidence."}</p>
          <Button href="/docs/#routing">Routing documentation</Button>
        </Modal>
      )}
      {modal?.type === "credits" &&
        (live ? (
          <DepositDialog
            apiKey={apiKey}
            credits={ws?.credits}
            status={status}
            onClose={() => setModal(null)}
            onDone={async (amount, kind) => {
              const before = ws?.credits?.total_credits ?? 0;
              for (let i = 0; i < 30; i++) {
                const next = await refresh();
                if ((next.credits?.total_credits ?? 0) >= before + amount - 1e-9) break;
                await new Promise((r) => setTimeout(r, 1000));
              }
              setNotice(kind === "test" ? amount + " test USDC added." : "Transaction sent. Follow the observed amount and credit status under Deposit status."); // V97B
              if (errorKind === "insufficient_credits") {
                setError("");
                setErrorKind("");
              }
              setModal(null);
            }}
          />
        ) : (
          <Modal title="Add sample credits" onClose={() => setModal(null)}>
            <p>Add 25 USDC to this browser’s sample balance. These are free sample credits, with no deposit, purchase or transfer.</p>
            <div className="button-row modal-actions">
              <Button
                onClick={() => {
                  update((s) => ({ ...s, balance: s.balance + 25 }));
                  setNotice("25 sample USDC added. No real funds were transferred.");
                  setModal(null);
                }}
              >
                Add 25 sample USDC
              </Button>
              <Button secondary onClick={() => setModal(null)}>
                Cancel
              </Button>
            </div>
          </Modal>
        ))}
      {modal?.type === "close" && <CloseAccountDialog apiKey={apiKey} credits={ws?.credits} chain={chainOf(status)} onClose={() => setModal(null)} onDone={() => refresh().catch(() => {})} />}
      {["reset", "revoke"].includes(modal?.type) && (
        <Modal
          title={modal.type === "reset" ? (live ? "Sign out of this browser?" : "Reset the sample workspace?") : modal.type === "revoke" ? (live ? "Revoke this key?" : "Revoke this sample key?") : live ? "Close this session?" : "Close this sample session?"}
          onClose={() => setModal(null)}
        >
          <p>
            {modal.type === "reset"
              ? live
                ? "This forgets the key in this browser. Your key, balance and receipts stay with the router; connect the key again any time."
                : "This removes the current browser’s sample records and restores 25 sample USDC and the starter key. Export the workspace first if you want to keep a copy."
              : modal.type === "revoke"
                ? live
                  ? "This key stops working immediately. Existing receipts remain, and you can restore it later from a management key. " + REVOKE_HOLDS_CLOSURE_NOTE
                  : "This key will stop working in the local playground. Existing receipts remain. You can restore the sample key later."
                : live
                  ? "This session will be closed."
                  : "This sample token session will be removed. Existing generation receipts remain."}
          </p>
          <div className="button-row modal-actions">
            <Button
              onClick={async () => {
                try {
                  await confirmAction();
                } catch (e) {
                  setError(e?.message || String(e));
                  setModal(null);
                }
              }}
            >
              {modal.type === "reset" ? (live ? "Sign out" : "Reset workspace") : modal.type === "revoke" ? (live ? "Revoke key" : "Revoke sample key") : "Close session"}
            </Button>
            <Button secondary onClick={() => setModal(null)}>
              Cancel
            </Button>
          </div>
        </Modal>
      )}
      {reveal && <SecretDialog secret={reveal.secret} deposit={reveal.deposit} title={reveal.title} onClose={() => setReveal(null)} />}
    </main>
  );
}
