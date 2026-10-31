import {Button,Code} from './UI';
import styles from './Landing.module.css';

// The homepage after the hero: five quiet sections, each a headline, one paragraph and one picture. The long-form
// material (rulebooks, network, privacy routes, roadmap) lives on /how-it-works/.
const SAMPLE=`import OpenAI from "openai";

const client = new OpenAI({
  baseURL: \`\${process.env.TRELLIS_URL}/api/v1\`,
  apiKey: process.env.TRELLIS_KEY,
});

const reply = await client.chat.completions.create({
  model: "meta-llama/llama-3.3-70b-instruct",
  messages: [{ role: "user", content: "Hello" }],
});`;

// The same examples the site has always listed as routable models.
const MODELS=['llama-3.3-70b','qwen3-32b','deepseek-r1','mistral-small','gemma-3-27b','kimi-k2','glm-4.6','gpt-oss-120b','llama-4-scout','qwen3-235b'];

function Check(){return <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M3 7.5L6 10.5L11 4" stroke="currentColor" strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round"/></svg>}

export default function Landing(){
  return <>
    <section className={styles.band} id="integrate" aria-labelledby="integrate-title">
      <div className={styles.split}>
        <div className={styles.copy}>
          <h2 id="integrate-title">Keep your code.<br/>Change one line.</h2>
          <p>Trellis speaks the OpenAI and OpenRouter APIs. Point the SDK you already use at Trellis and every model in the catalog is one string away.</p>
          <a className={styles.more} href="/docs/#quickstart">Read the quickstart <span aria-hidden="true">→</span></a>
        </div>
        <div className={styles.figure}><Code label="Node.js">{SAMPLE}</Code></div>
      </div>
    </section>

    <section className={styles.band} id="receipts" aria-labelledby="receipts-title">
      <div className={`${styles.split} ${styles.flip}`}>
        <div className={styles.copy}>
          <h2 id="receipts-title">A receipt for<br/>every call.</h2>
          <p>Each answer is signed with the model, the provider, the tokens and the price. Every hour a root of all receipts is written to Solana, so anyone can check a call later without taking our word for it.</p>
          <a className={styles.more} href="/verify/">Check a receipt <span aria-hidden="true">→</span></a>
        </div>
        <figure className={styles.receipt} aria-label="What a receipt records">
          <div className={styles.receiptHead}><span>Receipt</span><span className={styles.ok}><Check/>Signature valid</span></div>
          <dl>
            <div><dt>Model</dt><dd>llama-3.3-70b-instruct</dd></div>
            <div><dt>Provider</dt><dd>The provider that answered</dd></div>
            <div><dt>Tokens</dt><dd>In and out, as billed</dd></div>
            <div><dt>Cost</dt><dd className={styles.mono}>USDC, to the micro-dollar</dd></div>
            <div><dt>Signed</dt><dd>Ed25519, by the router</dd></div>
            <div><dt>Anchored</dt><dd>Solana, hourly root</dd></div>
          </dl>
        </figure>
      </div>
    </section>

    <section className={styles.band} id="balance" aria-labelledby="balance-title">
      <div className={styles.wide}>
        <div className={styles.copy}>
          <h2 id="balance-title">One balance, in USDC.</h2>
          <p>Prepay from any Solana wallet and spend it on any model. You pay what the provider charges, with nothing added by the router.</p>
        </div>
        <ul className={styles.trio}>
          <li><h3>Just a key</h3><p>Create a key or sign in with your wallet. No email, no password, no forms.</p></li>
          <li><h3>Pay as you go</h3><p>Each call is priced before it runs and charged at cost. Or pay per call with x402, no balance needed.</p></li>
          <li><h3>Leave any time</h3><p>Close the account and what is left goes back to the wallet that paid it.</p></li>
        </ul>
      </div>
    </section>

    <section className={styles.band} id="catalog" aria-labelledby="catalog-title">
      <div className={styles.split}>
        <div className={styles.copy}>
          <h2 id="catalog-title">Open models,<br/>one catalog.</h2>
          <p>If a provider is slow or down, the call can fall back to another one serving the same model. The receipt says which one answered.</p>
          <a className={styles.more} href="/models/">Browse the models <span aria-hidden="true">→</span></a>
        </div>
        <ul className={styles.models} aria-label="Examples of routable models">{MODELS.map(m=><li key={m}>{m}</li>)}</ul>
      </div>
    </section>

    <section className={styles.closing} aria-labelledby="closing-title">
      <h2 id="closing-title">Start with a key.<br/><span>Add a few dollars. Call anything.</span></h2>
      <div className={styles.actions}><Button href="/dashboard/">Get an API key</Button><Button href="/how-it-works/" secondary>How it works</Button></div>
    </section>
  </>;
}
