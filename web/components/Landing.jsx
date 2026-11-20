'use client';
import styles from './Landing.module.css';
import { Arrow, Lockup } from './landing/Mark';
import { FirstCall } from './landing/Previews';
import { useT } from '../lib/i18n/use-locale.js';

export default function Landing() {
  const t = useT();
  const row = key => { const [term, text] = t(key); return <div><dt>{term}</dt><dd>{text}</dd></div>; };
  return <>
    <section className={styles.section} id="product" aria-labelledby="product-title">
      <div className={styles.wrap}>
        <div className={styles.lead}>
          <h2 id="product-title">{t('home.product.title')}</h2>
          <div>
            <p>{t('home.product.body')} <a className={styles.inline} href="/how-it-works/">{t('home.product.how')}</a></p>
            <a className={styles.link} href="/models/">{t('home.product.explore')} <Arrow className={styles.arrow}/></a>
          </div>
        </div>
        <figure className={styles.plate}>
          <img src="/art/meadow-dawn.jpg" alt={t('home.product.art')} width="1536" height="1024" loading="lazy"/>
        </figure>
      </div>
    </section>

    <section className={styles.section} id="developers" aria-labelledby="developers-title">
      <div className={styles.wrap}>
        <div className={styles.head}>
          <h2 id="developers-title">{t('home.developers.title')}</h2>
          <a className={styles.link} href="/docs/#quickstart">{t('home.developers.quickstart')} <Arrow className={styles.arrow}/></a>
        </div>
        <FirstCall/>
      </div>
    </section>

    <section className={styles.interlude} id="trust" aria-labelledby="receipt-title">
      <img src="/art/rows-dawn.jpg" alt="" width="1536" height="1024" loading="lazy"/>
      <div className={styles.wrap}>
        <div className={styles.interludeCopy}>
          <h2 id="receipt-title">{t('home.trust.title')}</h2>
          <p>{t('home.trust.body')}</p>
          <a className={styles.link} href="/verify/">{t('home.trust.verify')} <Arrow className={styles.arrow}/></a>
        </div>
      </div>
    </section>

    <section className={styles.section} id="pricing" aria-labelledby="pricing-title">
      <div className={`${styles.wrap} ${styles.split}`}>
        <div>
          <h2 id="pricing-title">{t('home.pricing.title')}</h2>
          <p className={styles.body}>{t('home.pricing.body')}</p>
          <a className={styles.link} href="/cost/">{t('home.pricing.estimate')} <Arrow className={styles.arrow}/></a>
        </div>
        <dl className={styles.table}>
          {row('home.pricing.rates')}
          {row('home.pricing.fee')}
          {row('home.pricing.prepay')}
        </dl>
      </div>
    </section>
  </>;
}

// Labels are English; footer.groups and footer.links in lib/i18n translate them by that label.
const COLUMNS = [
  ['Product', [['Models', '/models/'], ['Pricing', '/cost/'], ['Dashboard', '/dashboard/'], ['How it works', '/how-it-works/']]],
  ['Developers', [['Docs', '/docs/'], ['Whitepaper', '/whitepaper/'], ['Roadmap', '/roadmap/'], ['Quickstart', '/docs/#quickstart'], ['SDKs', '/docs/#sdk'], ['Protocol spec', '/spec/']]],
  ['Trust', [['Check a receipt', '/verify/'], ['Trust center', '/trust/'], ['Status', '/status/'], ['Terms', '/legal/terms/'], ['Privacy', '/legal/privacy/']]],
];

/** The footer: a night panel with the link columns, then the wordmark across the page. */
export function HomeFooter() {
  const t = useT();
  return <footer className={styles.footer}>
    <div className={styles.wrap}>
      <div className={styles.footerPanel}>
        <div className={styles.footerAbout}>
          <Lockup className={styles.lockup} markClass={styles.lockupMark} wordClass={styles.lockupWord}/>
          <p>{t('footer.about')}</p>
        </div>
        {COLUMNS.map(([title, links]) => <nav key={title} aria-label={t(`footer.groups.${title}`, title)}>
          <h2>{t(`footer.groups.${title}`, title)}</h2>
          <ul>{links.map(([label, href]) => <li key={href}><a href={href}>{t(`footer.links.${label}`, label)}</a></li>)}</ul>
        </nav>)}
        <div className={styles.footerBase}><span>{t('footer.built')}</span><span>{t('footer.signed')}</span><span>© Trellis</span></div>
      </div>
      <Lockup className={styles.giant} markClass={styles.giantMark} wordClass={styles.giantWord}/>
    </div>
  </footer>;
}
