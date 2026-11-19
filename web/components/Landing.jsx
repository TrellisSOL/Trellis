import styles from './Landing.module.css';
import { Arrow, Lockup, WovenMark } from './landing/Mark';
import { FirstCall } from './landing/Previews';

// The homepage after the hero, in this order: models, the idea, three capabilities, an
// illustrated interlude, a first call, trust, the sealed lane, pricing, launch scope, questions and a closing call.
// Every figure on the page comes from the router's settings or the receipt spec (spec/0004-receipts.md); every link
// stays on the core launch surface. The long-form tour lives on /how-it-works/.

// The same examples the site has always listed as routable models.
const MODELS = ['llama-3.3-70b', 'qwen3-32b', 'deepseek-r1', 'mistral-small', 'gemma-3-27b', 'kimi-k2', 'glm-4.6', 'gpt-oss-120b'];

const STATS = [['0%', 'Router markup on the price of inference'], ['1 h', 'Between receipt roots written to Solana'], ['Ed25519', 'Signature on every receipt'], ['3', 'Ways to pay: credits, per call or a tab']];

const RECEIPT = `{
  "v": 2,
  "model": { "id": "llama-3.3-70b" },
  "node": { "provider": "<provider id>" },
  "lane": "public",
  "credit": {
    "mode": "prepaid",
    "cost_units": 812
  }
}`;

const STEPS = [
  ['Create a key', 'Sign in with a Solana wallet or create a key. No email, no password.'],
  ['Add funds', 'Top up from 1 USDC, or skip the balance and pay per call with x402.'],
  ['Call any model', 'Use the SDK you already have. Each answer returns with its receipt id.'],
];

const PRICING = [
  ['Router markup', 'None. You pay what the provider charges.'],
  ['Prepaid credits', 'Top up from 1 USDC, from any Solana wallet.'],
  ['Per call (x402)', '0.03 USDC minimum. The Solana network fee is passed on at cost, on its own line.'],
  ['Tabs', 'Up to 500 USDC, drawn per call and settled when the tab closes.'],
  ['Launch limit', 'Up to 5,000 USDC of credits per key.'],
  ['Leaving', 'Close the account and what is left goes back to the wallet that paid it.'],
];

const SCOPE = [
  ['Available at launch', ['Chat, completions and embeddings', 'The model catalogue and API keys', 'Prepaid credits, x402 per call and tabs', 'Signed receipts with hourly roots on Solana', 'The sealed lane, through an attested gateway']],
  ['Enabled after review', ['The blind lane, paid with single-use tokens', 'Agent rulebooks and approvals', 'Teams, webhooks and batches', 'Bonded hosts on the open network']],
];

const QUESTIONS = [
  ['What is Trellis?', 'An inference router for open models, paid in USDC on Solana. It speaks the OpenAI and OpenRouter APIs, so the SDK you already use works, and every answer comes with a signed receipt.'],
  ['Do I need an account?', 'No email and no password. Create a key, or sign in with a Solana wallet by signing a message. Signing in moves no funds; a top-up is its own transaction that you approve.'],
  ['How is a call priced?', 'Before a call, a hold covers the most it can cost. Afterwards you are charged actual usage, never more than the hold. A provider failure that produced no tokens costs nothing.'],
  ['What does a receipt prove?', 'That the router signed this record of the call: the model, the provider, the token buckets and the cost. The hourly Merkle root on Solana lets anyone show that the receipt is in that hour’s tree.'],
  ['What happens if a provider fails?', 'The call can fall back to another provider serving the same model, and the receipt names the one that answered.'],
  ['Who can read my prompts?', 'On the open lane the router reads the request in memory to route and meter it, and the provider that answers reads it too. The sealed lane sends it to a confidential gateway whose attestation the router checks first.'],
  ['Can I withdraw my balance?', 'Yes. Close the account and what is left goes back to the wallet that paid it, at most what that wallet put in. The key stops spending as soon as you ask.'],
];

const TRUST = [
  ['Where requests go', 'The path from your request to its answer, lane by lane.', '/how-it-works/#privacy'],
  ['Check a receipt', 'Verify a receipt’s signature and its hourly root.', '/verify/'],
  ['Trust center', 'Signing keys, anchoring and attestation, read live from the router.', '/trust/'],
  ['Status', 'Uptime and incidents for each lane.', '/status/'],
];

