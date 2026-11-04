'use client';
import { useEffect, useRef, useState } from 'react';
import { Button, CopyButton, Modal } from '../UI';
import { AccountNavigation, AccountPreview, AccountTabs } from './AccountViews.js';
import AccountConnect from './AccountConnect';
import FirstCallQuickstart from './FirstCallQuickstart'; // ON2
import NotEnabled, { useLaunchSurface } from '../launch/Surface';
import { CORE, gateView } from '../../lib/launch-surface.js';
import { ACCOUNT_SECTIONS } from '../../lib/site-map.js';
import s from './AccountShell.module.css';
export default function AccountShell({ current, apiKey, onConnect, onDisconnect, onNavigate, publicContent = false, children }) {
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
  return <div className={s.shell}>
    <div className={s.tabs} ref={tabs}><AccountTabs current={current} onNavigate={onNavigate} surface={launch.surface}/></div>
    <aside className={s.sidebar} ref={side}><AccountNavigation current={current} onNavigate={onNavigate} surface={launch.surface}/>
      <div className={s.connection}>{apiKey ? <><p className="help-text">Key connected · this tab only</p><Button secondary onClick={onDisconnect}>Disconnect</Button></> : <p className="help-text">Explore your account. Connect a key when you are ready.</p>}</div>
    </aside>
    <div className={s.content} ref={content}>
      {view === 'notice' && <NotEnabled/>}
      {view === 'show' && <>
      {!apiKey && <AccountPreview current={current}><AccountConnect onConnect={onConnect} onSecret={setSecret}/>{current === 'Home' && <FirstCallQuickstart/>} {/* ON2 */}</AccountPreview>}
      {(apiKey || publicContent) && children}
      </>}
    </div>
    {secret && <Modal title="Save your API key" onClose={() => setSecret('')}><p>Keep this key safe. Anyone with it can use its account access and balance.</p><code className={s.secret}>{secret}</code><div className="button-row"><CopyButton text={secret} label="Copy key"/><Button onClick={() => setSecret('')}>Done</Button></div></Modal>}
  </div>;
}
