import PageFrame from "../../components/PageFrame";
import { RegistryList } from "../../components/Registry";

export const metadata = { title: "Registry — Trellis", description: "Every endpoint that attests through the router, the software measurements it verified over time, and an embeddable badge for each." };

export default function RegistryPage() {
  return (
    <PageFrame>
      <main className="page-main" id="content">
        <div className="page-title" data-reveal>
          <h1>Attestation registry</h1>
          <p>Inspect verified measurements, software changes and gaps in attestation for each endpoint.</p>
        </div>
        <RegistryList />
      </main>
    </PageFrame>
  );
}
