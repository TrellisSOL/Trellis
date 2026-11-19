import PageFrame from "../../components/PageFrame";
import ProofTime from "../../components/ProofTime";
import StatusBoard from "../../components/StatusBoard";
import { SurfaceNote } from "../../components/launch/Surface";

export const metadata = { title: "Status — Trellis", description: "Availability, latency and error budgets for each privacy lane and API surface, incidents with Atom and RSS feeds, attestation advisories, and how long each attesting provider held a fresh attestation." };

export default function StatusPage() {
  return (
    <PageFrame>
      <main className="page-main" id="content">
        <div className="page-title" data-reveal>
          <h1>Service status</h1>
          <p>Availability, latency and incidents by route. Public-route figures use request outcomes. Private-route figures use aggregated hourly counts with added noise.</p>
        </div>
        {/* Launch surface: a core router shows this marker; the lanes and their targets stay documented. */}
        <SurfaceNote>The unlinkable lane and encrypted chat are outside the core launch surface this router runs, so they have nothing to report here.</SurfaceNote>
        <StatusBoard />
        <div className="page-title" id="proof-time" style={{ marginTop: "clamp(48px, 7vw, 96px)" }}>
          <h2 className="h2">Attestation coverage</h2>
          <p>Being reachable is not the same as being verified. For each provider that runs in a confidential virtual machine, this is how long the router actually held a fresh attestation it checked itself. Every gap is listed as a gap.</p>
        </div>
        <ProofTime />
      </main>
    </PageFrame>
  );
}
