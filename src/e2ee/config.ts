import { readFileSync } from "node:fs";
import { parse } from "yaml";

export const E2EE_GATEWAY_PROVIDER = "confidential-ai-gateway";
/** The loader checks the operator's provider manifest; startup also checks the database row. */
export function e2eeSettings(enabled: boolean, providersFile: string | undefined, production: boolean, pin: { baseUrl?: string; attestationUrl?: string } = {}) {
  let provider: { baseUrl: string; attestationUrl: string } | undefined;
  if (enabled && production && !providersFile) {
    // Without a providers file, the operator pins the gateway with two settings; the database row must match them.
    const baseUrl = pin.baseUrl?.replace(/\/$/, ""), attestationUrl = pin.attestationUrl;
    if (!baseUrl?.startsWith("https://") || !attestationUrl?.startsWith("https://"))
      throw new Error("E2EE_PASSTHROUGH_ENABLED in production needs PROVIDERS_FILE, or both E2EE_GATEWAY_BASE_URL and E2EE_GATEWAY_ATTESTATION_URL (https) pinning confidential-ai-gateway.");
    return { enabled, provider: { baseUrl, attestationUrl } };
  }
  if (enabled && production) {
    const doc = parse(readFileSync(providersFile as string, "utf8"));
    const p = doc?.providers?.find((p: any) => p.id === E2EE_GATEWAY_PROVIDER);
    if (!p || p.status !== "live" || p.tee?.kind !== "tdx" || !p.api_key_env || !String(p.base_url).startsWith("https://") || !String(p.tee?.attestation_url).startsWith("https://"))
      throw new Error("E2EE_PASSTHROUGH_ENABLED requires a live HTTPS confidential-ai-gateway TDX provider with a credential reference and attestation URL.");
    provider = { baseUrl: p.base_url.replace(/\/$/, ""), attestationUrl: p.tee.attestation_url };
  }
  return { enabled, provider };
}
