import PageFrame from './PageFrame';
import styles from './Publication.module.css';

const library = [
  {id: 'docs', label: 'Developer guide', image: 'rows-dawn'},
  {id: 'whitepaper', label: 'Whitepaper', image: 'gate'},
  {id: 'roadmap', label: 'Roadmap', image: 'arch'},
];

export function ReferenceGroup({title, id, children}) {
  return <details id={id} className={styles.reference}>
    <summary>{title}</summary>
    <div className={styles.referenceBody}>{children}</div>
  </details>;
}

export default function Publication({kind, title, summary, sections, contents, children}) {
  const document = library.find(item => item.id === kind);
  return <PageFrame><main id="content" className={`garden ${styles.reading}`}>
    <div className={styles.wrap}>
      <nav aria-label="Trellis publications" className={styles.library}>
        {library.map(item => <a key={item.id} href={'/' + item.id + '/'} aria-current={item.id === kind ? 'page' : undefined}>{item.label}</a>)}
      </nav>
      <header className={styles.cover}>
        <div>
          <h1>{title}</h1>
          <p>{summary}</p>
        </div>
        <img aria-hidden="true" src={'/art/' + document.image + '.jpg'} alt="" width="520" height="260" />
      </header>
      <div className={styles.layout}>
        <nav className={styles.contents} aria-label="Document contents">
          <h2>Contents</h2>
          <ul>{(contents || sections).map(({id, heading}) =>
            <li key={id}><a href={'#' + id}>{heading}</a></li>
          )}</ul>
        </nav>
        <article className={`prose ${styles.article} ${kind === 'docs' ? 'docs-body' : ''}`}>
          {children || sections.map(({id, heading, body, group}) => <section className={styles.chapter} id={id} key={id}>
            {group && <p className={styles.group}>{group}</p>}
            <h2>{heading}</h2>{body}
          </section>)}
        </article>
      </div>
    </div>
  </main></PageFrame>;
}
