// The licence rule of the catalogue (docs/Trellis_Backend.md §2, Overview §2):
//   - a model under MIT or Apache-2.0 lists without review;
//   - a model under a vendor licence (Gemma Terms of Use, Llama Community License, and anything derived from those
//     models, such as Hermes 4 405B) lists only after a licence check by an operator, and the vendor's acceptable-use
//     terms are recorded with the listing so the policy classifier can enforce them;
//   - a licence this table does not know is blocked;
//   - a fine-tune that removes safety layers is listed only when the base licence permits the modification, and is
//     never listed for a Gemma or Llama derivative, review or not.
// Pure data and functions: nothing here reads the network or the database.

export type LicenceFamily = "permissive" | "gemma" | "llama";
export type Listing = "list" | "needs_review" | "blocked";

export type LicenceRule = {
  id: string;
  name: string;
  family: LicenceFamily;
  /** What a model under this licence needs before it is listed. */
  listing: Exclude<Listing, "blocked">;
  /** Whether a fine-tune that removes the base model's safety layers may be listed under it. */
  safetyRemovalListed: boolean;
  /** The vendor's acceptable-use terms a listing must carry (flags the policy classifier reads). Empty for permissive licences. */
  acceptableUse: string[];
  url: string;
};

const LLAMA_USE = ["llama_acceptable_use_policy", "built_with_llama_notice", "licence_copy_passed_on"];
const llama = (id: string, name: string, url: string, extra: string[] = []): LicenceRule => ({ id, name, family: "llama", listing: "needs_review", safetyRemovalListed: false, acceptableUse: [...LLAMA_USE, ...extra], url });

export const LICENCES: readonly LicenceRule[] = [
  { id: "mit", name: "MIT License", family: "permissive", listing: "list", safetyRemovalListed: true, acceptableUse: [], url: "https://opensource.org/license/mit" },
  { id: "apache-2.0", name: "Apache License 2.0", family: "permissive", listing: "list", safetyRemovalListed: true, acceptableUse: [], url: "https://www.apache.org/licenses/LICENSE-2.0" },
  { id: "gemma", name: "Gemma Terms of Use", family: "gemma", listing: "needs_review", safetyRemovalListed: false, acceptableUse: ["gemma_prohibited_use_policy", "use_restrictions_passed_on", "terms_copy_passed_on"], url: "https://ai.google.dev/gemma/terms" },
  llama("llama2", "Llama 2 Community License", "https://ai.meta.com/llama/license/"),
  llama("llama3", "Llama 3 Community License", "https://www.llama.com/llama3/license/", ["model_name_starts_with_llama"]),
  llama("llama3.1", "Llama 3.1 Community License", "https://www.llama.com/llama3_1/license/", ["model_name_starts_with_llama"]),
  llama("llama3.2", "Llama 3.2 Community License", "https://www.llama.com/llama3_2/license/", ["model_name_starts_with_llama"]),
  llama("llama3.3", "Llama 3.3 Community License", "https://www.llama.com/llama3_3/license/", ["model_name_starts_with_llama"]),
  llama("llama4", "Llama 4 Community License", "https://www.llama.com/llama4/license/", ["model_name_starts_with_llama"]),
];

const ALIASES: Record<string, string> = {
  "apache2": "apache-2.0", "apache-2": "apache-2.0", "apache 2.0": "apache-2.0", "apache license 2.0": "apache-2.0", "apache-2.0-only": "apache-2.0",
  "mit license": "mit", "expat": "mit",
  "gemma-terms-of-use": "gemma", "gemma terms of use": "gemma", "gemma-terms": "gemma",
  "llama-2": "llama2", "llama-3": "llama3", "llama-3.1": "llama3.1", "llama-3.2": "llama3.2", "llama-3.3": "llama3.3", "llama-4": "llama4",
  "llama2-community": "llama2", "llama3-community": "llama3", "llama3.1-community": "llama3.1", "llama3.2-community": "llama3.2", "llama3.3-community": "llama3.3", "llama4-community": "llama4",
  "llama community license": "llama3.1",
};
const BY_ID = new Map(LICENCES.map((l) => [l.id, l]));

/** The rule for a licence identifier as a model card writes it, or null when the table does not know it. */
export function licenceRule(id: string | null | undefined): LicenceRule | null {
  const key = (id ?? "").trim().toLowerCase();
  return BY_ID.get(ALIASES[key] ?? key) ?? null;
}

/**
 * Models that are fine-tunes of a vendor-licensed model whatever licence their own card names: the vendor's licence
 * follows the weights. Matched on the lower-cased repository id.
 */
export const KNOWN_DERIVATIVES: Record<string, { family: Exclude<LicenceFamily, "permissive">; licence: string }> = {
  "nousresearch/hermes-4-405b": { family: "llama", licence: "llama3.1" },
  "nousresearch/hermes-4-70b": { family: "llama", licence: "llama3.1" },
  "nousresearch/hermes-3-llama-3.1-405b": { family: "llama", licence: "llama3.1" },
  "nousresearch/hermes-3-llama-3.1-70b": { family: "llama", licence: "llama3.1" },
};

