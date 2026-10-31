import {Button} from './UI';
import styles from './Landing.module.css';

// The landing hero: one headline, one paragraph, two actions, a faint trellis lattice and a warm light from above.
// It stays still: no route animation, no live card, no status strip (Night garden: calm before clever).
export default function Hero(){
  return <section className={styles.hero} id="home" data-dark-hero>
    <svg className={styles.lattice} aria-hidden="true" focusable="false">
      <defs>
        <pattern id="hero-lattice" width="64" height="64" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><path d="M0 0H64M0 0V64"/></pattern>
        <radialGradient id="hero-fade" cx="50%" cy="28%" r="58%"><stop offset="0" stopColor="#fff"/><stop offset="1" stopColor="#000"/></radialGradient>
        <mask id="hero-mask"><rect width="100%" height="100%" fill="url(#hero-fade)"/></mask>
      </defs>
      <rect width="100%" height="100%" fill="url(#hero-lattice)" mask="url(#hero-mask)"/>
    </svg>
    <div className={styles.dawn} aria-hidden="true"/>
    <div className={styles.heroInner}>
      <a className={styles.pill} href="/docs/#quickstart">OpenRouter-compatible, built on Solana</a>
      <h1 className={styles.heroTitle}>Every open model.<br/>One key.</h1>
      <p className={styles.heroLede}>Call any open model through one API and one prepaid balance. Every answer comes with a signed receipt you can check.</p>
      <div className={styles.actions}><Button href="/dashboard/">Get an API key</Button><Button href="/docs/" secondary>Read the docs</Button></div>
      <p className={styles.fine}>No email. No password. No router markup.</p>
    </div>
  </section>;
}
