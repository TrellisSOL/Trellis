"use client";
// Price history (update 22): a model's lowest input and output price per million tokens over time, as the router
// recorded it each time a price changed. Shown on the model page only where the router has released the update.
import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import { usdPerM } from "../lib/model-page.js";
import { RANGES, pricesPath, seriesPath, shortDate, stepSeries, yTicks } from "../lib/price-history.js";
import { IconTile } from "./Icons";
import m from "./ModelPage.module.css";
import s from "./PriceHistory.module.css";

const W = 720, H = 220;

export default function PriceHistory({ id }) {
  const [days, setDays] = useState(90);
  const [data, setData] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let live = true;
    setError("");
    api(pricesPath(id, days)).then((r) => live && setData(r.data)).catch((e) => live && setError(e.message));
    return () => { live = false; };
  }, [id, days]);

  const chart = useMemo(() => (data ? stepSeries(data) : null), [data]);
  const axis = useMemo(() => yTicks(chart?.max ?? 0), [chart]);

  return (
    <section aria-labelledby="price-history" className={m.section}>
      <div className={m.sectionHead}>
        <div>
          <h2 id="price-history"><IconTile name="coins" size={36} icon={17} />Price history</h2>
          <p>The lowest price any live provider asks for this model, per million tokens. Trellis records it each time it changes, so a flat line means no change was seen.</p>
        </div>
        <div role="radiogroup" aria-label="Range" className={m.segmented}>
          {RANGES.map((r) => (
            <button key={r.days} type="button" role="radio" aria-checked={days === r.days} onClick={() => setDays(r.days)}>{r.label}</button>
          ))}
        </div>
      </div>

      <div className={s.box}>
        {error ? <p className="error" role="alert">{error}</p>
          : !data ? <p className={s.note} role="status"><span className="loading-bar" aria-hidden="true" />Loading the price history…</p>
          : !chart ? <p className={s.note}>No price has been recorded for this model yet. The first one is recorded on the router’s next catalogue refresh.</p>
          : <>
            <ul className={s.legend}>
              <li><i className={s.input} aria-hidden="true" />Input {usdPerM(chart.input.at(-1)[1])} <small>/ 1M now</small></li>
              <li><i className={s.output} aria-hidden="true" />Output {usdPerM(chart.output.at(-1)[1])} <small>/ 1M now</small></li>
              <li className={s.count}>{chart.changes === 0 ? "No change in this range" : chart.changes === 1 ? "1 recorded price" : `${chart.changes} recorded prices`}{data.truncated ? " (the latest shown)" : ""}</li>
            </ul>
            <svg className={s.chart} viewBox={`-56 -12 ${W + 68} ${H + 40}`} role="img" aria-label={`Input and output price of ${id} from ${shortDate(chart.from)} to ${shortDate(chart.to)}`}>
              {axis.ticks.map((v) => {
                const y = H - (v / axis.top) * H;
                return <g key={v}><line x1="0" x2={W} y1={y} y2={y} className={s.grid} /><text x="-10" y={y + 4} textAnchor="end" className={s.tick}>{usdPerM(v)}</text></g>;
              })}
              <text x="0" y={H + 24} className={s.tick}>{shortDate(chart.from)}</text>
              <text x={W} y={H + 24} textAnchor="end" className={s.tick}>{shortDate(chart.to)}</text>
              <path d={seriesPath(chart.output, chart.from, chart.to, axis.top, W, H)} className={s.outputLine} />
              <path d={seriesPath(chart.input, chart.from, chart.to, axis.top, W, H)} className={s.inputLine} />
            </svg>
            {data.points.length > 0 && (
              <details className={s.changes}>
                <summary>Recorded prices</summary>
                <table>
                  <thead><tr><th scope="col">When</th><th scope="col">Input / 1M</th><th scope="col">Output / 1M</th><th scope="col">Providers</th></tr></thead>
                  <tbody>{[...data.points].reverse().map((p) => (
                    <tr key={p.at}><td>{new Date(p.at).toLocaleString()}</td><td>{usdPerM(p.input_usd_per_m)}</td><td>{usdPerM(p.output_usd_per_m)}</td><td>{p.providers}</td></tr>
                  ))}</tbody>
                </table>
              </details>
            )}
          </>}
      </div>
    </section>
  );
}
