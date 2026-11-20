'use client';
import {Lockup} from './landing/Mark';
import {useT} from '../lib/i18n/use-locale.js';
import styles from './SiteShell.module.css';

// Labels are English; footer.groups and footer.links in lib/i18n translate them by that label.
const links = [
  ['Product', [['Models', '/models/'], ['Pricing', '/cost/'], ['Dashboard', '/dashboard/']]],
  ['Developers', [['Docs', '/docs/'], ['Whitepaper', '/whitepaper/'], ['Roadmap', '/roadmap/']]],
  ['Trust', [['Verify a receipt', '/verify/'], ['Data inventory', '/keep/'], ['System status', '/status/']]],
];

export default function Footer() {
  const t = useT();
  return <footer className={styles.footer}>
    <div className={styles.footerBody}>
      <a href="/" className={styles.brand} aria-label={t('nav.home')}>
        <Lockup className={styles.lockup} markClass={styles.mark} wordClass={styles.word}/>
      </a>
      {links.map(([group, items]) => <nav key={group} aria-label={t(`footer.groups.${group}`, group)}>
        <h2>{t(`footer.groups.${group}`, group)}</h2>
        <ul>{items.map(([label, href]) => <li key={href}><a href={href}>{t(`footer.links.${label}`, label)}</a></li>)}</ul>
      </nav>)}
      <div className={styles.legal}>
        <span>© Trellis</span>
        <a href="/legal/privacy/">{t('footer.links.Privacy', 'Privacy')}</a>
        <a href="/legal/terms/">{t('footer.links.Terms', 'Terms')}</a>
      </div>
    </div>
  </footer>;
}
