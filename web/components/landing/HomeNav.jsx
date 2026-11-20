'use client';
import { useEffect, useState } from 'react';
import styles from '../Landing.module.css';
import { Lockup } from './Mark';
import LanguageSwitch from '../i18n/LanguageSwitch';
import { useT } from '../../lib/i18n/use-locale.js';

const LINKS = [['product', '#product'], ['developers', '#developers'], ['pricing', '#pricing'], ['docs', '/docs/'], ['status', '/status/']]; // nav.* in lib/i18n

/** The homepage bar: clear over the night hero, a solid paper bar with a hairline once the page has moved. */
export default function HomeNav() {
  const [open, setOpen] = useState(false);
  const [solid, setSolid] = useState(false);
  const t = useT();

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
    <a className="skip" href="#content">{t('nav.skip')}</a>
    <div className={styles.navInner}>
      <a className={styles.navBrand} href="/" aria-label={t('nav.home')}><Lockup className={styles.lockup} markClass={styles.lockupMark} wordClass={styles.lockupWord}/></a>
      <nav className={styles.navLinks} aria-label={t('nav.main')}>
        {LINKS.map(([key, href]) => <a key={href} href={href} onClick={close}>{t(`nav.${key}`)}</a>)}
        <a className={styles.menuOnly} href="/dashboard/" onClick={close}>{t('nav.dashboard')}</a>
      </nav>
      <div className={styles.navActions}>
        <LanguageSwitch/>
        <a className={styles.navButton} href="/dashboard/">{t('nav.workspace')}</a>
        <button type="button" className={styles.menuButton} aria-expanded={open} aria-label={t(open ? 'nav.close' : 'nav.open')} onClick={() => setOpen(o => !o)}><span/><span/></button>
      </div>
    </div>
  </header>;
}
