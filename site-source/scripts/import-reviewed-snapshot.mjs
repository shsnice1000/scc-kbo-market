import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { editorialTitleFor } from "./editorial-title.mjs";
import { validateMarket } from "./validate-market.mjs";
import { validateReviewLedger } from "./validate-review-ledger.mjs";
import { validateStaticDist } from "./validate-static-dist.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MAX_BYTES = 1024 * 1024;
const MAX_RECORDS = 100;
const bases = new Set(["partner_contract", "written_permission", "terms_allow_metadata_display", "official_retail_reference", "seller_consent"]);
const methods = new Set(["manual_public_page", "authorized_api", "seller_submitted", "official_retail_page"]);
const envelopeFields = new Set(["review", "observations"]);
const reviewFields = new Set(["reviewer", "reviewedAt", "publicationBasis", "publicationEvidenceRef", "noPersonalData"]);
const recordFields = new Set([
  "id", "cardId", "kind", "state", "matchLevel", "sourceId", "price", "shippingPrice",
  "checkedAt", "url", "matchNote", "postedTimeAtCheck", "captureMethod",
  "termsReviewedAt", "observedAt", "sourcePublishedAt",
]);
const contactPattern = /(?:[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|(?:\+?82[- .]?)?0?1[016789][-. ]?\d{3,4}[- .]?\d{4}|계좌번호|전화번호|휴대폰|연락처|오픈채팅|카카오톡\s*(?:ID|아이디))/i;
const DATE = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const EVIDENCE_REF = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,159}$/;

function isDate(value) {
  return typeof value === "string" && DATE.test(value) && !Number.isNaN(Date.parse(value));
}

function fail(message) {
  console.error("FAIL " + message);
  process.exit(1);
}

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const inputPath = args.find((arg) => !arg.startsWith("--"));
if (!inputPath) fail("usage: node scripts/import-reviewed-snapshot.mjs <reviewed-snapshot.json> [--dry-run]");

let input;
let inputSha256;
try {
  const file = path.resolve(inputPath);
  if (path.extname(file).toLowerCase() !== ".json") fail("JSON only; TSV and raw platform exports are not accepted");
  const stat = fs.statSync(file);
  if (stat.size > MAX_BYTES) fail("input exceeds 1 MiB; split into smaller reviewed JSON snapshots");
  const bytes = fs.readFileSync(file);
  input = JSON.parse(bytes.toString("utf8"));
  inputSha256 = createHash("sha256").update(bytes).digest("hex");
} catch (error) {
  fail("cannot read snapshot JSON: " + error.message);
}
if (!input || typeof input !== "object" || Array.isArray(input)) fail("snapshot root must be an object");
for (const key of Object.keys(input)) if (!envelopeFields.has(key)) fail("unsupported snapshot field " + key);
const review = input.review;
if (!review || typeof review !== "object" || Array.isArray(review)) fail("review object is required");
for (const key of Object.keys(review)) if (!reviewFields.has(key)) fail("unsupported review field " + key);
if (typeof review.reviewer !== "string" || !review.reviewer.trim() || review.reviewer.length > 80 || contactPattern.test(review.reviewer)) fail("review.reviewer must be a non-identifying role label");
if (!bases.has(review.publicationBasis)) fail("review.publicationBasis must record a confirmed publication basis");
if (typeof review.publicationEvidenceRef !== "string" || !EVIDENCE_REF.test(review.publicationEvidenceRef)) fail("review.publicationEvidenceRef must be a private evidence pointer, not the evidence itself");
if (typeof review.reviewedAt !== "string" || !TIMESTAMP.test(review.reviewedAt) || Number.isNaN(Date.parse(review.reviewedAt))) fail("review.reviewedAt must be an ISO timestamp");
if (review.noPersonalData !== true) fail("review.noPersonalData must be true after checking the export");
if (!Array.isArray(input.observations) || input.observations.length < 1 || input.observations.length > MAX_RECORDS) fail("observations must contain 1–100 records");

