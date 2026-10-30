import {Button,Code} from './UI';
import {Mark} from './Logo';

export const sampleRequest=`// Change two lines: the base URL and the key.
const client = new OpenAI({
  baseURL: process.env.TRELLIS_BASE_URL, // "<your router>/api/v1"
  apiKey: process.env.TRELLIS_API_KEY,   // "sk-tr-v1-…"
});

const generation = await client.chat.completions.create({
  model: "meta-llama/llama-3.3-70b-instruct",
  messages: [{ role: "user", content: "Hello, Trellis." }],
});`;


// A fourth entry is the card's label on a router that runs the core launch surface (default: "Not enabled on this router").
export const roadmap=[['01','Encrypted chat and GRAFT','On-device encryption through the attested gateway, signed receipts, key transparency and per-host receipt anchoring.','Signed receipts only on this router'],['02','The agent rulebook','Budgets, rules, approvals on /agents and Telegram, receipts, alerts, circuit breakers, progressive autonomy, certificates and opt-in profiles.'],['03','Trellis Network','Open for early hosts on the approved Intel TDX build, automatic admission, probation, public host records and live network statistics.'],['04','Files and payments','Private RAG/files, PDF support, Chat, Tor onion access and blind tokens.','Chat only on this router']];
/** Current features and the next areas of work. */
export function Roadmap(){return <section className="extension muted-surface roadmap" id="roadmap" data-progress><div className="container">
  <div className="section-head" data-reveal><div><span className="eyebrow">Roadmap / live and next</span><h2>A clear route forward.</h2></div><p className="lede" data-surface-extra="">Encrypted chat, the agent rulebook and early-host admission are live at trellis.example. Sealed agent hosting is available, but no sealed agent is registered at trellis.example yet. Network host payouts and bond slashing are not switched on yet.</p><p className="lede" data-surface-core="">This router runs the core launch surface: chat, the model catalogue, API keys, prepaid credits, x402 per call and signed receipts. The areas below are built, and each card says whether this router has it enabled.</p></div>
  <div className="rail" aria-hidden="true"><i/></div>
  <div className="roadmap-grid" data-stagger>{roadmap.map(([n,title,body,core='Not enabled on this router'])=><article className="route-card" key={n} data-reveal><div className="eyebrow">{n}<span data-surface-extra="" style={{display:'contents'}}><span className="live-square"/>Live</span><span data-surface-core="">{core}</span></div><h3>{title}</h3><p>{body}</p><div className="card-ramp"/></article>)}</div>
  <p data-reveal data-surface-extra="">Agreements between agents are live: escrow and dispute contracts on Solana, with disputes ruled by a jury of models on attested hardware.</p>
  <div className="next-stage" data-reveal><span>Agent wallets with on-chain rules; GPU hosts on the network; network payouts.</span><b>Next</b></div>
</div></section>}

/** Why Trellis exists, beside the mark with a signal climbing its center channel. */
export function About(){return <section className="extension" id="about"><div className="container about">
  <div className="about-mark" data-reveal="fade"><Mark signal title="Trellis mark"/></div>
  <div className="about-copy" data-reveal><span className="eyebrow">About Trellis</span><h2 className="h2">Every open model.<br/>A route you can check.</h2><p>Trellis is an open inference router for Solana. A familiar API is the starting point. Clear payments, provider accountability and portable receipts are the reason to go further.</p><blockquote>A route should tell you more than whether a request succeeded.</blockquote><p>Which provider served it? What did it cost? What evidence supports its privacy claims? Who gets paid? Routing, USDC settlement, signed receipts and attestation checks run in the router, with contracts on Solana.</p><div className="button-row" style={{marginTop:32}}><Button href="/docs/">Read the documentation</Button></div></div>
</div></section>}

/** The two-line migration for developers. */
export function Developers(){return <section className="extension muted-surface" id="developers"><div className="container dev">
  <div data-reveal><span className="eyebrow">Built for developers</span><h2 className="h2" style={{margin:'18px 0 24px'}}>A familiar shape.<br/>A different route.</h2><p className="lede">Keep your existing request shape. Point your client at your router’s <code>/api/v1</code> and use a Trellis key. Streaming, tools, structured output and provider preferences work as you expect.</p><div className="button-row" style={{marginTop:32}}><Button href="/dashboard/#playground">Try the playground</Button><Button href="/docs/" secondary>API documentation</Button></div></div>
  <div data-reveal="scale"><Code label="Quickstart · node">{sampleRequest}</Code></div>
</div></section>}
