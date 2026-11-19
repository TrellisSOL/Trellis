'use client';
import { useEffect, useRef, useState } from 'react';
import { Button, CopyButton, Modal } from '../UI';
import { AccountNavigation, AccountPreview, AccountTabs, CORE_COPY } from './AccountViews.js';
import AccountConnect from './AccountConnect';
import FirstCallQuickstart from './FirstCallQuickstart'; // ON2
import NotEnabled, { useLaunchSurface } from '../launch/Surface';
import { CORE, gateView } from '../../lib/launch-surface.js';
import { ACCOUNT_SECTIONS } from '../../lib/site-map.js';
import { Dock, TopBar } from './Workspace';
import { isChat, pageOf, pageSections } from './workspace-map.js';
import s from './AccountShell.module.css';
import w from './Workspace.module.css';

const PAYMENTS = ACCOUNT_SECTIONS.find(item => item.taskId === 'account-payments');
const follow = (target, onNavigate) => event => {
  if (!onNavigate || !target.hash || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault(); onNavigate(target.title);
};

/**
 * `app` (the dashboard) is a workspace: a bar with the key picker and account menu, each page with a large
 * title, one primary action and its sections as underline tabs, Chat as a conversation with the composer in the dock,
 * and a floating dock of six pages plus More (components/account/Workspace.jsx, workspace-map.js).
 * Without `app` (/agents/, webhooks) the five account tabs sit on top and the current tab's sections in a sidebar.
 */
export default function AccountShell({ current, apiKey, onConnect, onDisconnect, onNavigate, publicContent = false, app = false, children }) {
  const [secret, setSecret] = useState('');
  // Launch surface: a section that is not core shows the notice on a core router and nothing until the router has answered.
  const launch = useLaunchSurface();
  const section = ACCOUNT_SECTIONS.find(item => item.title === current);
  const view = gateView(!section || CORE.section.includes(section.taskId), launch);
  const content = useRef(null);
  const side = useRef(null);
  const tabs = useRef(null);
  // Phones show the tabs and the current tab's sections as swipeable rows: start each at the current one.
  useEffect(() => { for (const nav of [tabs.current?.querySelector('nav'), side.current?.querySelector('nav')]) { const here = nav?.querySelector('[aria-current]'); if (nav && here && nav.scrollWidth > nav.clientWidth) nav.scrollLeft = here.offsetLeft - nav.offsetLeft - 8; } }, [current]);
  useEffect(() => {
    if (!apiKey && window.location.hash) content.current?.querySelector('h2')?.focus({ preventScroll: true });
  }, [current, apiKey]);
  const body = <>
    {view === 'notice' && <NotEnabled/>}
    {view === 'show' && <>
    {!apiKey && <AccountPreview current={current} workspace={app}><AccountConnect onConnect={onConnect} onSecret={setSecret}/>{current === 'Home' && <details className={s.guide}><summary>Make your first API call</summary><FirstCallQuickstart/></details>} {/* ON2 */}</AccountPreview>}
    {(apiKey || publicContent) && children}
    </>}
  </>;
  const saved = secret && <Modal title="Save your API key" onClose={() => setSecret('')}><p>Keep this key safe. Anyone with it can use its account access and balance.</p><code className={s.secret}>{secret}</code><div className="button-row"><CopyButton text={secret} label="Copy key"/><Button onClick={() => setSecret('')}>Done</Button></div></Modal>;

  if (app) {
    const chat = isChat(current) && !!apiKey;
    const page = pageOf(current);
    const shown = section || ACCOUNT_SECTIONS[0];
    const sections = pageSections(page, launch.surface);
    const addFunds = apiKey && PAYMENTS && current !== 'Home' && current !== PAYMENTS.title;
    return <div className={w.shell} data-chat={chat ? '' : undefined}>
      <TopBar chat={chat} apiKey={apiKey} onNavigate={onNavigate} onDisconnect={onDisconnect}/>
      {chat ? <div className={w.chatContent} ref={content}>{body}</div> : <section className={w.page} aria-labelledby="page-title">
        <header className={w.heading}>
          <div>
            <h1 className={w.title} id="page-title">{shown.taskId === 'dashboard' ? 'Dashboard' : shown.title}</h1>
            {CORE_COPY[shown.taskId] ? <><p className={w.description} data-surface-extra="">{shown.description}</p><p className={w.description} data-surface-core="">{CORE_COPY[shown.taskId]}</p></> : <p className={w.description}>{shown.description}</p>}
          </div>
          {addFunds && <div className={w.actions}><a className={`${w.button} ${w.buttonAccent}`} href={PAYMENTS.href} onClick={follow(PAYMENTS, onNavigate)}><img src="/dashboard-icons/purse.png" alt="" width="20" height="20"/>Add funds</a></div>}
        </header>
        {sections.length > 1 && <div className={w.filterRow}>
          <nav className={w.tabs} aria-label={`${page.label} sections`}>{sections.map(item => <a key={item.taskId} href={item.href} aria-current={item.title === current ? 'page' : undefined} onClick={follow(item, onNavigate)}>{item.title}</a>)}</nav>
        </div>}
        <div className={w.content} ref={content}>{body}</div>
      </section>}
      <Dock current={current} surface={launch.surface} onNavigate={onNavigate} chat={chat}/>
      {saved}
    </div>;
  }

  const connection = apiKey ? <><p className="help-text">Key connected · this tab only</p><Button secondary onClick={onDisconnect}>Disconnect</Button></> : <p className="help-text">Explore your account. Connect a key when you are ready.</p>;
  return <div className={s.shell}>
    <div className={s.tabs} ref={tabs}><AccountTabs current={current} onNavigate={onNavigate} surface={launch.surface}/></div>
    <aside className={s.sidebar} ref={side}><AccountNavigation current={current} onNavigate={onNavigate} surface={launch.surface}/>
      <div className={s.connection}>{connection}</div>
    </aside>
    <div className={s.content} ref={content}>{body}</div>
    {saved}
  </div>;
}
