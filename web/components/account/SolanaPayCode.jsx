'use client';
import { useMemo } from 'react';
import { qrMatrix, qrPath } from '../../lib/qr.js';
import { CopyButton } from '../UI';
import s from './SolanaPayCode.module.css';

/**
 * A Solana Pay transfer request as a scannable code plus the link itself. The code is drawn here from the text
 * (lib/qr.js); nothing is fetched. `url` is from lib/add-funds.js solanaPayLink().
 */
export default function SolanaPayCode({ url, title = 'Pay from a wallet app' }) {
  const code = useMemo(() => {
    if (!url) return null;
    try {
      const m = qrMatrix(url);
      return { size: m.size, d: qrPath(m) };
    } catch {
      return null;
    }
  }, [url]);
  if (!url) return null;
  return <figure className={s.figure} aria-label={title}>
    {code
      ? <svg className={s.code} viewBox={`-2 -2 ${code.size + 4} ${code.size + 4}`} role="img" aria-label="Solana Pay code" shapeRendering="crispEdges"><rect x="-2" y="-2" width={code.size + 4} height={code.size + 4} fill="#fff"/><path d={code.d} fill="#000"/></svg>
      : <p className="help-text">The link is too long for a code; copy it instead.</p>}
    <figcaption>
      <strong>{title}</strong>
      <p>Scan with Phantom, Solflare, Backpack or another Solana Pay wallet, or open the link on the phone that holds the wallet.</p>
      <p className={s.link}><a href={url}>{url}</a> <CopyButton text={url} label="Copy link"/></p>
    </figcaption>
  </figure>;
}