const sourcePath = path.join(root, "data", "market.json");
const distPath = path.join(root, "dist", "data", "market.json");
const staticCheck = await validateStaticDist(root);
if (staticCheck.errors.length) fail("static source/dist check failed: " + staticCheck.errors.slice(0, 10).join("; "));
const sourceBytes = fs.readFileSync(sourcePath);
if (sourceBytes.length > 5 * 1024 * 1024) fail("market.json exceeds 5 MiB safety limit");
if (!fs.existsSync(distPath) || !sourceBytes.equals(fs.readFileSync(distPath))) fail("source/dist mismatch; reconcile before import");
const market = JSON.parse(sourceBytes.toString("utf8"));
const ids = new Set(market.observations.map((row) => row.id));
const allCards = [...(market.officialCatalog?.cards || []), ...market.candidates];
const cardsById = new Map(allCards.map((card) => [card.id, card]));
const publicObservations = [];
const auditRows = [];

for (const [index, row] of input.observations.entries()) {
  if (!row || typeof row !== "object" || Array.isArray(row)) fail("observations[" + index + "] must be an object");
  for (const key of Object.keys(row)) if (!recordFields.has(key)) fail("observations[" + index + "] contains unsupported field " + key);
  if (typeof row.id !== "string" || !row.id.trim() || row.id.length > 150 || ids.has(row.id)) fail("observations[" + index + "] needs a new unique ID");
  if (!methods.has(row.captureMethod)) fail("observations[" + index + "].captureMethod is invalid");
  if (row.captureMethod === "authorized_api" && review.publicationBasis !== "partner_contract") fail("authorized API records require partner_contract basis");
  if (row.captureMethod === "seller_submitted" && review.publicationBasis !== "seller_consent") fail("seller records require seller_consent basis");
  if (row.captureMethod === "official_retail_page" && !["official_retail_reference", "written_permission", "terms_allow_metadata_display"].includes(review.publicationBasis)) fail("retail records need an official source publication basis");
  if (row.captureMethod === "manual_public_page" && !["written_permission", "terms_allow_metadata_display", "official_retail_reference"].includes(review.publicationBasis)) fail("manual capture needs a reviewed publication basis");
  if (!isDate(row.termsReviewedAt)) fail("observations[" + index + "].termsReviewedAt must be an ISO date or timestamp");
  if (row.observedAt != null && !isDate(row.observedAt)) fail("observations[" + index + "].observedAt must be an ISO date or timestamp");
  if (row.sourcePublishedAt != null && !isDate(row.sourcePublishedAt)) fail("observations[" + index + "].sourcePublishedAt must be an ISO date or timestamp");
  if (typeof row.matchNote === "string" && contactPattern.test(row.matchNote)) fail("observations[" + index + "] appears to contain personal contact information");
  let title;
  try { title = editorialTitleFor(row, cardsById); } catch (error) { fail("observations[" + index + "]: " + error.message); }
  ids.add(row.id);
  const publicRow = { ...row, title };
  for (const field of ["captureMethod", "termsReviewedAt", "observedAt", "sourcePublishedAt"]) delete publicRow[field];
  publicObservations.push(publicRow);
  auditRows.push({
    observationId: row.id,
    sourceId: row.sourceId,
    captureMethod: row.captureMethod,
    termsReviewedAt: row.termsReviewedAt,
    ...(row.observedAt != null ? { observedAt: row.observedAt } : {}),
    ...(row.sourcePublishedAt != null ? { sourcePublishedAt: row.sourcePublishedAt } : {}),
  });
}
market.observations.push(...publicObservations);
const result = validateMarket(market, "reviewed snapshot result");
for (const warning of result.warnings) console.warn("WARN " + warning);
if (result.errors.length) {
  for (const error of result.errors) console.error("FAIL " + error);
  process.exit(1);
}
const output = JSON.stringify(market, null, 2) + "\n";
if (Buffer.byteLength(output) > 5 * 1024 * 1024) fail("result exceeds 5 MiB safety limit");
if (dryRun) {
  console.log("PASS dry run: " + input.observations.length + " reviewed observations accepted; no files changed");
  process.exit(0);
}

