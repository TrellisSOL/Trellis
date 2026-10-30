import {Wordmark} from './Logo';

import {GROUPS,TASKS} from '../lib/site-map';
import {enabled,hrefEnabled} from '../lib/launch-surface.js';
// Footer-only links that aren't tools in the menus: page sections, SDKs, a few search-only pages and support.
const EXTRA={build:[['SDKs','/docs/#sdk'],['Playground','/dashboard/#playground'],['Registry','/registry/']],verify:[['Badge','/docs/#badge'],['Proof-time','/status/#proof-time']],learn:[['Quickstart','/how-it-works/#developers'],['How it works','/how-it-works/#how-it-works'],['Route types','/how-it-works/#routes'],['Privacy route','/how-it-works/#privacy'],['Support','mailto:support@trellis.example']]};
// Each link also says whether it stays in core (lib/launch-surface.js): menu tools by their own entry, the extra links by where they lead.
const off=on=>on?{}:{'data-surface-extra':''};
const COLUMNS=GROUPS.map(group=>[group.title,[...TASKS.filter(task=>task.group===group.id&&task.menu).map(task=>[task.title,task.href,enabled('nav',task.id,'core')]),...(EXTRA[group.id]||[]).map(([label,href])=>[label,href,hrefEnabled(href,'core')])]]);

/** Site footer: the link columns and one quiet line. (Night garden: no curtain, no giant wordmark; pages end on their own call to action.) */
export default function Footer(){return <footer className="site-footer">
  <div className="container footer-links"><div className="footer-about"><Wordmark aria-hidden="true"/><p>The open inference router for Solana. Any model, any provider, an accountable route.</p></div>{COLUMNS.map(([title,links])=><nav key={title} aria-label={title} {...off(links.some(link=>link[2]))}><h4>{title}</h4><ul>{links.map(([label,href,core])=><li key={label} {...off(core)}><a href={href}>{label}</a></li>)}</ul></nav>)}</div>
  <div className="container footer-base"><span><i/>Built on Solana</span><span>Receipts: Ed25519 · signed per call</span><span>© Trellis</span></div>
</footer>}
