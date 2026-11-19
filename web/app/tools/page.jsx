import PageFrame from "../../components/PageFrame";
import { SurfaceGate } from "../../components/launch/Surface";
import ToolsCatalog from "../../components/ToolsCatalog";

export const metadata = { title: "Paid tools — Trellis", description: "x402 tools any Trellis key can pay from its balance, each with a daily known-answer probe, and how a paid call is held, charged and receipted." };

export default function ToolsPage() {
  return (
    <PageFrame><SurfaceGate page="/tools/">
      <main className="page-main" id="content">
        <div className="page-title" data-reveal>
          <h1>Paid tools</h1>
          <p>Where a router has its paid tool market switched on, a Trellis key can call any x402 tool priced in USDC on Solana. The router pays the seller, charges the key the price plus its take and signs a receipt. Your rulebook decides which tools, how much per call and how much per day.</p>
        </div>
        <ToolsCatalog />
      </main>
    </SurfaceGate></PageFrame>
  );
}
