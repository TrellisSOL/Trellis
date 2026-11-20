'use client';
import {useEffect,useRef,useState} from 'react';
import {Lockup} from './landing/Mark';
import shell from './SiteShell.module.css';
import InstallApp from './harness/InstallApp';
import AccountStrip from './nav/AccountStrip'; // U105: signed-in balance and bell (replaces the U78 inbox bell).
// NAV1: shared task disclosures and search.
import {DesktopGroups,MobileGroups} from './nav/GroupMenus';
import SearchButton from './nav/SearchButton';
import SiteSearch from './nav/SiteSearch';
import LanguageSwitch from './i18n/LanguageSwitch';
import {useT} from '../lib/i18n/use-locale.js';

export function Button({children,href,secondary=false,light=false,className='',...props}){const cls='ar-button'+(secondary?' secondary':'')+(light?' light':'')+(className?' '+className:'');const inner=<>{!secondary&&<i aria-hidden="true"/>}<span>{children}</span><b aria-hidden="true">→</b></>;return href?<a className={cls} href={href} {...props}>{inner}</a>:<button className={cls} {...props}>{inner}</button>}

export function Brand() {
  const t = useT();
  return <a href="/" className={shell.brand} aria-label={t('nav.home')}>
    <Lockup className={shell.lockup} markClass={shell.mark} wordClass={shell.word}/>
  </a>;
}

export function Header({app=false}) {
  const [open, setOpen] = useState(false);
  const [path, setPath] = useState('');
  const trigger = useRef(null);
  const drawer = useRef(null);
  const t = useT();
  useEffect(() => {
    setPath(location.pathname);
    const desktop = matchMedia('(min-width: 961px)');
    const resize = () => { if (desktop.matches) setOpen(false); };
    desktop.addEventListener('change', resize);
    return () => desktop.removeEventListener('change', resize);
  }, []);
  useEffect(() => {
    if (!open) return;
    const node = drawer.current;
    const previous = document.documentElement.style.overflow;
    document.documentElement.style.overflow = 'hidden';
    node.showModal();
    return () => {
      node.close();
      document.documentElement.style.overflow = previous;
      trigger.current?.focus();
    };
  }, [open]);
  const close = () => setOpen(false);
  const inChat = app && /^\/harness\/?$/.test(path);
  return <>
    <a className="skip" href="#content">{t('nav.skip')}</a>
    <header className={shell.header}>
      <nav className={shell.bar} aria-label={t('nav.main')}>
        <Brand/>
        <DesktopGroups path={path}/>
        <div className={shell.actions}>
          <AccountStrip/>
          <SearchButton hint={!inChat}/>
          <LanguageSwitch/>
          {inChat && <span className="install-slot"><InstallApp/></span>}
          <a className={shell.dashboard} href="/dashboard/">{t('nav.dashboard')}</a>
          <button type="button" ref={trigger} className={shell.menuButton} aria-label={t('nav.open')} aria-expanded={open} aria-controls="mobile-menu" onClick={() => setOpen(true)}>
            <span aria-hidden="true"/><span aria-hidden="true"/>
          </button>
        </div>
      </nav>
    </header>
    {open && <dialog ref={drawer} id="mobile-menu" className={shell.drawer} aria-labelledby="mobile-menu-title" onCancel={close}>
      <div className={shell.drawerBar}>
        <h2 id="mobile-menu-title">{t('nav.explore')}</h2>
        <button type="button" onClick={close} aria-label={t('nav.close')}>{t('nav.closeShort')}</button>
      </div>
      <nav className={shell.drawerNav} aria-label={t('nav.mobile')}>
        <a className={shell.drawerDashboard} href="/dashboard/" onClick={close}>{t('nav.dashboard')}</a>
        <MobileGroups onNavigate={close}/>
        {inChat && <InstallApp/>}
      </nav>
    </dialog>}
    <SiteSearch/>
  </>;
}

