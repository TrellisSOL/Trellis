'use client';
import {useRef,useState} from 'react';
import {CopyButton,highlight} from './UI';
import {useLaunchSurface} from './launch/Surface';

const ALL_MODES=[
  {title:'Standard inference',label:'chat/completions',
    code:`const res = await client.chat.completions.create({
  model: "meta-llama/llama-3.3-70b-instruct",
  messages,
  provider: { sort: "price", allow_fallbacks: true },
});

res.provider;        // who served it
res.usage.cost;      // what it cost, in USDC
res.receipt.sig;     // Ed25519 signature`,
    flow:[['Filter','health, price, data policy'],['Route','best provider, fallbacks ready'],['Receipt','signed, itemized, anchored']]},
  {title:'Attested private route',label:'private route',
    code:`const res = await client.chat.completions.create({
  model: "meta-llama/llama-3.3-70b-instruct:private",
  messages,
});

// Only freshly attested TEE providers qualify.
res.receipt.payload.attestation;  // quote hash
res.provider;                      // the attested host`,
    flow:[['Attest','TDX quote + GPU evidence'],['Select','fresh attestations only'],['Prove','hash in the receipt']]},
  {extra:true,title:'End-to-end encrypted chat',label:'encrypted chat path',
    code:`// The client encrypts on your device.
// Trellis's router forwards ciphertext to the attested gateway.
// The gateway handles inference and encrypts the response.
// Follow /docs/#e2ee-gateway for the client flow.

// Other request paths are read in memory by the router.
// Attestation alone does not hide prompts from the router.`,
    flow:[['Encrypt','client on your device'],['Forward','ciphertext through the router'],['Infer','attested gateway']]},
];

const CORE_MODES = ALL_MODES.filter(mode => !mode.extra);

export default function RouteModes() {
  const modes = useLaunchSurface().surface === 'core' ? CORE_MODES : ALL_MODES;
  const [selected, setSelected] = useState(0);
  const active = selected < modes.length ? selected : 0;
  const mode = modes[active];
  const tabs = useRef(null);
  function handleKey(event) {
    const index = {ArrowDown:(active + 1) % modes.length, ArrowUp:(active + modes.length - 1) % modes.length, Home:0, End:modes.length - 1}[event.key];
    if (index === undefined) return;
    event.preventDefault();
    setSelected(index);
    tabs.current.querySelectorAll('[role="tab"]')[index].focus();
  }
  return <section className="section" id="routes" aria-labelledby="route-types-title"><div className="container">
    <div className="section-head"><div><h2 id="route-types-title">Routing examples</h2></div>
      <p className="lede">The launch catalog serves public routes. Check the model’s available endpoints before requesting attestation.</p>
    </div>
    <div className="modes">
      <div className="mode-tabs" role="tablist" ref={tabs} aria-label="Routing example" aria-orientation="vertical" onKeyDown={handleKey}>
        {modes.map((item,index) => <button key={item.title} type="button" className="mode-tab" role="tab"
          {...(item.extra ? {'data-surface-extra':''} : {})} id={`mode-tab-${index}`} aria-controls="mode-panel"
          aria-selected={index === active} tabIndex={index === active ? 0 : -1} onClick={() => setSelected(index)}>
          {item.title}
        </button>)}
      </div>
      <div className="mode-panel" role="tabpanel" id="mode-panel" aria-labelledby={`mode-tab-${active}`} tabIndex="0">
        <div className="code-bar"><span>{mode.label}</span><CopyButton text={mode.code}/></div>
        <pre><code>{highlight(mode.code)}</code></pre>
        <div className="mode-flow">{mode.flow.map(([label,value]) => <div key={label}><b>{label}</b>{value}</div>)}</div>
      </div>
    </div>
  </div></section>;
}
