// A small, consistent icon set: 24-unit grid, 1.6 stroke, round caps, currentColor. Decorative by default
// (aria-hidden); pass a `title` to make one meaningful.
const PATHS = {
  key: <><circle cx="8" cy="15" r="4" /><path d="m10.8 12.2 8.7-8.7M16 7l2.5 2.5M13.5 9.5 16 12" /></>,
  anchor: <><circle cx="12" cy="5" r="2.2" /><path d="M12 7.2V21M8 11h8M4.5 13.5A7.5 7.5 0 0 0 12 21a7.5 7.5 0 0 0 7.5-7.5" /></>,
  pulse: <path d="M3 12h4l2.5-6 5 12 2.5-6h4" />,
  chip: <><rect x="7" y="7" width="10" height="10" rx="2" /><path d="M10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4" /></>,
  shield: <path d="M12 3 19 5.8v5.4c0 4.2-2.9 7.6-7 9.3-4.1-1.7-7-5.1-7-9.3V5.8L12 3Z" />,
  shieldCheck: <><path d="M12 3 19 5.8v5.4c0 4.2-2.9 7.6-7 9.3-4.1-1.7-7-5.1-7-9.3V5.8L12 3Z" /><path d="m9 12 2.2 2.2L15.5 10" /></>,
  user: <><circle cx="12" cy="8" r="3.6" /><path d="M5 20c.8-3.6 3.6-5.6 7-5.6s6.2 2 7 5.6" /></>,
  router: <><rect x="3.5" y="13" width="17" height="6.5" rx="2" /><path d="M7.5 16.3h.01M11 16.3h.01M15 16.3h2.5M8 13l-2-5M16 13l2-5" /><path d="M9.5 6.5a3.5 3.5 0 0 1 5 0" /></>,
  server: <><rect x="4" y="4" width="16" height="7" rx="2" /><rect x="4" y="13" width="16" height="7" rx="2" /><path d="M8 7.5h.01M8 16.5h.01M12 7.5h4M12 16.5h4" /></>,
  receipt: <><path d="M6 3h12v18l-3-1.8-3 1.8-3-1.8L6 21V3Z" /><path d="M9.5 8h5M9.5 11.5h5M9.5 15h3" /></>,
  blocks: <><path d="m12 3 7.5 4.3v8.4L12 20l-7.5-4.3V7.3L12 3Z" /><path d="M12 11.6 19.5 7.3M12 11.6 4.5 7.3M12 11.6V20" /></>,
  eye: <><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" /><circle cx="12" cy="12" r="2.8" /></>,
  archive: <><rect x="3.5" y="4" width="17" height="4.5" rx="1.2" /><path d="M5 8.5V18a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5M10 12.5h4" /></>,
  fileCheck: <><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z" /><path d="M14 3v5h5M9.2 14.2l2 2 3.8-4" /></>,
  upload: <><path d="M12 15V4M7.5 8.5 12 4l4.5 4.5" /><path d="M4.5 15v4.5h15V15" /></>,
  book: <><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5v-15Z" /><path d="M4 20.5A2.5 2.5 0 0 1 6.5 18H20v3H6.5" /></>,
  code: <path d="m9 7-5 5 5 5M15 7l5 5-5 5" />,
  layers: <><path d="m12 3 9 4.8-9 4.8-9-4.8L12 3Z" /><path d="m3 12.2 9 4.8 9-4.8M3 16.6l9 4.8 9-4.8" /></>,
  zap: <path d="M13 2.5 4.5 13.5h6.5l-1 8 8.5-11h-6.5l1-8Z" />,
  coins: <><ellipse cx="9" cy="7.5" rx="5.5" ry="2.8" /><path d="M3.5 7.5v4c0 1.5 2.5 2.8 5.5 2.8s5.5-1.3 5.5-2.8v-4" /><path d="M9.5 17.7c.8.3 1.9.5 3 .5 3 0 5.5-1.3 5.5-2.8v-4c0-1.2-1.4-2.2-3.5-2.6" /></>,
  scale: <><path d="M12 4v16M7 20h10M5 8h14M12 4l-1 4M12 4l1 4" /><path d="m5 8-2.5 6a2.5 2.5 0 0 0 5 0L5 8ZM19 8l-2.5 6a2.5 2.5 0 0 0 5 0L19 8Z" /></>,
  sparkles: <><path d="M12 3.5 13.6 9l5.4 1.6-5.4 1.6L12 17.5l-1.6-5.3L5 10.6 10.4 9 12 3.5Z" /><path d="M18.5 15.5 19.2 18l2.3.7-2.3.7-.7 2.4-.7-2.4-2.3-.7 2.3-.7.7-2.5Z" /></>,
  clock: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></>,
  check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  minus: <path d="M6 12h12" />,
  x: <path d="M6.5 6.5 17.5 17.5M17.5 6.5 6.5 17.5" />,
  arrowIn: <><path d="M4 12h11M11 7.5 15.5 12 11 16.5" /><path d="M19.5 4.5v15" /></>,
  arrowOut: <><path d="M4.5 4.5v15M9 12h11M16 7.5l4.5 4.5-4.5 4.5" /></>,
  context: <><rect x="3.5" y="4.5" width="17" height="15" rx="2.5" /><path d="M7.5 9h9M7.5 12.5h9M7.5 16h5" /></>,
  globe: <><circle cx="12" cy="12" r="8.5" /><path d="M3.5 12h17M12 3.5c2.3 2.4 3.4 5.2 3.4 8.5s-1.1 6.1-3.4 8.5c-2.3-2.4-3.4-5.2-3.4-8.5S9.7 5.9 12 3.5Z" /></>,
  rss: <><path d="M5 11a8 8 0 0 1 8 8M5 5a14 14 0 0 1 14 14" /><circle cx="6" cy="18" r="1.3" /></>,
  bug: <><rect x="7.5" y="8" width="9" height="12" rx="4.5" /><path d="M9.5 8a2.5 2.5 0 0 1 5 0M3.5 13h4M16.5 13h4M4.5 8.5l3 2M19.5 8.5l-3 2M4.5 18.5l3-2M19.5 18.5l-3-2" /></>,
  external: <path d="M14 4h6v6M20 4l-9 9M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4" />,
  chat: <path d="M4.5 18.5 6 15a7.5 7.5 0 1 1 3.5 3.1l-5 .4Z" />,
  copy: <><rect x="8" y="8" width="12" height="12" rx="2.5" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></>,
  gauge: <><path d="M4 16a8 8 0 1 1 16 0" /><path d="m12 16 4-5" /><circle cx="12" cy="16" r="1.3" /></>,
};

export const ICON_NAMES = Object.keys(PATHS);

export function Icon({ name, size = 18, strokeWidth = 1.6, title, className, style }) {
  const p = PATHS[name];
  if (!p) return null;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round"
      className={className} style={style} role={title ? "img" : undefined} aria-label={title} aria-hidden={title ? undefined : true} focusable="false">
      {title && <title>{title}</title>}
      {p}
    </svg>
  );
}

/** An icon in a soft rounded tile: the house way to lead a card or a step. */
export function IconTile({ name, tone = "plain", size = 40, icon = 19 }) {
  return (
    <span className="icon-tile" data-tone={tone} style={{ width: size, height: size }} aria-hidden="true">
      <Icon name={name} size={icon} />
    </span>
  );
}
