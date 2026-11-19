import PageFrame from "../../components/PageFrame";
import { SurfaceNote } from "../../components/launch/Surface";
import { REPO_URL, SPEC_LICENSE_URL } from "../../lib/graft-spec";
import s from "./spec.module.css";

const label = (d) => (d.number ? `${d.number} ${d.shortTitle}` : d.shortTitle);

/** One GRAFT specification document, rendered at build time from spec/<file>. */
export default function SpecDoc({ doc }) {
  const at = doc.docs.findIndex((d) => d.slug === doc.slug);
  const prev = doc.docs[at - 1];
  const next = doc.docs[at + 1];
  const toc = doc.headings.filter((h) => h.level === 2);
  const source = `${REPO_URL}/blob/main/spec/${doc.file}`;
  return (
    <PageFrame>
      <main className="page-main" id="content">
        {/* Launch surface: the specification is reference reading and stays open; a core router shows this one marker. */}
        <SurfaceNote>This router runs the core launch surface. The specification covers the whole protocol; of it this router serves signed receipts and attestation records, and not blind tokens, the unlinkable lane or encrypted pass-through.</SurfaceNote>
        <div className="page-title" data-reveal>
          <span className="eyebrow">
            GRAFT SPECIFICATION / {doc.number || (doc.slug ? doc.shortTitle.toUpperCase() : "OVERVIEW")}
            {doc.version.version ? ` · v${doc.version.version}` : ""}
          </span>
          <h1>{doc.number ? doc.shortTitle : doc.title}</h1>
          {doc.number ? (
            doc.description && <p>{doc.description}</p>
          ) : (
            <p>{doc.slug ? "Every version of the GRAFT specification, newest first." : `The GRAFT specification${doc.version.version ? `, version ${doc.version.version}` : ""}: the overview and status table, then ${doc.docs.filter((d) => d.number).length} documents a third party can implement or verify against.`}</p>
          )}
        </div>
        <div className="side-layout">
          <nav className={`side-nav ${s.nav}`} aria-label="GRAFT specification" data-reveal="fade">
            <span className="side-nav-label">Documents</span>
            {doc.docs.map((d) => (
              <a key={d.url} href={d.url} aria-current={d.slug === doc.slug ? "page" : undefined}>
                {label(d)}
              </a>
            ))}
            {toc.length > 1 && (
              <>
                <span className={`side-nav-label ${s.tocLabel}`}>On this page</span>
                {toc.map((h) => (
                  <a key={h.id} href={`#${h.id}`} className={s.toc}>
                    {h.text}
                  </a>
                ))}
              </>
            )}
          </nav>
          <article className={`page-body prose ${s.doc}`}>
            <div className="note">
              The protocol documents use the{" "}
              <a href={SPEC_LICENSE_URL} rel="noopener noreferrer" target="_blank">
                Apache License 2.0
              </a>
              . The repository has a separate license for the implementation. Read the source in{" "}
              <a href={source} rel="noopener noreferrer" target="_blank">
                <code>spec/{doc.file}</code>
              </a>
            </div>
            <div className={s.body} dangerouslySetInnerHTML={{ __html: doc.html }} />
            <nav className={s.pager} aria-label="Previous and next document">
              {prev ? (
                <a href={prev.url} rel="prev">
                  <span>Previous</span>
                  {label(prev)}
                </a>
              ) : (
                <span />
              )}
              {next ? (
                <a href={next.url} rel="next">
                  <span>Next</span>
                  {label(next)}
                </a>
              ) : (
                <a href="/graft/">
                  <span>Overview</span>
                  GRAFT, in one page
                </a>
              )}
            </nav>
          </article>
        </div>
      </main>
    </PageFrame>
  );
}
