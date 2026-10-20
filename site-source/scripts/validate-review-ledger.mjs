import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BASES, METHODS, PII, evidenceRef, validDate, noLaterThan, methodBasisAllowed, publicRowSha256 } from "./review-policy.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TOP_FIELDS = new Set(["formatVersion", "snapshotSha256", "reviewedAt", "reviewer", "publicationBasis", "publicationEvidenceRef", "noPersonalData", "records"]);
const RECORD_FIELDS = new Set(["observationId", "sourceId", "publicRowSha256", "publicCardSha256", "captureMethod", "termsReviewedAt", "observedAt", "sourcePublishedAt", "settlementEvidenceRef", "settlementEvidenceType"]);

// Pending records go through exactly the same checks as records already on disk.
export function validateReviewLedger(data, siteRoot = root, { now = Date.now(), pendingRecords = [] } = {}) {
  if (!Number.isFinite(now)) throw new Error("review validation clock must be finite");
  const errors = [], warnings = [], items = [];
  const dir = path.join(siteRoot, ".ops-private", "review-ledger");
  try {
    for (const name of fs.readdirSync(dir).sort()) {
      try {
        const file = path.join(dir, name), stat = fs.lstatSync(file);
        if (!name.endsWith(".json") || !stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024) throw new Error("expected a regular JSON file under 256 KiB");
        items.push([name, JSON.parse(fs.readFileSync(file, "utf8"))]);
      } catch (error) { errors.push(name + ": invalid private review record (" + error.message + ")"); }
    }
  } catch (error) { if (error.code !== "ENOENT") errors.push("cannot read private review ledger: " + error.message); }
  if (!Array.isArray(pendingRecords)) throw new Error("pendingRecords must be an array");
  pendingRecords.forEach((item, index) => items.push(["pending review " + index, item]));
  const rows = new Map((Array.isArray(data?.observations) ? data.observations : []).map((row) => [row?.id, row]));
  const cards = new Map([...(data?.officialCatalog?.cards ?? []), ...(data?.candidates ?? [])].map((card) => [card?.id, card]));
  const covered = new Set(), seen = new Set();
  for (const [name, item] of items) {
    const before = errors.length;
    const fail = (message) => errors.push(name + ": " + message);
    if (!item || typeof item !== "object" || Array.isArray(item)) { fail("review record must be an object"); continue; }
    for (const key of Object.keys(item)) if (!TOP_FIELDS.has(key)) fail("unsupported private review field " + key);
    if (item.formatVersion !== 2) fail("review version 2 required; legacy ID-only approvals must be reviewed again");
    if (!/^[a-f0-9]{64}$/.test(item.snapshotSha256 ?? "")) fail("invalid snapshot SHA-256");
    if (!validDate(item.reviewedAt, now, true)) fail("reviewedAt must be a valid non-future ISO timestamp");
    if (typeof item.reviewer !== "string" || !item.reviewer.trim() || item.reviewer.length > 80 || PII.test(item.reviewer)) fail("reviewer must be a non-identifying role label");
    if (!BASES.has(item.publicationBasis)) fail("unknown publicationBasis");
    if (!evidenceRef(item.publicationEvidenceRef)) fail("publicationEvidenceRef must be a concrete private evidence pointer");
    if (item.noPersonalData !== true) fail("noPersonalData must be true");
    if (!Array.isArray(item.records) || item.records.length < 1 || item.records.length > 100) { fail("records must contain 1–100 observations"); continue; }
    const envelopeValid = before === errors.length;
    for (const record of item.records) {
      const start = errors.length;
      if (!record || typeof record !== "object" || Array.isArray(record)) { fail("record must be an object"); continue; }
      for (const key of Object.keys(record)) if (!RECORD_FIELDS.has(key)) fail("unsupported audit record field " + key);
      const id = record.observationId;
      if (typeof id !== "string" || !id.trim() || id.length > 150 || PII.test(id)) fail("invalid observationId");
      if (seen.has(id)) fail("duplicate observationId in private review ledger");
      seen.add(id);
      if (typeof record.sourceId !== "string" || !record.sourceId.trim() || record.sourceId.length > 40) fail("invalid sourceId");
      if (!METHODS.has(record.captureMethod) || !methodBasisAllowed(record.captureMethod, item.publicationBasis)) fail("captureMethod does not match the publication basis");
      for (const field of ["termsReviewedAt", "observedAt"]) {
        if (!validDate(record[field], now) || !noLaterThan(record[field], item.reviewedAt)) fail(field + " must be valid and no later than review");
      }
      if (record.sourcePublishedAt != null && (!validDate(record.sourcePublishedAt, now) || !noLaterThan(record.sourcePublishedAt, record.observedAt))) fail("sourcePublishedAt must be valid and no later than observation");
      if (!/^[a-f0-9]{64}$/.test(record.publicRowSha256 ?? "")) fail("public row SHA-256 is required");
      const row = rows.get(id);
      if (row) {
        if (row.sourceId !== record.sourceId || publicRowSha256(row) !== record.publicRowSha256) fail("approved public row changed (price, source, identity, URL, or state); review again");
        const cardHash = cards.has(row.cardId) ? publicRowSha256(cards.get(row.cardId)) : null;
        if (record.publicCardSha256 !== cardHash) fail("approved public card metadata changed; review the observation mapping again");
        if (!noLaterThan(row.checkedAt, item.reviewedAt) || !noLaterThan(record.observedAt, row.checkedAt)) fail("observation/check/review chronology is invalid");
        if (["sold", "sold_verified"].includes(row.kind)) {
          if (!["authorized_api", "seller_submitted"].includes(record.captureMethod) || !evidenceRef(record.settlementEvidenceRef) || !["completed_order", "payment_settlement"].includes(record.settlementEvidenceType)) fail("verified sale requires private completed-order or settlement evidence; listing badges are insufficient");
        } else if (record.settlementEvidenceRef != null || record.settlementEvidenceType != null) fail("settlement evidence is reserved for verified sales");
        if (row.kind === "official_retail" && (record.captureMethod !== "official_retail_page" || !["daewon", "kbomarket"].includes(row.sourceId))) fail("official retail prices require an official retail source");
        if (envelopeValid && errors.length === start) covered.add(id);
      }
    }
  }
  const missing = [...rows.keys()].filter((id) => !covered.has(id));
  if (missing.length) warnings.push(missing.length + " public observations lack a valid content-bound private review.");
  return { errors, warnings, coveredCount: covered.size, missingCount: missing.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(root, "data/market.json"), "utf8"));
    const result = validateReviewLedger(data);
    for (const warning of result.warnings) console.warn("WARN " + warning);
    for (const error of result.errors) console.error("FAIL " + error);
    if (result.errors.length || result.missingCount) process.exitCode = 1;
    else console.log("PASS private review ledger covers " + result.coveredCount + "/" + data.observations.length + " public observations");
  } catch (error) { console.error("FAIL " + error.message); process.exitCode = 1; }
}