const suffix = ".tmp-" + process.pid + "-" + randomUUID();
const sourceTemp = sourcePath + suffix;
const distTemp = distPath + suffix;
const oldDist = fs.readFileSync(distPath);
fs.writeFileSync(sourceTemp, output, { flag: "wx" });
fs.writeFileSync(distTemp, output, { flag: "wx" });
try {
  fs.renameSync(sourceTemp, sourcePath);
  fs.renameSync(distTemp, distPath);
} catch (error) {
  try { fs.writeFileSync(sourcePath, sourceBytes); } catch {}
  try { fs.writeFileSync(distPath, oldDist); } catch {}
  for (const file of [sourceTemp, distTemp]) {
    try { fs.rmSync(file, { force: true }); } catch {}
  }
  fail("snapshot sync failed; previous files restored where possible: " + error.message);
}
const build = spawnSync(process.execPath, [path.join(root, "scripts", "build-worker.mjs")], { cwd: root, encoding: "utf8", stdio: "pipe" });
if (build.status !== 0) {
  try { fs.writeFileSync(sourcePath, sourceBytes); } catch {}
  try { fs.writeFileSync(distPath, oldDist); } catch {}
  spawnSync(process.execPath, [path.join(root, "scripts", "build-worker.mjs")], { cwd: root, stdio: "ignore" });
  fail("Worker build failed; previous market data was restored. " + String(build.stderr ?? "").slice(0, 1000));
}
const postCheck = await validateStaticDist(root);
if (postCheck.errors.length) {
  try { fs.writeFileSync(sourcePath, sourceBytes); } catch {}
  try { fs.writeFileSync(distPath, oldDist); } catch {}
  spawnSync(process.execPath, [path.join(root, "scripts", "build-worker.mjs")], { cwd: root, stdio: "ignore" });
  for (const error of postCheck.errors) console.error("FAIL " + error);
  fail("post-import static validation failed; previous market data restored where possible");
}
const reviewDir = path.join(root, ".ops-private", "review-ledger");
const reviewStamp = review.reviewedAt.replace(/[^0-9A-Za-z]/g, "-");
const reviewName = "snapshot-" + reviewStamp + "-" + inputSha256.slice(0, 16) + ".json";
const reviewPath = path.join(reviewDir, reviewName);
const reviewTemp = reviewPath + ".tmp-" + process.pid + "-" + randomUUID();
const reviewRecord = {
  formatVersion: 1,
  snapshotSha256: inputSha256,
  reviewedAt: review.reviewedAt,
  reviewer: review.reviewer,
  publicationBasis: review.publicationBasis,
  publicationEvidenceRef: review.publicationEvidenceRef,
  noPersonalData: true,
  records: auditRows,
};
try {
  if (fs.existsSync(reviewPath)) throw new Error("private review record already exists");
  fs.mkdirSync(reviewDir, { recursive: true });
  fs.writeFileSync(reviewTemp, JSON.stringify(reviewRecord, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
  fs.renameSync(reviewTemp, reviewPath);
} catch (error) {
  try { fs.rmSync(reviewTemp, { force: true }); } catch {}
  try { fs.writeFileSync(sourcePath, sourceBytes); } catch {}
  try { fs.writeFileSync(distPath, oldDist); } catch {}
  spawnSync(process.execPath, [path.join(root, "scripts", "build-worker.mjs")], { cwd: root, stdio: "ignore" });
  fail("private review ledger write failed; previous public data restored where possible. " + error.message);
}
const ledgerCheck = validateReviewLedger(market, root);
if (ledgerCheck.errors.length) {
  for (const error of ledgerCheck.errors) console.error("FAIL " + error);
  try { fs.rmSync(reviewPath, { force: true }); } catch {}
  try { fs.writeFileSync(sourcePath, sourceBytes); } catch {}
  try { fs.writeFileSync(distPath, oldDist); } catch {}
  spawnSync(process.execPath, [path.join(root, "scripts", "build-worker.mjs")], { cwd: root, stdio: "ignore" });
  fail("private review ledger validation failed; previous public data restored where possible");
}
console.log("PASS imported " + input.observations.length + " observations; all deployable source/dist files synchronized");
