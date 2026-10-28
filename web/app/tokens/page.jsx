import PageFrame from "../../components/PageFrame";
import { SurfaceGate } from "../../components/launch/Surface";
import PrivatePurse from "../../components/PrivatePurse";

export const metadata = {
  title: "Private tokens — Trellis",
  description: "Pay from your own wallet and end up holding blind tokens in your browser: a one-time key, no account, and a plain account of what stays linkable.",
};

export default function PrivateTokensPage() {
  return (
    <PageFrame><SurfaceGate page="/tokens/">
      <main className="page-main" id="content">
        <div className="page-title" data-reveal>
          <span className="eyebrow">Private tokens / From your wallet</span>
          <h1>
            Private tokens,
            <br />
            kept on your device.
          </h1>
          <p>
            Pay from your own wallet and end up holding blind tokens in this browser. No account, and no long-lived key: a one-time key is made here, receives your payment, buys the tokens and is thrown away. Everything runs in your browser, and below is a plain
            account of what stays linkable to you and what does not.
          </p>
        </div>
        <PrivatePurse />
      </main>
    </SurfaceGate></PageFrame>
  );
}
