import styles from './Landing.module.css';
import { Arrow } from './landing/Mark';

const FACTS = [['Routes to', 'Open models across many providers'], ['Paid in', 'USDC on Solana'], ['Receipts', 'Signed per call, rooted hourly'], ['Router markup', 'None']];

// The landing hero: the night-garden art full bleed, the headline at the lower left and four plain facts at the
// upper right.
export default function Hero() {
  return <section className={styles.hero} id="home" data-dark-hero aria-labelledby="hero-title">
    <picture className={styles.heroArt}>
      <source media="(max-width: 700px)" srcSet="/art/hero-night-900.jpg"/>
      <img src="/art/hero-night.jpg" alt="" width="1536" height="1024" fetchPriority="high"/>
    </picture>
    <div className={styles.heroInner}>
      <dl className={styles.heroFacts}>{FACTS.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
      <div className={styles.heroCopy}>
        <p className={styles.heroKicker}>The open inference router</p>
        <h1 id="hero-title">Every open model.<br/>One key.</h1>
        <p className={styles.heroLede}>One OpenAI-compatible API for the open models, one prepaid balance in USDC, and a signed receipt for every answer.</p>
        <div className={styles.actions}>
          <a className={styles.btnLight} href="/dashboard/">Get an API key</a>
          <a className={styles.btnGhost} href="/docs/">Read the docs <Arrow className={styles.arrow}/></a>
        </div>
      </div>
    </div>
  </section>;
}
