import {Lockup} from './landing/Mark';
import styles from './SiteShell.module.css';

const links = [
  ['Product', [['Models', '/models/'], ['Pricing', '/cost/'], ['Dashboard', '/dashboard/']]],
  ['Developers', [['Docs', '/docs/'], ['Whitepaper', '/whitepaper/'], ['Roadmap', '/roadmap/']]],
  ['Trust', [['Verify a receipt', '/verify/'], ['Data inventory', '/keep/'], ['System status', '/status/']]],
];

export default function Footer() {
  return <footer className={styles.footer}>
    <div className={styles.footerBody}>
      <a href="/" className={styles.brand} aria-label="Trellis home">
        <Lockup className={styles.lockup} markClass={styles.mark} wordClass={styles.word}/>
      </a>
      {links.map(([group, items]) => <nav key={group} aria-label={group}>
        <h2>{group}</h2>
        <ul>{items.map(([label, href]) => <li key={href}><a href={href}>{label}</a></li>)}</ul>
      </nav>)}
      <div className={styles.legal}>
        <span>© Trellis</span>
        <a href="/legal/privacy/">Privacy</a>
        <a href="/legal/terms/">Terms</a>
      </div>
    </div>
  </footer>;
}
