import PageFrame from './PageFrame';

export default function Publication({title, summary, sections}) {
  return <PageFrame><main id="content" className="page-main">
    <header className="page-title">
      <span className="eyebrow">Trellis · November 2026</span>
      <h1>{title}</h1>
      <p>{summary}</p>
    </header>
    <div className="side-layout">
      <nav className="side-nav" aria-label="Document contents">
        <span className="side-nav-label">Contents</span>
        {sections.map(({id, heading}) => <a key={id} href={'#' + id}>{heading}</a>)}
      </nav>
      <article className="page-body prose">
        {sections.map(({id, heading, body}) => <section className="docs-section" id={id} key={id}>
          <h2>{heading}</h2>{body}
        </section>)}
        <nav aria-label="Further reading">
          <a className="inline-link" href="/docs/">Developer guide</a> · <a className="inline-link" href="/status/">Live status</a>
        </nav>
      </article>
    </div>
  </main></PageFrame>;
}