/** The vendor family a model id belongs to by its name or by the derivative table; null for anything else. */
export function vendorFamilyOf(modelId: string | null | undefined): { family: Exclude<LicenceFamily, "permissive">; licence: string | null } | null {
  const id = (modelId ?? "").trim().toLowerCase();
  if (!id) return null;
  const known = KNOWN_DERIVATIVES[id];
  if (known) return known;
  const name = id.split("/").pop() ?? id;
  if (/gemma/.test(name)) return { family: "gemma", licence: "gemma" };
  if (/(^|[-_./])(code)?llama[-_.]?(\d|guard)/.test(name) || /^meta-llama\//.test(id)) {
    const v = /llama[-_.]?(\d(?:\.\d)?)/.exec(name)?.[1];
    return { family: "llama", licence: v && BY_ID.has(`llama${v}`) ? `llama${v}` : null };
  }
  return null;
}

/** Names that say a fine-tune had its safety layers or refusal behaviour removed. */
const SAFETY_REMOVED = /abliterat|uncensor|decensor|lorablated|no[-_ ]?refus|unfilter|jailbr[eo]ak|unaligned/i;
export const nameSuggestsSafetyRemoval = (id: string) => SAFETY_REMOVED.test(id);

export type LicenceCandidate = { model: string; baseModel?: string | null; licence?: string | null; removesSafetyLayers?: boolean };
export type LicenceDecision = {
  decision: Listing;
  /** The rule that governs the listing: the vendor's when the model or its base is a vendor derivative, else the declared one. */
  licence: string | null;
  family: LicenceFamily | null;
  removesSafetyLayers: boolean;
  acceptableUse: string[];
  reasons: string[];
  /** False when no review can change the outcome (a safety-removed Gemma or Llama derivative). */
  reviewable: boolean;
};

/** Apply the licence rule to a candidate. */
export function decideListing(c: LicenceCandidate): LicenceDecision {
  const declared = licenceRule(c.licence);
  const vendor = vendorFamilyOf(c.baseModel) ?? vendorFamilyOf(c.model);
  const removes = !!c.removesSafetyLayers || nameSuggestsSafetyRemoval(c.model);
  // A vendor licence follows the weights: a derivative of a Gemma or Llama model is governed by that licence even when
  // its own card names a permissive one.
  const rule = vendor ? (declared && declared.family === vendor.family ? declared : licenceRule(vendor.licence) ?? LICENCES.find((l) => l.family === vendor.family)!) : declared;
  const reasons: string[] = [];
  if (!rule) {
    reasons.push(c.licence ? `licence "${c.licence.slice(0, 60)}" is not in the licence table` : "no licence was given");
    return { decision: "blocked", licence: null, family: null, removesSafetyLayers: removes, acceptableUse: [], reasons, reviewable: false };
  }
  if (vendor && (!declared || declared.family !== vendor.family)) reasons.push(`a ${vendor.family === "gemma" ? "Gemma" : "Llama"} derivative: the vendor licence applies whatever licence the card names`);
  if (removes && !rule.safetyRemovalListed) {
    reasons.push(`fine-tunes that remove safety layers are not listed for ${rule.family === "gemma" ? "Gemma" : "Llama"} derivatives`);
    return { decision: "blocked", licence: rule.id, family: rule.family, removesSafetyLayers: true, acceptableUse: rule.acceptableUse, reasons, reviewable: false };
  }
  if (rule.listing === "needs_review") reasons.push(`${rule.name}: listed only after a licence check, with the vendor's acceptable-use terms enforced`);
  if (removes) reasons.push("removes safety layers: the base licence permits the modification; served as a restricted variant");
  return { decision: rule.listing, licence: rule.id, family: rule.family, removesSafetyLayers: removes, acceptableUse: rule.acceptableUse, reasons, reviewable: rule.listing === "needs_review" };
}

/** The table as GET /api/v1/catalog/licences publishes it. */
export const licenceTable = () => ({
  rule: "MIT and Apache-2.0 list without review. Vendor licences (Gemma Terms of Use, Llama Community License and derivatives) list only after a licence check, with the vendor's acceptable-use terms enforced. Unknown licences are not listed. Fine-tunes that remove safety layers are listed only when the base licence permits the modification, and never for Gemma or Llama derivatives.",
  licences: LICENCES.map((l) => ({ id: l.id, name: l.name, family: l.family, listing: l.listing, safety_removal_listed: l.safetyRemovalListed, acceptable_use: l.acceptableUse, url: l.url })),
  known_derivatives: Object.entries(KNOWN_DERIVATIVES).map(([model, d]) => ({ model, family: d.family, licence: d.licence })),
});
