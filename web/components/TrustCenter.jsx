"use client";
// The Trust center: everything needed to check Trellis without trusting it, read live from the router's public
// documents, and an honest list of what a receipt cannot prove.
import { useEffect, useRef, useState } from "react";
import { API_BASE, api } from "../lib/api";
import { KEYS_PATH, parseReceiptInput, verifyReceipt } from "../lib/verify";
import { MARKS, PATH_NOTES, checkView, liveCards, receiptIdOf, requestPath } from "../lib/trust.js";
import { Icon, IconTile } from "./Icons";
import s from "./TrustCenter.module.css";

async function getJson(path) {
  const res = await fetch(API_BASE + path, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(String(res.status));
  return res.json();
}

function useLive() {
  const [docs, setDocs] = useState(null);
  const [at, setAt] = useState(null);
  useEffect(() => {
    let live = true;
    const read = (p) => getJson(p).then((j) => j.data ?? j).catch(() => null);
    Promise.all([read(KEYS_PATH), read("/api/v1/status"), read("/api/v1/status/slo"), read("/api/v1/attestation/summary")]).then(([keys, status, slo, summary]) => {
      if (!live) return;
      setDocs({ keys, status, slo, summary });
      setAt(new Date());
    });
    return () => { live = false; };
  }, []);
  return [docs ? liveCards(docs) : null, at];
}

function Checker() {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [view, setView] = useState(null);
  const [drag, setDrag] = useState(false);
  const file = useRef(null);
  useEffect(() => { // ?r=<id> fills the box, as on the verify page
    const r = new URLSearchParams(window.location.search).get("r");
    if (r) setText(r);
  }, []);

  async function check(input) {
    setError(""); setView(null);
    const value = (input ?? text).trim();
    if (!value) { setError("Paste a receipt ID or a receipt, or drop a receipt file."); return; }
    setBusy(true);
    try {
      let receipt;
      const id = receiptIdOf(value);
      if (id) {
        try { receipt = (await api(`/api/v1/receipts/${encodeURIComponent(id)}`)).data; } catch (e) { throw new Error(e.status === 404 ? "No receipt with that ID on this router." : "The receipt could not be loaded."); }
      } else {
        const parsed = parseReceiptInput(value);
        if (parsed.error) throw new Error(parsed.error);
        receipt = parsed.receipt;
      }
      const keys = await getJson(KEYS_PATH).catch(() => { throw new Error("The router’s published keys could not be loaded."); });
      setView(checkView(await verifyReceipt(receipt, { keys })));
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function read(files) {
    const f = files?.[0];
    if (!f) return;
    const t = await f.text();
    setText(t);
    check(t);
  }

  return (
    <div className={s.checkGrid}>
      <form className={s.panel} onSubmit={(e) => { e.preventDefault(); check(); }}>
        <h3>A receipt, by ID or file</h3>
        <label
          className={s.drop}
          data-drag={drag || undefined}
          onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => { e.preventDefault(); setDrag(false); read(e.dataTransfer.files); }}
        >
          <IconTile name="upload" tone="amber" size={48} icon={22} />
          <span><b>Drop a receipt file</b>JSON, from Download JSON in Chat or GET /api/v1/receipts/&lt;id&gt;</span>
          <input ref={file} type="file" accept="application/json,.json" className="sr-only" onChange={(e) => { read(e.target.files); e.target.value = ""; }} />
        </label>
        <div className={s.row}>
          <label htmlFor="trust-receipt" className="sr-only">Receipt ID or receipt JSON</label>
          <input id="trust-receipt" value={text} onChange={(e) => setText(e.target.value)} placeholder="Or paste a receipt ID" autoComplete="off" spellCheck="false" />
          <button type="submit" className={s.go} disabled={busy}>{busy ? "Checking…" : "Check"}</button>
        </div>
        {error && <p className={s.error} role="alert">{error}</p>}
      </form>
      <div className={s.panel} aria-live="polite">
        <h3>{view ? "Result" : "What you will see"}</h3>
        {view ? (
          <>
            <div className={s.verdict} data-tone={view.tone}><IconTile name={view.tone === "ok" ? "shieldCheck" : view.tone === "bad" ? "x" : "shield"} tone={view.tone === "ok" ? "glow" : "plain"} size={44} icon={21} /><div><b>{view.head}</b><span>{view.anchor}</span></div></div>
            <ul className={s.checks}>
              {view.checks.map((c) => <li key={c.id} data-state={c.state}><Icon name={c.state === "pass" ? "check" : c.state === "fail" ? "x" : "minus"} size={15} strokeWidth={2} /><span>{c.text}</span></li>)}
            </ul>
            {view.notChecked.length > 0 && <details className={s.gaps}><summary>What this does not prove ({view.notChecked.length})</summary><ul>{view.notChecked.map((n, i) => <li key={i}>{n}</li>)}</ul></details>}
          </>
        ) : (
          <ul className={s.checks} data-preview>
            <li data-state="pass"><Icon name="key" size={15} /><span>Whether the signature matches a key the router publishes.</span></li>
            <li data-state="pass"><Icon name="anchor" size={15} /><span>Whether the receipt is in an anchored hour, and its inclusion proof.</span></li>
            <li data-state="pass"><Icon name="receipt" size={15} /><span>The model, provider, tokens and price it records.</span></li>
            <li data-state="not_checked"><Icon name="eye" size={15} /><span>What it cannot show, listed plainly.</span></li>
          </ul>
        )}
      </div>
    </div>
  );
}

export default function TrustCenter() {
  const [cards, at] = useLive();
  const [mode, setMode] = useState("standard");
  const steps = requestPath(mode);
  return (
    <main className={`page-main ${s.page}`} id="content">
      <section className={s.hero}>
        <div className={s.heroText}>
          <span className={s.eyebrow}><Icon name="shieldCheck" size={16} />Trust center</span>
          <h1>Don’t take our word <span>for it.</span></h1>
          <p>Every answer is signed. Every hour of receipts is anchored on Solana. The keys are public. Here is what you need to check Trellis yourself, and an honest list of what it can’t prove.</p>
          <div className={s.heroActions}>
            <a className="ar-button" href="#check">Verify a receipt</a>
            <a className="ar-button secondary" href="#path">Follow one request</a>
          </div>
        </div>
        <div className={s.seal} aria-hidden="true">
          <span className={s.ring} data-r="3" /><span className={s.ring} data-r="2" /><span className={s.ring} data-r="1" />
          <div className={s.orbit}>
            {["key", "anchor", "chip", "receipt"].map((n, i) => <span key={n} className={s.sat} style={{ "--a": `${i * 90 + 20}deg` }}><span><IconTile name={n} tone={i === 0 ? "amber" : "plain"} size={46} icon={20} /></span></span>)}
          </div>
          <span className={s.core}><IconTile name="shieldCheck" tone="glow" size={96} icon={44} /></span>
        </div>
      </section>

      <section aria-labelledby="live" className={s.block}>
        <div className={s.liveHead}>
          <span className={s.pulse} aria-hidden="true" />
          <h2 id="live">Live, read from this router {at ? `at ${at.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}` : "now"}</h2>
        </div>
        <div className={s.cards}>
          {(cards || [0, 1, 2, 3]).map((c, i) => c ? (
            <div key={c.id} className={s.card}>
              <div className={s.cardTop}>
                <IconTile name={c.icon} tone={c.state === "ok" ? "amber" : "plain"} />
                <span className={s.state} data-state={c.state}>{c.state === "ok" ? "Live" : c.state === "warn" ? "Needs setup" : "Unavailable"}</span>
              </div>
              <span className={s.cardLabel}>{c.label}</span>
              <span className={s.cardValue} data-mono={c.id === "key" || undefined}>{c.value}</span>
              <span className={s.cardNote}>{c.note}</span>
              <a href={c.href}>{c.link} ↗</a>
            </div>
          ) : <div key={i} className={s.card} data-loading aria-hidden="true"><span className="loading-bar" /></div>)}
        </div>
      </section>

      <section id="path" aria-labelledby="path-title" className={s.block}>
        <div className={s.blockHead}>
          <div>
            <h2 id="path-title">Follow one request</h2>
            <p>Who sees your message, and what is kept, at each step. Switch to Private to see what changes.</p>
          </div>
          <div role="radiogroup" aria-label="Mode" className={s.segmented}>
            {["standard", "private"].map((m) => (
              <button key={m} type="button" role="radio" aria-checked={mode === m} onClick={() => setMode(m)}><Icon name={m === "standard" ? "globe" : "shield"} size={15} />{m === "standard" ? "Standard" : "Private"}</button>
            ))}
          </div>
        </div>
        <ol className={s.path} data-mode={mode}>
          {steps.map((st, i) => (
            <li key={st.id} data-changed={st.changed || undefined}>
              <div className={s.stepTop}>
                <IconTile name={st.icon} tone={st.changed ? "glow" : "plain"} size={44} icon={21} />
                <span className={s.stepN}>0{i + 1}</span>
              </div>
              {st.changed && <span className={s.changed}>Changes in Private</span>}
              <b>{st.title}</b>
              <div><small>Sees</small><span>{st.sees}</span></div>
              <div><small>Keeps</small><span className={s.keeps}>{st.keeps}</span></div>
            </li>
          ))}
        </ol>
        <p className={s.pathNote}>{PATH_NOTES[mode]}</p>
      </section>

      <section id="check" aria-labelledby="check-title" className={s.block}>
        <div className={s.blockHead}>
          <div>
            <h2 id="check-title">Check it yourself</h2>
            <p>Checked in your browser against the published keys. A file you drop here is read on this device and not uploaded.</p>
          </div>
        </div>
        <Checker />
      </section>

      <section aria-labelledby="marks" className={s.block}>
        <div className={s.blockHead}>
          <div>
            <h2 id="marks">One set of marks, everywhere</h2>
            <p>The same marks appear on models, in Chat and on receipts, and each means exactly one thing.</p>
          </div>
        </div>
        <div className={s.marks}>
          {MARKS.map((m) => (
            <div key={m.id}>
              <span className={s.mark} data-mark={m.id}><Icon name={m.icon} size={14} strokeWidth={1.9} />{m.label}</span>
              <p>{m.means}</p>
            </div>
          ))}
        </div>
      </section>

      <section aria-labelledby="proves" className={s.honest}>
        <div className={s.panel}>
          <h2 id="proves"><IconTile name="check" tone="amber" size={36} icon={17} />What a receipt proves</h2>
          <ul className={s.yes}>
            <li><span className={s.glyph}><Icon name="check" size={12} strokeWidth={2.6} /></span>Which model and provider answered, the tokens and the exact price.</li>
            <li><span className={s.glyph}><Icon name="check" size={12} strokeWidth={2.6} /></span>That the router signed it with the key it publishes, and nobody has changed it since.</li>
            <li><span className={s.glyph}><Icon name="check" size={12} strokeWidth={2.6} /></span>Once anchored, that the hour’s receipts can’t be quietly rewritten.</li>
            <li><span className={s.glyph}><Icon name="check" size={12} strokeWidth={2.6} /></span>With the Attested hardware mark, that the provider’s enclave attestation was fresh when it answered.</li>
          </ul>
        </div>
        <div className={`${s.panel} ${s.plain}`}>
          <h2><IconTile name="eye" size={36} icon={17} />What it can’t prove</h2>
          <ul className={s.no}>
            <li><span className={s.glyph}><Icon name="minus" size={12} strokeWidth={2.6} /></span>That the answer is correct.</li>
            <li><span className={s.glyph}><Icon name="minus" size={12} strokeWidth={2.6} /></span>That a provider without the Attested hardware mark didn’t keep your prompt. Its data policy is a promise, not a proof.</li>
            <li><span className={s.glyph}><Icon name="minus" size={12} strokeWidth={2.6} /></span>That the router has no bugs. The code is open, and it has not had an independent audit yet.</li>
          </ul>
        </div>
      </section>

      <section aria-labelledby="res" className={s.block}>
        <h2 id="res" className={s.small}><Icon name="code" size={18} />For auditors and the curious</h2>
        <div className={s.resources}>
          {[
            ["key", "Receipt keys", "/.well-known/trellis-receipt-keys.json", "/.well-known/trellis-receipt-keys.json"],
            ["fileCheck", "Provider evidence", "Attestations and their limits", "/verify/"],
            ["pulse", "Status and uptime", "Incidents, with RSS", "/status/"],
            ["shield", "Privacy routes", "What each lane does and doesn’t hide", "/how-it-works/#privacy"],
            ["archive", "What we keep", "The data inventory", "/keep/"],
            ["book", "Specifications", "Receipts, anchors and proofs", "/spec/"],
          ].map(([icon, title, note, href]) => (
            <a key={href} href={href}>
              <IconTile name={icon} size={38} icon={18} />
              <span><b>{title}</b><span>{note}</span></span>
              <Icon name="external" size={15} className={s.ext} />
            </a>
          ))}
        </div>
      </section>
    </main>
  );
}
