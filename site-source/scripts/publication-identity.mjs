import { createHash } from "node:crypto";
import { normalizeIdentityV2, compareIdentities, reviewIdentityCaseV2 } from "./identity-policy.mjs";
import { evidenceRef, PII } from "./review-policy.mjs";

const PRINTING_FIELDS = new Set(["year", "product", "player", "team", "checklistCardId", "printedCardCode", "jerseyNumber", "category", "parallel", "autograph", "relic", "serialLimit"]);
const COMPARISON_GROUP_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COPY_FIELDS = ["year", "product", "player", "team", "checklistCardId", "printedCardCode", "jerseyNumber", "category", "parallel", "autograph", "relic", "serialLimit", "serialNumber", "gradingStatus", "gradingCompany", "grade", "condition"];

export function publicPrintingIdentity(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("printingIdentity must be an object");
  for (const [field, value] of Object.entries(input)) {
    if (!PRINTING_FIELDS.has(field)) throw new Error("printingIdentity cannot contain copy, grading, condition, or private fields: " + field);
    if (typeof value === "string" && PII.test(value)) throw new Error("printingIdentity contains contact information");
  }
  const normalized = normalizeIdentityV2(input);
  if (normalized.year !== 2026 || normalized.product !== "scc_sensation" || compareIdentities(normalized, normalized).decision !== "exact_identity") throw new Error("printingIdentity needs complete, reviewed 2026 SCC SENSATION printing fields");
  return Object.fromEntries([...PRINTING_FIELDS].map((field) => [field, normalized[field]]));
}

export function validatePublicCardIdentity(card) {
  const identity = publicPrintingIdentity(card.printingIdentity);
  if (identity.player !== normalizeIdentityV2({ player: card.player }).player || identity.team !== normalizeIdentityV2({ team: card.team }).team || identity.checklistCardId !== card.cardNumber) throw new Error("public player, team, or card number conflicts with printingIdentity");
  return identity;
}

export function publicationComparison(row, card, audit) {
  if (audit.inventoryOrigin !== "independent_market") throw new Error("only explicitly independent market observations may be published; owner-held and unknown origins are excluded");
  if (row.matchLevel !== "exact") {
    if (row.comparisonKey != null || audit.identityReview != null || audit.identityEvidenceRef != null || audit.comparisonGroupId != null) throw new Error("unconfirmed candidates cannot carry exact comparison approvals");
    return null;
  }
  if (!evidenceRef(audit.identityEvidenceRef)) throw new Error("exact observations require a concrete private identity evidence reference");
  for (const identity of [audit.identityReview?.catalogIdentity, audit.identityReview?.listingIdentity]) {
    for (const value of Object.values(identity ?? {})) if (typeof value === "string" && PII.test(value)) throw new Error("identity review contains personal contact information");
  }
  const proposal = reviewIdentityCaseV2(audit.identityReview);
  if (!proposal.identityComparable) throw new Error("exact public comparison requires complete matching identity, serial, grading, and condition");
  if (typeof audit.comparisonGroupId !== "string" || !COMPARISON_GROUP_ID.test(audit.comparisonGroupId)) throw new Error("exact public comparison requires a private random comparison-group UUID");
  const publicIdentity = validatePublicCardIdentity(card);
  if (compareIdentities(publicIdentity, audit.identityReview.catalogIdentity).decision !== "exact_identity") throw new Error("private identity review does not match the public printing identity");
  const identity = normalizeIdentityV2(audit.identityReview.catalogIdentity);
  const signature = JSON.stringify(COPY_FIELDS.map((field) => identity[field]));
  return createHash("sha256").update("scc-public-comparison-group:v1\0").update(audit.comparisonGroupId).update("\0").update(signature).digest("hex");
}
