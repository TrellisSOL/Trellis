export default function NetworkHostPayout({ payout }) {
  if (!payout) return null;
  return <section><h3>Accrued net host payments</h3>
    <p>{payout.accrued_net_band}</p>
    {payout.accrued_net_usdc_units !== undefined && <p>Accrued net USDC units: <code>{payout.accrued_net_usdc_units}</code> · {payout.decimals} decimals.</p>}
    <p>{payout.basis}</p><p>{payout.enabled ? 'Paid per token served.' : 'Network payouts are switched off.'} {payout.fee_bps ? `A ${payout.fee_bps / 100}% network fee is deducted.` : 'No network fee is deducted.'}</p>
  </section>;
}
