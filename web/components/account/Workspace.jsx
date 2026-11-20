'use client';
import { useEffect, useRef, useState } from 'react';
import AccountStrip from '../nav/AccountStrip';
import SiteSearch from '../nav/SiteSearch';
import { openSiteSearch } from '../nav/SearchButton';
import { Lockup } from '../landing/Mark';
import { ACCOUNT_SECTIONS } from '../../lib/site-map.js';
import { MEDIA_PAGES, PAGES, moreGroups, pageOf, pageSections } from './workspace-map.js';
import { useUpdate } from '../media/useUpdate.js';
import '../nav/nav.css'; // The search dialog's styles; the site header usually brings them.
import w from './Workspace.module.css';

const section = id => ACCOUNT_SECTIONS.find(item => item.taskId === id);
// A plain click on a section stays on the page; modified clicks follow the link.
const go = (target, onNavigate, after) => event => {
  after?.();
  if (!onNavigate || !target?.hash || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault(); onNavigate(target.title);
};

/** One open popover at a time: closes on Escape, on a click outside, and when focus leaves it. */
function usePopover() {
  const [open, setOpen] = useState(false);
  const root = useRef(null);
  useEffect(() => {
    if (!open) return;
    const away = event => { if (!root.current?.contains(event.target)) setOpen(false); };
    const key = event => { if (event.key === 'Escape') { setOpen(false); root.current?.querySelector('button')?.focus(); } };
    document.addEventListener('pointerdown', away); document.addEventListener('keydown', key);
    return () => { document.removeEventListener('pointerdown', away); document.removeEventListener('keydown', key); };
  }, [open]);
  return { open, setOpen, root };
}

const Chevron = () => <svg className={w.chevron} viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/></svg>;

function MenuLink({ target, href, label, onNavigate, close, icon }) {
  return <a role="menuitem" href={target ? target.href : href} onClick={target ? go(target, onNavigate, close) : close}>
    {icon && <img src={`/dashboard-icons/${icon}.png`} alt="" width="20" height="20"/>}{label}
  </a>;
}

/** The key this tab uses, as a picker: what it is, and what you can do with it. */
function KeyPicker({ apiKey, onNavigate, onDisconnect }) {
  const { open, setOpen, root } = usePopover();
  const close = () => setOpen(false);
  const short = apiKey ? `${apiKey.slice(0, 9)}…${apiKey.slice(-4)}` : '';
  return <div className={w.picker} ref={root}>
    <button type="button" className={w.pill} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(o => !o)}>
      <i className={w.keyDot} data-on={apiKey ? '' : undefined} aria-hidden="true"/>
      <span>{apiKey ? 'Account key' : 'No key connected'}</span>
      <Chevron/>
    </button>
    {open && <div className={`${w.menu} ${w.menuDown}`} role="menu" aria-label="Key">
      <p className={w.menuHead}>{apiKey ? 'This tab’s key' : 'Connect a key'}</p>
      {apiKey && <p className={w.menuNote}><code>{short}</code> stays in this tab until you disconnect.</p>}
      {!apiKey && <p className={w.menuNote}>Sign in with a Solana wallet or paste a key on Home.</p>}
      {apiKey
        ? <><MenuLink target={section('account-keys')} label="Manage keys" icon="keys" onNavigate={onNavigate} close={close}/>
          <MenuLink target={section('account-payments')} label="Add funds" icon="purse" onNavigate={onNavigate} close={close}/>
          <button type="button" role="menuitem" className={w.menuDanger} onClick={() => { close(); onDisconnect?.(); }}>Disconnect this key</button></>
        : <MenuLink target={section('dashboard')} label="Connect a key" icon="keys" onNavigate={onNavigate} close={close}/>}
    </div>}
  </div>;
}

/** The round account button and its menu. */
function AccountMenu({ onNavigate }) {
  const { open, setOpen, root } = usePopover();
  const close = () => setOpen(false);
  return <div className={w.picker} ref={root}>
    <button type="button" className={w.avatar} aria-label="Account menu" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(o => !o)}>
      <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="9" r="3.6" fill="currentColor"/><path d="M5.5 19c1.2-3.2 3.7-4.8 6.5-4.8s5.3 1.6 6.5 4.8" fill="currentColor"/></svg>
    </button>
    {open && <div className={`${w.menu} ${w.menuDown} ${w.menuEnd}`} role="menu" aria-label="Account">
      <p className={w.menuHead}>Your account</p>
      <MenuLink target={section('settings')} label="Account & settings" icon="settings" onNavigate={onNavigate} close={close}/>
      <MenuLink target={section('api-receipts')} label="Receipts" icon="receipts" onNavigate={onNavigate} close={close}/>
      <MenuLink href="/docs/" label="API docs" icon="models" close={close}/>
      <MenuLink href="/" label="Trellis website" icon="home" close={close}/>
    </div>}
  </div>;
}

