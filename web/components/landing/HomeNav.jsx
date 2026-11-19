'use client';
import { useEffect, useState } from 'react';
import styles from '../Landing.module.css';
import { Lockup } from './Mark';

const LINKS = [['Product', '#product'], ['Developers', '#developers'], ['Pricing', '#pricing'], ['Docs', '/docs/'], ['Status', '/status/']];

/** The homepage bar: clear over the night hero, a solid paper bar with a hairline once the page has moved. */
export default function HomeNav() {
  const [open, setOpen] = useState(false);
  const [solid, setSolid] = useState(false);

  useEffect(() => {
    const hero = document.getElementById('home');
    const onScroll = () => setSolid(!hero || hero.getBoundingClientRect().bottom < 72);
    onScroll();
    addEventListener('scroll', onScroll, { passive: true });
    const onKey = e => { if (e.key === 'Escape') setOpen(false); };
    addEventListener('keydown', onKey);
    return () => { removeEventListener('scroll', onScroll); removeEventListener('keydown', onKey); };
  }, []);
  useEffect(() => { document.documentElement.style.overflow = open ? 'hidden' : ''; return () => { document.documentElement.style.overflow = ''; }; }, [open]);

  const close = () => setOpen(false);
  return <header className={styles.nav} data-solid={solid || open ? '' : undefined} data-open={open ? '' : undefined}>
    <a className="skip" href="#content">Skip to content</a>
    <div className={styles.navInner}>
      <a className={styles.navBrand} href="/" aria-label="Trellis home"><Lockup className={styles.lockup} markClass={styles.lockupMark} wordClass={styles.lockupWord}/></a>
      <nav className={styles.navLinks} aria-label="Main navigation">
        {LINKS.map(([label, href]) => <a key={href} href={href} onClick={close}>{label}</a>)}
        <a className={styles.menuOnly} href="/dashboard/" onClick={close}>Dashboard</a>
      </nav>
      <div className={styles.navActions}>
        <a className={styles.navText} href="/dashboard/">Dashboard</a>
        <a className={styles.navButton} href="/dashboard/">Get an API key</a>
        <button type="button" className={styles.menuButton} aria-expanded={open} aria-label={open ? 'Close navigation' : 'Open navigation'} onClick={() => setOpen(o => !o)}><span/><span/></button>
      </div>
    </div>
  </header>;
}
