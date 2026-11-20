'use client';
import styles from './Landing.module.css';
import { Arrow } from './landing/Mark';
import { useT } from '../lib/i18n/use-locale.js';

const FACTS = ['routes', 'paid', 'receipts', 'markup']; // hero.facts.* in lib/i18n: [label, value]

// The landing hero: the night-garden art full bleed, the headline at the lower left and four plain facts at the
// upper right.
export default function Hero() {
  const t = useT();
  const [line1, line2] = t('hero.title');
  return <section className={styles.hero} id="home" data-dark-hero aria-labelledby="hero-title">
    <picture className={styles.heroArt}>
      <source media="(max-width: 700px)" srcSet="/art/hero-night-900.jpg"/>
      <img src="/art/hero-night.jpg" alt="" width="1536" height="1024" fetchPriority="high"/>
    </picture>
    <div className={styles.heroInner}>
      <dl className={styles.heroFacts}>{FACTS.map(id => { const [k, v] = t(`hero.facts.${id}`); return <div key={id}><dt>{k}</dt><dd>{v}</dd></div>; })}</dl>
      <div className={styles.heroCopy}>
        <p className={styles.heroKicker}>{t('hero.kicker')}</p>
        <h1 id="hero-title">{line1}<br/>{line2}</h1>
        <p className={styles.heroLede}>{t('hero.lede')}</p>
        <div className={styles.actions}>
          <a className={styles.btnLight} href="/dashboard/">{t('hero.key')}</a>
          <a className={styles.btnGhost} href="/docs/">{t('hero.docs')} <Arrow className={styles.arrow}/></a>
        </div>
      </div>
    </div>
  </section>;
}
