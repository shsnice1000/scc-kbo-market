import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LEDGER_DIR = path.join(".ops-private", "review-ledger");
const MAX_LEDGER_BYTES = 256 * 1024;
const BASES = new Set(["partner_contract", "written_permission", "terms_allow_metadata_display", "official_retail_reference", "seller_consent"]);
const METHODS = new Set(["manual_public_page", "authorized_api", "seller_submitted", "official_retail_page"]);
const DATE = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const PII = /(?:[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|(?:\+?82[- .]?)?0?1[016789][-. ]?\d{3,4}[- .]?\d{4}|계좌번호|전화번호|휴대폰|연락처|오픈채팅|카카오톡\s*(?:ID|아이디))/i;
const EVIDENCE_REF = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,159}$/;
const TOP_FIELDS = new Set(["formatVersion", "snapshotSha256", "reviewedAt", "reviewer", "publicationBasis", "publicationEvidenceRef", "noPersonalData", "records"]);
const RECORD_FIELDS = new Set(["observationId", "sourceId", "captureMethod", "termsReviewedAt", "observedAt", "sourcePublishedAt"]);

function isDate(value) {
  return typeof value === "string" && DATE.test(value) && !Number.isNaN(Date.parse(value));
}

export function validateReviewLedger(data, siteRoot = root) {
  const errors = [];
  const warnings = [];
  const dir = path.join(siteRoot, LEDGER_DIR);
  let filenames;
  try {
    filenames = fs.readdirSync(dir);
  } catch {
    const count = Array.isArray(data?.observations) ? data.observations.length : 0;
    if (count > 0) warnings.push("Private review ledger is missing; provenance coverage is unverified for " + count + " public observations.");
    return { errors, warnings, coveredCount: 0, missingCount: count };
  }

  const covered = new Set();
  const jsonFiles = filenames.filter((name) => name.endsWith(".json")).sort();
  for (const name of filenames) if (!name.endsWith(".json")) errors.push("private review ledger contains an unexpected file: " + name);

  for (const name of jsonFiles) {
    const file = path.join(dir, name);
    let item;
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_LEDGER_BYTES) throw new Error("expected a regular JSON file under 256 KiB");
      item = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (error) {
      errors.push(name + ": invalid private review record (" + error.message + ")");
      continue;
    }
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      errors.push(name + ": review record must be an object");
      continue;
    }
    for (const key of Object.keys(item)) if (!TOP_FIELDS.has(key)) errors.push(name + ": unsupported private review field " + key);
    if (item.formatVersion !== 1) errors.push(name + ": unsupported review record version");
    if (typeof item.snapshotSha256 !== "string" || !/^[a-f0-9]{64}$/.test(item.snapshotSha256)) errors.push(name + ": invalid snapshot SHA-256");
    if (typeof item.reviewedAt !== "string" || !TIMESTAMP.test(item.reviewedAt) || Number.isNaN(Date.parse(item.reviewedAt))) errors.push(name + ": reviewedAt must be an ISO timestamp");
    if (typeof item.reviewer !== "string" || !item.reviewer.trim() || item.reviewer.length > 80 || PII.test(item.reviewer)) errors.push(name + ": reviewer must be a non-identifying role label");
    if (!BASES.has(item.publicationBasis)) errors.push(name + ": unknown publicationBasis");
    if (typeof item.publicationEvidenceRef !== "string" || !EVIDENCE_REF.test(item.publicationEvidenceRef)) errors.push(name + ": publicationEvidenceRef must be a private evidence pointer, not the evidence itself");
    if (item.noPersonalData !== true) errors.push(name + ": noPersonalData must be true");
    if (!Array.isArray(item.records) || item.records.length < 1 || item.records.length > 100) {
      errors.push(name + ": records must contain 1–100 observations");
      continue;
    }
    for (const record of item.records) {
      if (!record || typeof record !== "object" || Array.isArray(record)) {
        errors.push(name + ": record must be an object");
        continue;
      }
      for (const key of Object.keys(record)) if (!RECORD_FIELDS.has(key)) errors.push(name + ": unsupported audit record field " + key);
      if (typeof record.observationId !== "string" || !record.observationId.trim() || record.observationId.length > 150) errors.push(name + ": invalid observationId");
      else if (covered.has(record.observationId)) errors.push(name + ": duplicate observationId in private review ledger");
      else covered.add(record.observationId);
      if (typeof record.sourceId !== "string" || record.sourceId.length > 40) errors.push(name + ": invalid sourceId");
      if (!METHODS.has(record.captureMethod)) errors.push(name + ": unknown captureMethod");
      if (!isDate(record.termsReviewedAt)) errors.push(name + ": invalid termsReviewedAt");
      for (const field of ["observedAt", "sourcePublishedAt"]) if (record[field] != null && !isDate(record[field])) errors.push(name + ": invalid " + field);
    }
  }

  const ids = new Set((data?.observations ?? []).map((row) => row?.id).filter((id) => typeof id === "string"));
  const missing = [...ids].filter((id) => !covered.has(id));
  if (missing.length) warnings.push(missing.length + " public observations lack a private review-ledger record.");
  return { errors, warnings, coveredCount: [...covered].filter((id) => ids.has(id)).length, missingCount: missing.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(path.join(root, "data", "market.json"), "utf8"));
  } catch (error) {
    console.error("FAIL cannot read market.json: " + error.message);
    process.exitCode = 1;
    data = null;
  }
  if (data) {
    const result = validateReviewLedger(data);
    for (const warning of result.warnings) console.warn("WARN " + warning);
    for (const error of result.errors) console.error("FAIL " + error);
    if (result.errors.length || result.missingCount > 0) process.exitCode = 1;
    else console.log("PASS private review ledger covers " + result.coveredCount + "/" + data.observations.length + " public observations");
  }
}