/** Page-wide motion: scroll reveals, count-ups, cursor spotlights and scroll progress. Respects reduced motion. */
export function MotionManager(){
  useEffect(()=>{
    const reduced=matchMedia('(prefers-reduced-motion: reduce)').matches;
    document.querySelectorAll('[data-stagger]').forEach(parent=>[...parent.children].forEach((child,i)=>child.style.setProperty('--i',i)));
    const count=el=>{const target=Number(el.dataset.count);const decimals=Number(el.dataset.decimals||0);const fmt=v=>v.toLocaleString('en-US',{minimumFractionDigits:decimals,maximumFractionDigits:decimals});if(reduced){el.textContent=fmt(target);return}const start=performance.now(),dur=1600;const step=t=>{const p=Math.min(1,(t-start)/dur);el.textContent=fmt(target*(1-Math.pow(1-p,4)));if(p<1)requestAnimationFrame(step)};requestAnimationFrame(step)};
    const io=new IntersectionObserver(entries=>entries.forEach(({target,isIntersecting})=>{if(!isIntersecting)return;target.classList.add('is-in');target.querySelectorAll('[data-count]').forEach(count);if(target.dataset.count)count(target);io.unobserve(target)}),{threshold:.14,rootMargin:'0px 0px -6% 0px'});
    const watch=root=>{if(root.nodeType!==1)return;if(root.matches('[data-reveal],[data-inview]')&&!root.classList.contains('is-in'))io.observe(root);root.querySelectorAll('[data-reveal]:not(.is-in),[data-inview]:not(.is-in)').forEach(el=>io.observe(el));root.querySelectorAll('[data-stagger]').forEach(parent=>[...parent.children].forEach((child,i)=>child.style.setProperty('--i',i)))};
    watch(document.body);const mo=new MutationObserver(list=>list.forEach(m=>m.addedNodes.forEach(watch)));mo.observe(document.body,{childList:true,subtree:true});
    const spots=[...document.querySelectorAll('[data-spot]')];const move=e=>{const el=e.currentTarget;const r=el.getBoundingClientRect();el.style.setProperty('--mx',`${e.clientX-r.left}px`);el.style.setProperty('--my',`${e.clientY-r.top}px`)};spots.forEach(el=>el.addEventListener('pointermove',move));
    const bars=[...document.querySelectorAll('[data-progress]')];let raf=0;const progress=()=>{raf=0;const vh=innerHeight;bars.forEach(el=>{const r=el.getBoundingClientRect();const p=Math.min(1,Math.max(0,(vh*.85-r.top)/(r.height+vh*.25)));el.style.setProperty('--p',reduced?1:p.toFixed(3));el.dispatchEvent(new CustomEvent('progress',{detail:p}))})};const onScroll=()=>{if(!raf)raf=requestAnimationFrame(progress)};if(bars.length){progress();addEventListener('scroll',onScroll,{passive:true});addEventListener('resize',onScroll)}
    return()=>{io.disconnect();mo.disconnect();spots.forEach(el=>el.removeEventListener('pointermove',move));removeEventListener('scroll',onScroll);removeEventListener('resize',onScroll);cancelAnimationFrame(raf)};
  },[]);
  return null;
}

/** Text that decodes from noise into its value whenever the value changes. */
export function Scramble({text,className=''}){
  const [out,setOut]=useState(text);
  useEffect(()=>{if(matchMedia('(prefers-reduced-motion: reduce)').matches){setOut(text);return}const glyphs='0123456789abcdef#%/<>_';let frame=0,raf;const total=18;const tick=()=>{frame++;setOut([...text].map((c,i)=>c===' '||i<(frame/total)*text.length?c:glyphs[(Math.random()*glyphs.length)|0]).join(''));if(frame<total)raf=requestAnimationFrame(tick);else setOut(text)};raf=requestAnimationFrame(tick);return()=>cancelAnimationFrame(raf)},[text]);
  return <span className={'scramble '+className}>{out}</span>;
}

export function CopyButton({text,label='Copy'}){const [status,setStatus]=useState('');useEffect(()=>{if(!status)return;const t=setTimeout(()=>setStatus(''),1800);return()=>clearTimeout(t)},[status]);return <button className="text-button" onClick={async()=>{try{await navigator.clipboard.writeText(text);setStatus('Copied')}catch{setStatus('Select and copy below')}}}>{status||label}</button>}

const TOKEN=/(\/\/[^\n]*)|("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`[^`]*`)|\b(const|let|await|new|import|from|export|default|async|function|return|true|false|null)\b|\b(\d[\d_.]*)\b/g;
/** Minimal JS/JSON highlighter for code samples. */
export function highlight(src){const out=[];let last=0,m,k=0;TOKEN.lastIndex=0;while((m=TOKEN.exec(src))){if(m.index>last)out.push(src.slice(last,m.index));const cls=m[1]?'tok-c':m[2]?'tok-s':m[3]?'tok-k':'tok-n';out.push(<span key={k++} className={cls}>{m[0]}</span>);last=m.index+m[0].length}if(last<src.length)out.push(src.slice(last));return out}

export function Code({children,label='Example request'}){return <div className="code-panel"><div className="code-bar"><span>{label}</span><CopyButton text={children}/></div><pre><code>{highlight(children)}</code></pre></div>}

export function Modal({title,children,onClose}){const ref=useRef(null);useEffect(()=>{const dlg=ref.current;dlg.showModal();return()=>dlg.close()},[]);return <dialog ref={ref} className="modal" onCancel={onClose} onClick={e=>{if(e.target===e.currentTarget)onClose()}} aria-labelledby="modal-title"><div className="modal-head"><h2 id="modal-title">{title}</h2><button aria-label="Close dialog" className="icon-button" onClick={onClose}>×</button></div>{children}</dialog>}
