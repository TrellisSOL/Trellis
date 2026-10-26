import SpecDoc from "./SpecDoc";
import { loadDoc } from "../../lib/graft-spec";

export const metadata = {
  title: "GRAFT specification — Trellis",
  description: "The GRAFT privacy protocol: lanes, guarantees, who learns what, honest limits and the status of each part, with the five RFC-style documents. Apache-2.0.",
};

export default function SpecIndex() {
  return <SpecDoc doc={loadDoc("")} />;
}