export default function Landing() {
  return <>
    <section className={styles.models} aria-label="Examples of routable models">
      <div className={styles.wrap}>
        <span className={styles.modelsLabel}>Routes to</span>
        <ul>{MODELS.map(m => <li key={m}>{m}</li>)}</ul>
        <a className={styles.link} href="/models/">All models <Arrow className={styles.arrow}/></a>
      </div>
    </section>

    <section className={styles.section} id="product" aria-labelledby="product-title">
      <div className={styles.wrap}>
        <div className={styles.lead}>
          <h2 id="product-title">An inference router you can check.</h2>
          <div>
            <p>Trellis sits between your code and the providers that serve open models. It picks a provider, meters the call, charges what the provider bills and signs a receipt that says what happened.</p>
            <p>Every hour the receipts are folded into one Merkle root and written to Solana, so a call can be checked later without taking our word for it.</p>
          </div>
        </div>
        <dl className={styles.stats}>{STATS.map(([n, label]) => <div key={label}><dt>{label}</dt><dd>{n}</dd></div>)}</dl>
        <figure className={styles.plate}>
          <img src="/art/meadow-dawn.jpg" alt="A garden trellis with climbing leaves, looking out over a valley at dawn" width="1536" height="1024" loading="lazy"/>
        </figure>
      </div>
    </section>

    <section className={`${styles.section} ${styles.tinted}`} id="how" aria-labelledby="how-title">
      <div className={styles.wrap}>
        <div className={styles.head}>
          <h2 id="how-title">What every call gets.</h2>
          <p>The same three guarantees, whichever model or provider answers.</p>
        </div>
        <div className={styles.cards}>
          <article className={styles.card}>
            <p className={styles.cardLabel}>Compatible</p>
            <h3>Your SDK, unchanged</h3>
            <pre className={styles.diff} aria-label="The one line that changes"><code><span className={styles.del}>- baseURL: "https://api.openai.com/v1",</span>{'\n'}<span className={styles.add}>+ baseURL: `${'{'}TRELLIS_URL{'}'}/api/v1`,</span></code></pre>
            <p>Trellis speaks the OpenAI and OpenRouter APIs. Change the base URL and the key, and every model in the catalogue is one string away.</p>
            <a className={styles.link} href="/models/">Browse the models <Arrow className={styles.arrow}/></a>
          </article>
          <article className={styles.card}>
            <p className={styles.cardLabel}>Accountable</p>
            <h3>A signed receipt</h3>
            <pre className={styles.json} aria-label="An excerpt of a receipt"><code>{RECEIPT}</code></pre>
            <p>Each answer carries a receipt with the model, the provider, token buckets and the cost in millionths of a dollar, signed with Ed25519.</p>
            <a className={styles.link} href="/verify/">Check a receipt <Arrow className={styles.arrow}/></a>
          </article>
          <article className={styles.card}>
            <p className={styles.cardLabel}>At cost</p>
            <h3>One USDC balance</h3>
            <dl className={styles.ways}>
              <div><dt>Prepaid credits</dt><dd>from 1 USDC</dd></div>
              <div><dt>Per call, x402</dt><dd>0.03 USDC min.</dd></div>
              <div><dt>Tab</dt><dd>up to 500 USDC</dd></div>
            </dl>
            <p>Prepay from any Solana wallet and spend on any model, or pay per call with x402. What is left goes back to the wallet that paid it.</p>
            <a className={styles.link} href="/dashboard/">Open the dashboard <Arrow className={styles.arrow}/></a>
          </article>
        </div>
      </div>
    </section>

    <section className={styles.interlude} aria-labelledby="anchor-title">
      <img src="/art/rows-dawn.jpg" alt="" width="1536" height="1024" loading="lazy"/>
      <div className={styles.wrap}>
        <div className={styles.interludeCopy}>
          <p className={styles.kicker}>Anchoring</p>
          <h2 id="anchor-title">Every hour, one root on Solana.</h2>
          <p>The hour’s receipts become a Merkle tree and its root is posted on chain. A short proof shows that any one receipt was in it.</p>
          <a className={styles.link} href="/how-it-works/">How it works <Arrow className={styles.arrow}/></a>
        </div>
      </div>
    </section>

    <section className={styles.section} id="developers" aria-labelledby="developers-title">
      <div className={styles.wrap}>
        <div className={styles.head}>
          <h2 id="developers-title">The first call takes a minute.</h2>
          <p>Point the client you already use at Trellis. <a className={styles.inline} href="/docs/#quickstart">Read the quickstart</a></p>
        </div>
        <FirstCall/>
        <ol className={styles.steps}>{STEPS.map(([t, d]) => <li key={t}><h3>{t}</h3><p>{d}</p></li>)}</ol>
      </div>
    </section>

    <section className={`${styles.section} ${styles.tinted}`} id="trust" aria-labelledby="trust-title">
      <div className={`${styles.wrap} ${styles.split}`}>
        <figure className={styles.portrait}>
          <img src="/art/gate.jpg" alt="A garden gate set in a trellis wall, wrapped in climbing vines" width="1024" height="1024" loading="lazy"/>
        </figure>
        <div>
          <h2 id="trust-title">Know where every request goes.</h2>
          <p className={styles.body}>A request is served by one provider for the model you asked for, and the receipt names that provider. On the open lane the router reads the request in memory to route and meter it; the provider that answers reads it too.</p>
          <ul className={styles.rows}>{TRUST.map(([t, d, href]) => <li key={href}><a href={href}><span><strong>{t}</strong><span>{d}</span></span><Arrow className={styles.arrow}/></a></li>)}</ul>
        </div>
      </div>
    </section>

    <section className={styles.section} id="sealed" aria-labelledby="sealed-title">
      <div className={styles.wrap}>
        <div className={styles.sealed}>
          <div>
            <p className={styles.kicker}>Sealed lane</p>
            <h2 id="sealed-title">Confidential inference you can verify.</h2>
            <p>The sealed lane sends requests to a confidential gateway running on attested hardware, paid per token from the same balance.</p>
            <a className={styles.btnLight} href="/trust/">Open the trust center</a>
          </div>
          <ol className={styles.checks} aria-label="What the router checks before a sealed call">
            <li><strong>A fresh attestation.</strong> The router reads the gateway’s attestation and verifies it.</li>
            <li><strong>Pinned measurements.</strong> The measured software must match the values the router pinned; a change fails the check.</li>
            <li><strong>A receipt that says so.</strong> The receipt carries the provider’s attestation hash beside the router’s signature.</li>
          </ol>
        </div>
      </div>
    </section>

    <section className={styles.section} id="pricing" aria-labelledby="pricing-title">
      <div className={`${styles.wrap} ${styles.split}`}>
        <div>
          <h2 id="pricing-title">Priced at cost.</h2>
          <p className={styles.body}>Trellis adds nothing to the price of inference. Before a call, a hold covers the most it can cost; afterwards you are charged actual usage, never more than the hold.</p>
          <a className={styles.link} href="/cost/">Estimate a call <Arrow className={styles.arrow}/></a>
        </div>
        <dl className={styles.table}>{PRICING.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
      </div>
    </section>

    <section className={`${styles.section} ${styles.tinted}`} id="scope" aria-labelledby="scope-title">
      <div className={styles.wrap}>
        <div className={styles.head}>
          <h2 id="scope-title">What is live at launch.</h2>
          <p>Each feature outside the core joins only after its own security review. <a className={styles.inline} href="/how-it-works/">Take the full tour</a></p>
        </div>
        <div className={styles.scope}>{SCOPE.map(([title, items], i) => <div key={title}>
          <h3><span className={i ? styles.dotLater : styles.dotLive} aria-hidden="true"/>{title}</h3>
          <ul>{items.map(item => <li key={item}>{item}</li>)}</ul>
        </div>)}</div>
      </div>
    </section>

    <section className={styles.section} id="questions" aria-labelledby="questions-title">
      <div className={`${styles.wrap} ${styles.split}`}>
        <div>
          <h2 id="questions-title">Questions.</h2>
          <p className={styles.body}>The rest is in the documentation.</p>
          <a className={styles.link} href="/docs/">Read the docs <Arrow className={styles.arrow}/></a>
        </div>
        <div className={styles.faq}>{QUESTIONS.map(([q, a]) => <details key={q}><summary>{q}<span className={styles.plus} aria-hidden="true"/></summary><p>{a}</p></details>)}</div>
      </div>
    </section>

    <section className={styles.closing} aria-labelledby="closing-title">
      <div className={`${styles.wrap} ${styles.closingGrid}`}>
        <div>
          <WovenMark className={styles.closingMark}/>
          <h2 id="closing-title">Start with one key.</h2>
          <p className={styles.body}>Add a few dollars of USDC and call any open model.</p>
          <div className={styles.actions}>
            <a className={styles.btnDark} href="/dashboard/">Get an API key</a>
            <a className={styles.link} href="/how-it-works/">How it works <Arrow className={styles.arrow}/></a>
          </div>
        </div>
        <img className={styles.arch} src="/art/arch.jpg" alt="A garden arch covered in vines, opening onto green hills at dawn" width="1024" height="1536" loading="lazy"/>
      </div>
    </section>
  </>;
}

const COLUMNS = [
  ['Product', [['Models', '/models/'], ['Pricing', '/cost/'], ['Dashboard', '/dashboard/'], ['How it works', '/how-it-works/']]],
  ['Developers', [['Docs', '/docs/'], ['Quickstart', '/docs/#quickstart'], ['SDKs', '/docs/#sdk'], ['Protocol spec', '/spec/']]],
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
