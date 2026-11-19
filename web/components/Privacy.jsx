'use client';
import {useEffect,useRef,useState} from 'react';
import {Scramble} from './UI';

// The first point (encrypted chat) is outside the core launch surface; the stylesheet hides it when the router reports `core`.
const POINTS=[['End-to-end encrypted chat','The client encrypts on your device; the attested gateway handles inference while the router forwards ciphertext.'],['Other request paths','Trellis’s router reads request text in memory to route it. Attested serving alone does not hide prompts from the router.'],['Evidence and stored records','Inspect signed receipts, the key transparency log and the data inventory. Receipts store hashes, token counts and cost, not prompt or answer text.']];
const STEPS=['Request :private','Quote verified','Route selected','Receipt signed'];
const hex=n=>Array.from({length:n},()=>'0123456789abcdef'[(Math.random()*16)|0]).join('');
const FIRST={quote:'sha256:9c41e0b2…a1f307e2',nonce:'5e2a…c91d'};
const DONE=STEPS.length+1;

/** Private route walkthrough: the attestation card steps through its checks while visible, and shows the end state under reduced motion. */
export default function Privacy(){
  const ref=useRef(null);const [step,setStep]=useState(DONE);const [ev,setEv]=useState(FIRST);
  useEffect(()=>{
    if(matchMedia('(prefers-reduced-motion: reduce)').matches)return;
    setStep(0);let timers=[],cycle=0,visible=false;
    const clear=()=>{timers.forEach(clearTimeout);timers=[]};
    const run=()=>{clear();setStep(0);if(cycle++)setEv({quote:`sha256:${hex(8)}…${hex(8)}`,nonce:`${hex(4)}…${hex(4)}`});[600,1500,2400,3300,4100].forEach((t,i)=>timers.push(setTimeout(()=>setStep(i+1),t)));timers.push(setTimeout(run,8000))};
    const io=new IntersectionObserver(([e])=>{if(e.isIntersecting&&!visible){visible=true;run()}else if(!e.isIntersecting&&visible){visible=false;clear()}},{threshold:.35});
    io.observe(ref.current);return()=>{io.disconnect();clear()};
  },[]);
  const rows=[
    ['request','llama-3.3-70b:private',1],
    ['tee','intel tdx + nvidia cc',2],
    ['nonce',`${ev.nonce} · bound`,2],
    ['quote',<Scramble text={ev.quote}/>,2],
    ['freshness','attested 4 min ago',2],
    ['router', 'reads ordinary requests in memory',3],
    ['receipt',<>attestation <Scramble text={ev.quote}/></>,4],
  ];
  const done=step>=DONE;
  return <section className="section muted-surface" id="privacy"><div className="container split">
    <div className="split-copy">
      <div data-reveal><h2 className="h2">Attestation checks</h2><p className="lede">On the public route, the router and the inference provider can read the request. The example shows the additional checks a route requiring fresh attestation would perform.</p></div>
      <div className="points" data-stagger>{POINTS.map(([t,b],i)=><div className="point" key={t} data-reveal {...(i===0?{'data-surface-extra':''}:{})}><i aria-hidden="true"/><h3>{t}</h3><p>{b}</p></div>)}</div>
      <p data-reveal style={{marginTop:24}}><a className="inline-link" href="/verify/">Check what the router has verified about any provider</a> · <span data-surface-extra=""><a className="inline-link" href="/docs/#e2ee-gateway">Encrypted chat</a> · </span><a className="inline-link" href="/keep/">What we keep</a></p>
    </div>
    <div data-reveal><div ref={ref} className={'attest'+(done?' done':'')} role="figure" aria-label="Example private route: attestation checks from request to signed receipt">
      <div className="panel-bar"><span>Private route · example</span><span>fail-closed</span></div>
      <div className="attest-steps" role="list">{STEPS.map((s,i)=><div key={s} role="listitem" className={step>i?'on':''}>{s}</div>)}</div>
      <div className="attest-body shielded">
        <svg className="shield" viewBox="0 0 48 48" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M24 5.5l15 6v11.5c0 9.3-6.4 16.3-15 19.5C15.4 39.3 9 32.3 9 23V11.5z"/><path className="check" d="M17.5 24l4.5 4.5 9-10" pathLength="1"/></svg>
        <dl>{rows.map(([k,v,at])=>{const wait=step<at;return <div key={k} className={'attest-row'+(wait?' wait':'')}><dt>{k}</dt><dd>{wait?'pending':v}</dd></div>})}</dl>
      </div>
      <div className={'verdict'+(done?' ok':'')}><i aria-hidden="true">✓</i><span>{done?'Attestation verified · route allowed':'Verifying attestation…'}</span></div>
    </div></div>
  </div></section>;
}
