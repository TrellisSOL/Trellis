import PageFrame from "../../components/PageFrame";
import Providers from "../../components/Providers";

export const metadata = { title: "Providers — Trellis", description: "Every provider the router lists, with the attestation status the router itself has verified, and how to run a provider." };

export default function ProvidersPage() {
  return (
    <PageFrame>
      <main className="page-main" id="content">
        <div className="page-title" data-reveal>
          <h1>Inference providers</h1>
          <p>Inspect the available evidence for each provider and the date of its latest hardware check.</p>
        </div>
        <Providers />
      </main>
    </PageFrame>
  );
}
