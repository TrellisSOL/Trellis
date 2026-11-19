import styles from './Landing.module.css';
import { Arrow, Lockup } from './landing/Mark';
import { FirstCall } from './landing/Previews';

export default function Landing() {
  return <>
    <section className={styles.section} id="product" aria-labelledby="product-title">
      <div className={styles.wrap}>
        <div className={styles.lead}>
          <h2 id="product-title">Choose where your request runs.</h2>
          <div>
            <p>Compare model capabilities, context limits and prices in the catalog. Trellis finds an eligible provider for the model you choose. <a className={styles.inline} href="/how-it-works/">How routing works</a></p>
            <a className={styles.link} href="/models/">Explore models <Arrow className={styles.arrow}/></a>
          </div>
        </div>
        <figure className={styles.plate}>
          <img src="/art/meadow-dawn.jpg" alt="Climbing vines overlooking a valley at dawn" width="1536" height="1024" loading="lazy"/>
        </figure>
      </div>
    </section>

    <section className={styles.section} id="developers" aria-labelledby="developers-title">
      <div className={styles.wrap}>
        <div className={styles.head}>
          <h2 id="developers-title">Your first request</h2>
          <a className={styles.link} href="/docs/#quickstart">Follow the quickstart <Arrow className={styles.arrow}/></a>
        </div>
        <FirstCall/>
      </div>
    </section>

    <section className={styles.interlude} id="trust" aria-labelledby="receipt-title">
      <img src="/art/rows-dawn.jpg" alt="" width="1536" height="1024" loading="lazy"/>
      <div className={styles.wrap}>
        <div className={styles.interludeCopy}>
          <h2 id="receipt-title">Read the receipt.</h2>
          <p>Each receipt identifies the route and the cost recorded for that call. Check its signature with the router’s public key.</p>
          <a className={styles.link} href="/verify/">Verify a receipt <Arrow className={styles.arrow}/></a>
        </div>
      </div>
    </section>

    <section className={styles.section} id="pricing" aria-labelledby="pricing-title">
      <div className={`${styles.wrap} ${styles.split}`}>
        <div>
          <h2 id="pricing-title">Pay per request.</h2>
          <p className={styles.body}>Get an x402 quote in USDC. Your wallet authorizes the payment on Solana.</p>
          <a className={styles.link} href="/cost/">Estimate a call <Arrow className={styles.arrow}/></a>
        </div>
        <dl className={styles.table}>
          <div><dt>Model rates</dt><dd>Input and output prices are listed separately in the catalog.</dd></div>
          <div><dt>Network fee</dt><dd>The quote includes the Solana network fee at cost.</dd></div>
          <div><dt>Prepayment</dt><dd>Per-call payments require no prepaid balance.</dd></div>
        </dl>
      </div>
    </section>
  </>;
}

const COLUMNS = [
  ['Product', [['Models', '/models/'], ['Pricing', '/cost/'], ['Dashboard', '/dashboard/'], ['How it works', '/how-it-works/']]],
  ['Developers', [['Docs', '/docs/'], ['Whitepaper', '/whitepaper/'], ['Roadmap', '/roadmap/'], ['Quickstart', '/docs/#quickstart'], ['SDKs', '/docs/#sdk'], ['Protocol spec', '/spec/']]],
  ['Trust', [['Check a receipt', '/verify/'], ['Trust center', '/trust/'], ['Status', '/status/'], ['Terms', '/legal/terms/'], ['Privacy', '/legal/privacy/']]],
];

/** The footer: a night panel with the link columns, then the wordmark across the page. */
export function HomeFooter() {
  return <footer className={styles.footer}>
    <div className={styles.wrap}>
      <div className={styles.footerPanel}>
        <div className={styles.footerAbout}>
          <Lockup className={styles.lockup} markClass={styles.lockupMark} wordClass={styles.lockupWord}/>
          <p>The open inference router for Solana. Any model, any provider, an accountable route.</p>
        </div>
        {COLUMNS.map(([title, links]) => <nav key={title} aria-label={title}>
          <h2>{title}</h2>
          <ul>{links.map(([label, href]) => <li key={href}><a href={href}>{label}</a></li>)}</ul>
        </nav>)}
        <div className={styles.footerBase}><span>Built on Solana</span><span>Receipts signed with Ed25519, rooted hourly</span><span>© Trellis</span></div>
      </div>
      <Lockup className={styles.giant} markClass={styles.giantMark} wordClass={styles.giantWord}/>
    </div>
  </footer>;
}