/** The workspace bar: on Chat the picker sits left and the mark in the middle; on every other page the reverse. */
export function TopBar({ chat, apiKey, onNavigate, onDisconnect }) {
  const brand = <a className={w.brand} href="/" aria-label="Trellis home"><Lockup className={w.lockup} markClass={w.lockupMark} wordClass={w.lockupWord}/></a>;
  const picker = <KeyPicker apiKey={apiKey} onNavigate={onNavigate} onDisconnect={onDisconnect}/>;
  return <>
    <header className={w.top} data-chat={chat ? '' : undefined}>
      <div className={w.topStart}>{chat ? picker : brand}</div>
      <div className={w.topMiddle}>{chat ? brand : picker}</div>
      <div className={w.topEnd}><AccountStrip/><AccountMenu onNavigate={onNavigate}/></div>
    </header>
    <SiteSearch/>
  </>;
}

/** The More menu, above the dock: every section this router offers, under its account group. */
function More({ current, surface, onNavigate }) {
  const { open, setOpen, root } = usePopover();
  const close = () => setOpen(false);
  const inMore = !PAGES.some(page => page.ids.includes(ACCOUNT_SECTIONS.find(s => s.title === current)?.taskId));
  return <div className={w.more} ref={root}>
    <button type="button" className={w.dockItem} aria-label="More" title="More" aria-haspopup="menu" aria-expanded={open} aria-current={inMore ? 'page' : undefined} onClick={() => setOpen(o => !o)}>
      <img src="/dashboard-icons/more.png" alt="" width="44" height="44"/>
    </button>
    {open && <div className={`${w.menu} ${w.menuUp}`} role="menu" aria-label="All sections">
      {moreGroups(surface).map(group => <div key={group.title} className={w.menuGroup}>
        <p className={w.menuHead}>{group.title}</p>
        {group.sections.map(item => <a key={item.taskId} role="menuitem" href={item.href} aria-current={item.title === current ? 'page' : undefined} onClick={go(item, onNavigate, close)}>{item.title}</a>)}
      </div>)}
    </div>}
  </div>;
}

/** The floating dock: the six pages as object icons, More, and either the chat composer (Chat) or search. */
// Images and Video (the media update) are pages of their own (app/images, app/video): they join the dock once the router has
// released the update. Drawn icons, until the set has painted ones for them.
const MEDIA_ICONS = {
  images: <svg viewBox="0 0 32 32" aria-hidden="true"><rect x="5" y="7" width="22" height="18" rx="3" fill="none" stroke="currentColor" strokeWidth="1.8"/><circle cx="12" cy="13" r="2.2" fill="currentColor"/><path d="M6.5 22l6-6 4.5 4.5 3-3 5.5 5.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round"/></svg>,
  video: <svg viewBox="0 0 32 32" aria-hidden="true"><rect x="4" y="8" width="17" height="16" rx="3" fill="none" stroke="currentColor" strokeWidth="1.8"/><path d="M21 14l7-4v12l-7-4z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round"/></svg>,
};

const PRICE_ICON = <svg viewBox="0 0 32 32" aria-hidden="true"><path d="M5 16.5V7a2 2 0 0 1 2-2h9.5L27 15.5 16.5 26z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round"/><circle cx="11" cy="11" r="2" fill="currentColor"/></svg>;

export function Dock({ current, surface, onNavigate, chat, slotRef, mediaHere }) {
  const here = pageOf(current);
  const media = useUpdate('media')?.on;
  const estimate = useUpdate('estimate')?.on; // Price check (update 13): a page of its own once the router has released it
  return <div className={w.dock} data-chat={chat ? '' : undefined}>
    <nav className={w.dockNav} aria-label="Workspace">
      {PAGES.map(page => {
        const first = pageSections(page, surface)[0];
        if (!first) return null;
        return <a key={page.id} className={w.dockItem} href={first.href} title={page.label} aria-label={page.label} aria-current={page === here && page.ids.some(id => section(id)?.title === current) ? 'page' : undefined} onClick={go(first, onNavigate)}>
          <img src={`/dashboard-icons/${page.icon}.png`} alt="" width="44" height="44"/>
        </a>;
      })}
      {media && MEDIA_PAGES.map(page => <a key={page.id} className={w.dockItem} href={page.href} title={page.label} aria-label={page.label} aria-current={mediaHere === page.id ? 'page' : undefined}>{MEDIA_ICONS[page.id]}</a>)}
      {estimate && <a className={w.dockItem} href="/estimate/" title="Price check" aria-label="Price check" aria-current={mediaHere === 'estimate' ? 'page' : undefined}>{PRICE_ICON}</a>}
      <More current={current} surface={surface} onNavigate={onNavigate}/>
    </nav>
    {chat
      ? <div className={w.dockSlot} data-dock-slot="" ref={slotRef}/>
      : <button type="button" className={w.dockSearch} onClick={openSiteSearch} aria-haspopup="dialog" aria-controls="site-search">
          <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6" fill="none" stroke="currentColor" strokeWidth="1.8"/><path d="M20 20l-4.5-4.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/></svg>
          <span>Find a section, model or doc…</span><kbd>⌘K</kbd>
        </button>}
  </div>;
}

/** The small fixed note in the corner: where the key lives. */
export function Corner({ apiKey, surface }) {
  return <p className={w.corner} aria-hidden="true">{apiKey ? 'Key in this tab' : 'Not connected'}{surface === 'core' ? ' · Core launch surface' : ''}</p>;
}
