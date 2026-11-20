"use client";
// One model: who serves it, at what price, speed and uptime, with which privacy, and how each routing choice orders
// them. Read from GET /api/v1/models and GET /api/v1/models/:author/:slug/endpoints; the price history (update 22)
// from GET /api/v1/models/:author/:slug/prices.
import { useEffect, useMemo, useState } from "react";
import { api, toCatalogModel } from "../lib/api";
import { formatContext } from "../lib/harness";
import { CapabilityChips } from "./ModelCapabilities";
import { CopyButton } from "./UI";
import { ROUTES, modelHref, modelSummary, providerRows, routeRows, similarModels, usdPerM } from "../lib/model-page.js";
import { Icon, IconTile } from "./Icons";
import { useModelHealth } from "./ModelHealth";
import { HEALTH_NOTE, healthFigures, healthTone } from "../lib/model-health.js";
import PriceHistory from "./PriceHistory";
import { useUpdate } from "./media/useUpdate.js";
import s from "./ModelPage.module.css";

const ROUTE_ICON = { balanced: "scale", floor: "coins", nitro: "zap", private: "shield" };

export default function ModelPage() {
  const [id, setId] = useState(null);
  const [all, setAll] = useState(null);
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState("");
  const [route, setRoute] = useState("balanced");
  const healthMap = useModelHealth(id || null); // update 17: null unless the router has it on
  const priceHistory = useUpdate("price-history")?.on === true; // update 22: shown only where the router released it

  useEffect(() => {
    setId(new URLSearchParams(window.location.search).get("id") || "");
  }, []);
  useEffect(() => {
    if (id === null) return;
    if (!id) { setError("No model was named. Choose one from the catalog."); return; }
    let live = true;
    Promise.all([api("/api/v1/models"), api(`/api/v1/models/${id.split("/").map(encodeURIComponent).join("/")}/endpoints`)])
      .then(([list, one]) => { if (live) { setAll(list.data); setDetail(one.data); } })
      .catch((e) => live && setError(e.status === 404 ? `There is no model called ${id} in the live catalog.` : e.message));
    return () => { live = false; };
  }, [id]);

  const model = useMemo(() => all?.find((m) => m.id === id) || null, [all, id]);
  const rows = useMemo(() => providerRows(detail?.endpoints || []), [detail]);
  // Rows in the order the chosen route tries them: by rank, or by share for the default; excluded rows last.
  const routed = useMemo(() => routeRows(rows, route).sort((a, b) => (a.excluded ? 1 : 0) - (b.excluded ? 1 : 0) || (a.rank ?? 99) - (b.rank ?? 99) || (b.share ?? 0) - (a.share ?? 0)), [rows, route]);
  const summary = useMemo(() => modelSummary(model, rows), [model, rows]);
  const similar = useMemo(() => similarModels(all || [], model), [all, model]);
  const choice = ROUTES.find((r) => r.key === route);
  const nobody = route !== "balanced" && !routed.some((r) => r.rank) || route === "balanced" && !routed.some((r) => r.share);

  if (error) return <main className="page-main" id="content"><div className={s.empty}><h1>Model not found</h1><p>{error}</p><a className="ar-button" href="/models/">Browse models</a></div></main>;
  if (!detail || !all) return <main className="page-main" id="content"><div className={s.empty} role="status"><span className="loading-bar" aria-hidden="true" />Loading the model…</div></main>;

  const card = model ? toCatalogModel(model) : { name: detail.name, author: id.split("/")[0], description: detail.description };
  const callId = id + choice.suffix;
  const snippet = `curl ${typeof window === "undefined" ? "" : window.location.origin}/api/v1/chat/completions \\\n  -H "Authorization: Bearer $TRELLIS_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '{"model": "${callId}",\n       "messages": [{"role": "user", "content": "Hello"}]}'`;

  return (
    <main className={`page-main ${s.page}`} id="content">
      <nav aria-label="Breadcrumb" className={s.crumbs}><a href="/models/">Models</a><span aria-hidden="true">/</span><span>{card.name}</span></nav>

      <header className={s.head}>
        <div className={s.title}>
          <span className={s.avatar} aria-hidden="true" style={{ "--h": hue(card.author) }}>{String(card.author || "?")[0].toUpperCase()}</span>
          <div>
            <span className={s.livePill}><i aria-hidden="true" />Live · measured on real traffic</span>
            <h1>{card.name}</h1>
            <p className={s.byline}>
              <span>by {card.author}</span>
              <code>{id}</code>
              <CopyButton text={id} label="Copy ID" />
            </p>
            {model?.description && <p className={s.lede}>{model.description}</p>}
          </div>
        </div>
        <div className={s.actions}>
          <a className={`ar-button ${s.withIcon}`} href={"/harness/?model=" + encodeURIComponent(id)}><Icon name="chat" size={16} />Try in Chat</a>
          <a className={`ar-button secondary ${s.withIcon}`} href="#call"><Icon name="code" size={16} />Use the API</a>
        </div>
      </header>

      <ul className={s.badges} aria-label="What this model offers">
        <li className={s.receiptBadge}><Icon name="receipt" size={14} />Signed receipt on every answer</li>
        {summary.attested > 0 && <li className={s.hardwareBadge}><Icon name="shield" size={14} />Attested hardware available</li>}
        {model && <li className={s.caps}><CapabilityChips model={model} dark /></li>}
      </ul>

      <dl className={s.summary}>
        {[
          ["context", "Context", summary.context ? formatContext(summary.context) : "—", "tokens"],
          ["arrowIn", "Input, from", usdPerM(summary.input), "/ 1M"],
          ["arrowOut", "Output, from", usdPerM(summary.output), "/ 1M"],
          ["server", "Providers", String(summary.providers), summary.attested > 0 ? `· ${summary.attested} attested` : ""],
          ["pulse", "Uptime, 30 days", summary.uptime === null ? "—" : summary.uptime + "%", ""],
        ].map(([icon, label, value, unit]) => (
          <div key={label}>
            <dt><Icon name={icon} size={15} />{label}</dt>
            <dd>{value} {unit && <small>{unit}</small>}</dd>
          </div>
        ))}
      </dl>

      {healthMap && (() => {
        const h = healthMap.get(id);
        return (
          <section aria-labelledby="health" className={s.section} data-model-health={healthTone(h)}>
            <h2 id="health"><IconTile name="pulse" size={36} icon={17} />Health, last 24 hours</h2>
            {h?.attempts ? (
              <dl className={`${s.summary} ${s.healthSummary}`}>
                {healthFigures(h).map(([label, value, unit]) => (
                  <div key={label}><dt>{label}</dt><dd>{value} {unit && <small>{unit}</small>}</dd></div>
                ))}
              </dl>
            ) : <p>No calls to this model in the last 24 hours.</p>}
            <p className={s.muted}>{HEALTH_NOTE}{h?.attempts && h.success_rate === null ? " Too few calls to give a rate yet." : ""}</p>
          </section>
        );
      })()}

      <section aria-labelledby="who" className={s.section}>
        <div className={s.sectionHead}>
          <div>
            <h2 id="who"><IconTile name="server" size={36} icon={17} />Who runs it</h2>
            <p>The same model from each provider, measured by Trellis on real traffic. Prices are the provider’s, with nothing added.</p>
          </div>
          <div className={s.routePick}>
            <span id="route-label">Route my calls</span>
            <div role="radiogroup" aria-labelledby="route-label" className={s.segmented}>
              {ROUTES.map((r) => (
                <button key={r.key} type="button" role="radio" aria-checked={route === r.key} onClick={() => setRoute(r.key)}><Icon name={ROUTE_ICON[r.key]} size={15} />{r.label}</button>
              ))}
            </div>
          </div>
        </div>

        <div className={s.tableBox}>
          <table className={s.table}>
            <caption className="sr-only">Providers for {card.name}, ordered for the {choice.label.toLowerCase()} route</caption>
            <thead>
              <tr>
                <th scope="col">Provider</th>
                <th scope="col">Privacy</th>
                <th scope="col" className={s.num}>Input / 1M</th>
                <th scope="col" className={s.num}>Output / 1M</th>
                <th scope="col" className={s.num}>First token · speed</th>
                <th scope="col">Uptime, 30 days</th>
                <th scope="col">{route === "balanced" ? "Share of calls" : "Order"}</th>
              </tr>
            </thead>
            <tbody>
              {routed.map((r) => (
                <tr key={r.slug} data-first={r.rank === 1 || undefined} data-excluded={r.excluded ? true : undefined}>
                  <td>
                    <div className={s.provider}>
                      <span className={s.initials} aria-hidden="true" style={{ "--h": hue(r.slug) }}>{r.initials}</span>
                      <span>
                        <b>{r.name}</b>
                        <small>{[r.quantization, r.context ? formatContext(r.context) + " context" : null].filter(Boolean).join(" · ")}</small>
                      </span>
                    </div>
                  </td>
                  <td>
                    <div className={s.privacy}>
                      {r.attested && <span className={s.hardwareBadge}><Icon name="shield" size={12} />Attested hardware</span>}
                      <small><Icon name={r.data === "Keeps prompts" ? "eye" : "archive"} size={12} />{r.data}</small>
                    </div>
                  </td>
                  <td className={s.num}>{usdPerM(r.input)}</td>
                  <td className={s.num}>{usdPerM(r.output)}</td>
                  <td className={s.num}>{r.latency === null && r.throughput === null ? <span className={s.muted} title="Not enough traffic in the last 30 minutes">Not measured yet</span> : <>{r.latency === null ? "—" : Math.round(r.latency) + " ms"}<small className={s.sub}>{r.throughput === null ? "—" : Math.round(r.throughput) + " tok/s"}</small></>}</td>
                  <td>
                    {r.uptime === null ? <span className={s.muted}>Not measured yet</span> : (
                      <div className={s.uptime}>
                        <span className={s.meter} role="img" aria-label={`${r.uptime}% of calls succeeded in the last 30 days`}><i style={{ width: Math.max(2, r.uptime) + "%" }} /></span>
                        <span>{r.uptime}%</span>
                      </div>
                    )}
                  </td>
                  <td>
                    {r.excluded ? <span className={s.muted}>{r.excluded}</span>
                      : r.share !== null ? <span className={s.share}><span className={s.shareBar} aria-hidden="true"><i style={{ width: Math.max(3, r.share * 100) + "%" }} /></span>{Math.round(r.share * 100)}%</span>
                      : r.rank === 1 ? <span className={s.first}><Icon name={ROUTE_ICON[route]} size={12} strokeWidth={2} />Tried first</span>
                      : <span className={s.muted}>{ordinal(r.rank)}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className={s.note} role="status">
          <IconTile name={ROUTE_ICON[route]} tone="amber" size={38} icon={18} />
          <p><strong>{choice.title}</strong> {choice.text}{nobody && <> <b className={s.warn}>No provider can take this route for this model right now, so such a call would be refused.</b></>} <a href="/trust/">How we check providers</a></p>
        </div>
      </section>

      {priceHistory && <PriceHistory id={id} />}

      <section id="call" aria-labelledby="call-title" className={s.split}>
        <div>
          <h2 id="call-title"><IconTile name="code" size={34} icon={16} />Call it</h2>
          <p>Any OpenAI-compatible client works. The model ID follows the route you picked above.</p>
          <div className={s.code}>
            <div className={s.codeHead}><span>curl</span><CopyButton text={snippet} /></div>
            <pre>{snippet}</pre>
          </div>
        </div>
        <div>
          <h2><IconTile name="receipt" tone="amber" size={34} icon={16} />What each answer’s receipt records</h2>
          <p>Signed by Trellis, batched every hour and anchored on Solana. No prompt or answer text is in it.</p>
          <dl className={s.records}>
            {[
              ["layers", "Model", id],
              ["server", "Provider", "Who ran it"],
              ["context", "Tokens", "In and out"],
              ["coins", "Cost", "Exact, in USDC"],
              ["chip", "Hardware", "The attestation, when there is one"],
              ["anchor", "Anchor", "The hour’s Solana root"],
            ].map(([icon, k, v]) => <div key={k}><dt><Icon name={icon} size={15} />{k}</dt><dd>{v}</dd></div>)}
          </dl>
          <a className={s.more} href="/trust/#check"><Icon name="shieldCheck" size={15} />Verify a receipt</a>
        </div>
      </section>

      {similar.length > 0 && (
        <section aria-labelledby="similar" className={s.section}>
          <h2 id="similar"><IconTile name="sparkles" size={36} icon={17} />Similar models</h2>
          <div className={s.similar}>
            {similar.map((m) => {
              const c = toCatalogModel(m);
              return (
                <a key={m.id} href={modelHref(m.id)}>
                  <span className={s.simTop}><span className={s.initials} aria-hidden="true" style={{ "--h": hue(c.author) }}>{c.author[0]}</span><b>{c.name}</b><Icon name="external" size={14} /></span>
                  <code>{m.id}</code>
                  <span>{usdPerM(c.price)} in · {usdPerM(c.output)} out</span>
                </a>
              );
            })}
          </div>
        </section>
      )}
    </main>
  );
}

/** A steady hue per name, so each provider and maker keeps its own colour. */
function hue(name) {
  let h = 0;
  for (const c of String(name)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return Math.round((h * 137.508) % 360);
}

function ordinal(n) {
  return n === 2 ? "Second" : n === 3 ? "Third" : n ? `${n}th` : "—";
}
