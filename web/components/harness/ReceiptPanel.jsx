"use client";
// The receipt behind one answer, opened from its Receipt chip: checked in this browser against the router's published
// keys, with the signed facts, who could read the request, and what the check does not prove.
import { useCallback, useEffect, useRef, useState } from "react";
import { API_BASE } from "../../lib/api";
import { KEYS_PATH, verifyReceipt } from "../../lib/verify";
import { privacyHref } from "../../lib/privacy";
import { formatMs, formatUsd, receiptHref } from "../../lib/arena";
import { replyFacts } from "../../lib/harness";
import ProofBadge from "../ProofBadge";
import RouteExplanation from "./RouteExplanation"; // V84: receipt-only explanation.
import { useLabel } from "./PrivateMode";
import s from "./ReceiptPanel.module.css";

const HEAD = {
  checking: ["Checking the signature…", "wait"],
  valid: ["Signature valid", "ok"],
  invalid: ["Signature did not verify", "bad"],
  unchecked: ["Could not be checked here", "warn"],
  offline: ["Keys could not be loaded", "warn"],
};
const ANCHOR = {
  proof_valid: "In an anchored batch: the inclusion proof checks against its root.",
  proof_invalid: "The inclusion proof in this receipt does not check.",
  no_proof: "No inclusion proof yet. Receipts are batched and anchored on Solana; check again later.",
};

function useVerdict(receipt) {
  const [state, setState] = useState({ phase: "checking", result: null });
  const run = useCallback(async () => {
    if (!receipt) return;
    setState({ phase: "checking", result: null });
    try {
      const res = await fetch(API_BASE + KEYS_PATH, { headers: { accept: "application/json" } });
      if (!res.ok) throw new Error("keys " + res.status);
      const result = await verifyReceipt(receipt, { keys: await res.json() });
      const unchecked = result.checks.some((c) => (c.id === "signature" || c.id === "v2_signature") && c.status === "not_checked");
      setState({ phase: result.valid ? "valid" : unchecked ? "unchecked" : "invalid", result });
    } catch {
      setState({ phase: "offline", result: null });
    }
  }, [receipt]);
  useEffect(() => { run(); }, [run]);
  return [state, run];
}

export default function ReceiptPanel({ msg, model, onClose }) {
  const receipt = msg.receipt;
  const facts = replyFacts(msg);
  const p = receipt?.payload || {};
  const [{ phase, result }, again] = useVerdict(receipt);
  const label = useLabel(facts.receiptId)?.label || null;
  const ref = useRef(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const before = document.activeElement;
    ref.current?.focus();
    const key = (e) => e.key === "Escape" && close.current();
    window.addEventListener("keydown", key);
    return () => { window.removeEventListener("keydown", key); before?.focus?.(); };
  }, [facts.receiptId]);
  const [head, tone] = HEAD[phase];
  const download = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(receipt, null, 2)], { type: "application/json" }));
    const a = Object.assign(document.createElement("a"), { href: url, download: `receipt-${facts.receiptId || "answer"}.json` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };
  const rows = [
    ["Receipt", facts.receiptId],
    ["Model", model?.name || p.model || msg.model],
    ["Provider", facts.provider || p.provider],
    ["Tokens", facts.tokensIn != null || facts.tokensOut != null ? `${facts.tokensIn ?? "?"} in · ${facts.tokensOut ?? "?"} out` : null],
    ["Cost", facts.cost === null ? "pending" : formatUsd(facts.cost)],
    ["Time", Number.isFinite(msg.ms) ? formatMs(msg.ms) : null],
    ["Disclosure", facts.disclosure],
    ["Signing key", result?.keyId || receipt?.key_id],
  ].filter(([, v]) => v);

  return (
    <aside className={s.panel} aria-labelledby="receipt-title" tabIndex={-1} ref={ref}>
      <header className={s.head}>
        <h2 id="receipt-title">Receipt</h2>
        <button type="button" className={s.close} onClick={onClose} aria-label="Close receipt">
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
        </button>
      </header>
      <div className={s.body}>
        <div className={s.verdict} data-tone={tone} role="status">
          <b>{head}</b>
          <p>
            {phase === "valid" && "The facts below are exactly what the router's published key signed. It does not show that the answer is correct."}
            {phase === "checking" && "Checked in this browser against the keys the router publishes."}
            {phase === "invalid" && "Do not rely on this receipt."}
            {phase === "unchecked" && "This browser could not run the signature check, so nothing was verified."}
            {phase === "offline" && "Check your connection and try again, or open it on the verify page."}
          </p>
          {result?.anchor && <p className={s.anchor}>{ANCHOR[result.anchor]}</p>}
        </div>

        <dl className={s.facts}>
          {rows.map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>

        <section className={s.section} aria-labelledby="receipt-saw">
          <h3 id="receipt-saw">Who saw your message</h3>
          <ProofBadge evidence={{ source: "receipt", data: receipt }} dark explain />
          {label?.summary?.length ? (
            <ul className={s.list}>
              {label.summary.map((line, i) => <li key={i}>{line}</li>)}
            </ul>
          ) : (
            <p className={s.muted}>The Trellis router reads the request in memory to route it{facts.provider ? `, and ${facts.provider} ran the model` : ""}.</p>
          )}
        </section>

        <RouteExplanation receipt={receipt} />
        {result && (
          <details className={s.more}>
            <summary>All checks ({result.checks.length})</summary>
            <ul className={s.checks}>
              {result.checks.map((c) => (
                <li key={c.id} data-state={c.status}>
                  <span>{c.status === "pass" ? "Passed" : c.status === "fail" ? "Failed" : "Not checked"}</span>
                  {c.detail}
                </li>
              ))}
            </ul>
          </details>
        )}
        {result?.notChecked?.length > 0 && (
          <details className={s.more}>
            <summary>What this does not prove</summary>
            <ul className={s.list}>
              {result.notChecked.map((n, i) => <li key={i}>{n}</li>)}
            </ul>
          </details>
        )}
      </div>
      <footer className={s.foot}>
        <button type="button" className={s.primary} onClick={again} disabled={phase === "checking"}>
          {phase === "checking" ? "Checking…" : "Verify again"}
        </button>
        <button type="button" className={s.secondary} onClick={download}>
          Download JSON
        </button>
        {facts.receiptId && (
          <span className={s.links}>
            <a href={`/trust/?r=${encodeURIComponent(facts.receiptId)}#check`} target="_blank" rel="noopener noreferrer">Check it in the Trust center ↗</a>
            <a href={privacyHref(facts.receiptId)} target="_blank" rel="noopener noreferrer">Who saw it ↗</a>
            <a href={receiptHref(facts.receiptId)} target="_blank" rel="noopener noreferrer">Raw receipt ↗</a>
          </span>
        )}
      </footer>
    </aside>
  );
}
