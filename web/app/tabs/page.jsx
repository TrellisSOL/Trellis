import PageFrame from "../../components/PageFrame";
import SessionKey from "../../components/SessionKey";

export const metadata = {
  title: "Pay by tab — Trellis",
  description: "Authorize a ceiling once, pay exactly what you used, get the rest back: how tabs work, whether this router has them open, and the session key that signs for yours.",
};

export default function TabsPage() {
  return (
    <PageFrame>
      <main className="page-main" id="content">
        <div className="page-title" data-reveal>
          <h1>Payment tabs</h1>
          <p>
            A tab puts a ceiling in escrow once; every call then carries a voucher your session key signs for the running total, and closing the tab pays exactly that and returns the rest. Tabs are opened from the SDKs. This page says whether this router has them open and makes the session key that signs for yours.
          </p>
        </div>
        <SessionKey />
        <section className="page-body prose" data-reveal>
          <h2>What happens, in order</h2>
          <ol>
            <li>Make a session key here (or let the SDK make one). Its public key is all you share.</li>
            <li>From the SDK, open a tab: your wallet signs <code>open_tab(payer, payee, USDC, cap, expiry)</code> once, moving the cap into the <code>trellis_tab</code> escrow. The expiry is at most 30 days out.</li>
            <li>Each call carries a voucher: the session key's ed25519 signature for the cumulative amount used and a sequence number, bound to the tab program, the tab and the moment this tab was opened. No wallet prompt, nothing on chain per call.</li>
            <li>The payee closes the tab with the highest voucher and is paid that amount; the rest of the cap returns to you. If the payee never closes, anyone can reclaim after the expiry plus 24 hours: the payee gets what it posted, you get the rest.</li>
          </ol>
          <p>
            The payee stops serving when unvouched usage exceeds the larger of 25% of the last request's cost and $0.05, so neither side is exposed for long. <a className="inline-link" href="/docs/#tabs">Read the tab scheme</a> · <a className="inline-link" href="/docs/#facilitator">Read about the facilitator</a>
          </p>
        </section>
      </main>
    </PageFrame>
  );
}
