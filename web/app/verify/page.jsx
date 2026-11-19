import PageFrame from "../../components/PageFrame";
import ProofGuide from "../../components/ProofGuide";
import Verify from "../../components/Verify";

export const metadata = { title: "Verify a provider — Trellis", description: "What the router has and has not verified about a provider’s attestation, and a receipt checker that runs in your browser." };

export default function VerifyPage() {
  return (
    <PageFrame>
      <main className="page-main" id="content">
        <div className="page-title" data-reveal>
          <h1>Verify a receipt</h1>
          <p>Check a receipt signature in your browser or inspect the hardware evidence for a provider.</p>
        </div>
        <Verify />
        <ProofGuide />
      </main>
    </PageFrame>
  );
}
