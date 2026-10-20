import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REVIEW_FILE = path.join(".ops-private", "catalog-review.json");
const MAX_BYTES = 64 * 1024;
const FIELDS = new Set(["formatVersion", "catalogSha256", "sourceUrl", "verifiedAt", "reviewedAt", "reviewer", "publicationBasis", "publicationEvidenceRef", "imageUse", "noPersonalData"]);
const BASES = new Set(["written_permission", "terms_allow_metadata_display"]);
const DATE = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const EVIDENCE_REF = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,159}$/;
const PII = /(?:[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|(?:\+?82[- .]?)?0?1[016789][-. ]?\d{3,4}[- .]?\d{4}|계좌번호|전화번호|휴대폰|연락처|오픈채팅|카카오톡\s*(?:ID|아이디))/i;

export function catalogFingerprint(catalog) {
  const snapshot = { sourceUrl: catalog?.sourceUrl ?? null, verifiedAt: catalog?.verifiedAt ?? null, cards: catalog?.cards ?? [] };
  return createHash("sha256").update(JSON.stringify(snapshot), "utf8").digest("hex");
}

export function validateCatalogReviewLedger(data, siteRoot = root) {
  const errors = [];
  const official = data?.officialCatalog;
  if (official?.status !== "verified" || !Array.isArray(official.cards) || official.cards.length === 0) {
    return { errors, reviewed: false };
  }

  const file = path.join(siteRoot, REVIEW_FILE);
  let review;
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) throw new Error("expected a regular JSON file under 64 KiB");
    review = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    return { errors: ["private catalog review is missing or invalid (" + error.message + ")"], reviewed: false };
  }
  if (!review || typeof review !== "object" || Array.isArray(review)) return { errors: ["private catalog review must be an object"], reviewed: false };
  for (const key of Object.keys(review)) if (!FIELDS.has(key)) errors.push("private catalog review contains unsupported field " + key);
  if (review.formatVersion !== 1) errors.push("private catalog review has unsupported formatVersion");
  const expectedHash = catalogFingerprint(official);
  if (typeof review.catalogSha256 !== "string" || !/^[a-f0-9]{64}$/.test(review.catalogSha256) || review.catalogSha256 !== expectedHash) errors.push("private catalog review fingerprint does not match the public official catalog");
  if (review.sourceUrl !== official.sourceUrl) errors.push("private catalog review sourceUrl does not match the public catalog");
  if (review.verifiedAt !== official.verifiedAt || typeof review.verifiedAt !== "string" || !DATE.test(review.verifiedAt) || Number.isNaN(Date.parse(review.verifiedAt))) errors.push("private catalog review verifiedAt does not match the public catalog");
  if (typeof review.reviewedAt !== "string" || !TIMESTAMP.test(review.reviewedAt) || Number.isNaN(Date.parse(review.reviewedAt))) errors.push("private catalog review reviewedAt must be an ISO timestamp");
  if (typeof review.reviewer !== "string" || !review.reviewer.trim() || review.reviewer.length > 80 || PII.test(review.reviewer)) errors.push("private catalog review reviewer must be a non-identifying role label");
  if (!BASES.has(review.publicationBasis)) errors.push("private catalog review needs written permission or terms that allow metadata display");
  if (typeof review.publicationEvidenceRef !== "string" || !EVIDENCE_REF.test(review.publicationEvidenceRef)) errors.push("private catalog review needs a private evidence pointer, not the evidence itself");
  if (review.imageUse !== "none") errors.push("official catalog currently permits text metadata only; imageUse must be none");
  if (review.noPersonalData !== true) errors.push("private catalog review noPersonalData must be true");
  return { errors, reviewed: errors.length === 0 };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(path.join(root, "data", "market.json"), "utf8"));
  } catch (error) {
    console.error("FAIL cannot read market.json: " + error.message);
    process.exitCode = 1;
  }
  if (data && process.argv.includes("--fingerprint")) {
    console.log(catalogFingerprint(data.officialCatalog));
  } else if (data) {
    const result = validateCatalogReviewLedger(data, root);
    if (result.errors.length) {
      for (const error of result.errors) console.error("FAIL " + error);
      process.exitCode = 1;
    } else {
      console.log(result.reviewed ? "PASS verified official catalog has matching private publication review" : "PASS no verified official catalog is published");
    }
  }
}
