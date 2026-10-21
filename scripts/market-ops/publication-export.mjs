import { createHash, randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, readFile, realpath, rm, unlink } from "node:fs/promises";
import path from "node:path";
import { normalizeIdentityV2, reviewIdentityCaseV2 } from "./identity.mjs";
import { normalizeQueueInput } from "./review-queue.mjs";
import { prepareReviewedSnapshot } from "../../site-source/scripts/reviewed-snapshot.mjs";

const REVIEWER_ROLES = new Set(["market_reviewer", "reviewer", "reviewer_1", "reviewer_2", "operator", "editor", "publisher"]);
const BASES = new Set(["partner_contract", "written_permission", "terms_allow_metadata_display", "official_retail_reference", "seller_consent"]);
const SETTLEMENT_TYPES = new Set(["completed_order", "payment_settlement"]);
const HASH = /^[a-f0-9]{64}$/;
const COMPARISON_GROUP_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PRIVATE_REF = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,159}$/;
const CONTACT = /(?:[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|(?:\+?82[- .]?)?0?1[016789][-. ]?\d{3,4}[- .]?\d{4})/i;
const hash = (value) => createHash("sha256").update(value).digest("hex");

function fail(message) { throw new Error("publication draft rejected: " + message); }
function isObject(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function exactKeys(value, allowed, label) {
  if (!isObject(value)) fail(label + " must be an object");
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail(label + " contains unsupported field " + key);
}
function evidenceRef(value, label) {
  if (typeof value !== "string" || !PRIVATE_REF.test(value) || /(?:^|[._:/-])(?:unknown|none|null|tbd|todo|pending|example|placeholder|replace)(?:$|[._:/-])/i.test(value) || CONTACT.test(value)) fail(label + " must be a concrete non-identifying private evidence reference");
}
function timestamp(value, label, now) {
  timestampValue(value, label);
  if (Date.parse(value) > now) fail(label + " must be a valid non-future UTC timestamp");
  return value;
}
function timestampValue(value, label) {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value) || !Number.isFinite(Date.parse(value))) fail(label + " must be a valid UTC timestamp");
  const canonical = new Date(value).toISOString();
  if (value !== canonical && value !== canonical.replace(/\.000Z$/, "Z")) fail(label + " must be a calendar-valid UTC timestamp");
  return value;
}
function approvedQueueCase(queue, caseId, row, now) {
  const entry = queue?.entries?.find((item) => item.caseId === caseId);
  if (!entry) fail("approved identity case was not found: " + caseId);
  const normalized = normalizeQueueInput(entry.input);
  if (hash(JSON.stringify(normalized)) !== entry.contentSha256 || entry.caseId !== normalized.matchCase.caseId) fail("identity case content hash is stale: " + caseId);
  const proposal = reviewIdentityCaseV2(normalized.matchCase);
  if (entry.status !== "approved" || entry.review?.decision !== "approve" || entry.review?.contentSha256 !== entry.contentSha256 || entry.review?.publicPublicationAllowed !== false || proposal.decision !== "exact_identity" || proposal.identityComparable !== true) fail("identity case lacks a current exact-copy approval: " + caseId);
  if (typeof entry.review.comparisonGroupId !== "string" || !COMPARISON_GROUP_ID.test(entry.review.comparisonGroupId)) fail("identity approval needs a private random comparison-group UUID; re-approve the case");
  timestamp(entry.review.reviewedAt, "identity review date", now);
  evidenceRef(entry.review.evidenceRef, "identity review evidence");
  if (normalized.inventoryOrigin !== "independent_market") fail("owner-held or unknown inventory cannot enter public export");
  if (normalized.sourceId !== row.sourceId || normalized.externalId !== row.externalId || normalized.url !== row.url) fail("approved identity case does not identify the selected source listing");
  if (row.matchLevel !== "exact") fail("only exact single-card observations may enter this export bridge");
  return { input: normalized, review: entry.review, proposal };
}

function approvedSourceReview(db, row, selectionReview, now) {
  const reviews = db.reviewLedger?.filter((item) => item.id === row.reviewLedgerId) ?? [];
  if (reviews.length !== 1 || reviews[0].sourceId !== row.sourceId) fail("observation has no unique matching source permission review");
  const ledger = reviews[0];
  timestamp(ledger.reviewedAt, "source review date", now);
  timestamp(ledger.termsReviewedAt, "terms review date", now);
  timestampValue(ledger.expiresAt, "source review expiry");
  timestamp(row.lastSeenAt, "observation date", now);
  timestampValue(row.expiresAt, "observation expiry");
  if (Date.parse(ledger.expiresAt) <= now || Date.parse(row.expiresAt) <= now) fail("observation or its permission review has expired");
  if (ledger.publicationAllowed !== true || ledger.historyStorageAllowed !== true) fail("source review did not explicitly allow public display and history storage");
  if (!BASES.has(ledger.publicationBasis)) fail("source review has an unsupported publication basis");
  evidenceRef(ledger.publicationEvidenceRef, "source publication evidence");
  if (ledger.publicationBasis !== selectionReview.publicationBasis || ledger.publicationEvidenceRef !== selectionReview.publicationEvidenceRef) fail("selection review basis/evidence must match every selected source review");
  if (Date.parse(ledger.reviewedAt) > Date.parse(selectionReview.reviewedAt)) fail("final publication review must be later than the source permission review");
  if (Date.parse(ledger.termsReviewedAt) > Date.parse(ledger.reviewedAt)) fail("source terms were reviewed after the source permission review");
  return ledger;
}

function publicRecord(row, selected, identity) {
  const result = {
    id: "pub-" + hash(JSON.stringify([row.listingKey, row.reviewLedgerId, row.lastSeenAt, row.kind, row.price, row.shippingPrice, row.cardId])).slice(0, 32),
    cardId: selected.cardId,
    kind: row.kind,
    state: row.state,
    matchLevel: "exact",
    sourceId: row.sourceId,
    price: row.price,
    shippingPrice: row.shippingPrice,
    checkedAt: row.lastSeenAt,
    url: row.url,
    matchNote: "Single-card identity and physical-copy comparison reviewed against private evidence.",
    captureMethod: identity.sourceReview.captureMethod,
    termsReviewedAt: identity.sourceReview.termsReviewedAt,
    observedAt: row.lastSeenAt,
    inventoryOrigin: "independent_market",
    identityReview: identity.caseInput.matchCase,
    identityEvidenceRef: identity.identityEvidenceRef,
    comparisonGroupId: identity.review.comparisonGroupId ?? null,
  };
  if (row.kind === "sold_verified") {
    if (!row.settlementEvidenceRef) fail("verified sales require a private settlement-evidence reference");
    if (!SETTLEMENT_TYPES.has(selected.settlementEvidenceType)) fail("verified sales need an explicitly reviewed completed-order or payment-settlement evidence type");
    result.settlementEvidenceRef = row.settlementEvidenceRef;
    result.settlementEvidenceType = selected.settlementEvidenceType;
  } else if (selected.settlementEvidenceType != null) fail("settlement evidence type cannot be attached to a non-sale observation");
  if (row.kind === "official_retail" && (identity.sourceReview.captureMethod !== "official_retail_page" || row.sourceId !== "daewon")) fail("official retail export requires the official retail page capture route");
  return result;
}

export function buildPublicationDraft({ db, queue, selection, market, siteRoot, now = Date.now() }) {
  if (!Number.isFinite(now)) throw new Error("publication export clock must be finite");
  exactKeys(selection, new Set(["schemaVersion", "review", "observations"]), "selection");
  if (selection.schemaVersion !== 1) fail("selection schemaVersion must be 1");
  exactKeys(selection.review, new Set(["reviewerRole", "reviewedAt", "publicationAllowed", "publicationBasis", "publicationEvidenceRef", "noPersonalData"]), "selection review");
  if (!REVIEWER_ROLES.has(selection.review.reviewerRole)) fail("reviewerRole must be a non-identifying reviewer role");
  const reviewedAt = timestamp(selection.review.reviewedAt, "final publication review date", now);
  if (selection.review.publicationAllowed !== true || selection.review.noPersonalData !== true) fail("final reviewer must explicitly approve public display and confirm no personal data");
  if (!BASES.has(selection.review.publicationBasis)) fail("publicationBasis is invalid");
  evidenceRef(selection.review.publicationEvidenceRef, "publication evidence");
  if (!Array.isArray(selection.observations) || selection.observations.length < 1 || selection.observations.length > 100) fail("selection must contain 1 to 100 observations");
  if (!db || !Array.isArray(db.observations) || !Array.isArray(db.reviewLedger)) fail("operations database is invalid");
  if (!queue || queue.schemaVersion !== 1 || !Array.isArray(queue.entries)) fail("identity review queue is invalid");
  const seen = new Set();
  const cards = new Map([...(market?.officialCatalog?.cards ?? []), ...(market?.candidates ?? [])].map((card) => [card.id, card]));
  const records = selection.observations.map((selected) => {
    exactKeys(selected, new Set(["listingKey", "matchCaseId", "cardId", "settlementEvidenceType"]), "selected observation");
    if (typeof selected.listingKey !== "string" || typeof selected.matchCaseId !== "string" || typeof selected.cardId !== "string") fail("selected observation needs listingKey, matchCaseId, and cardId");
    if (seen.has(selected.listingKey)) fail("duplicate listingKey in selection");
    seen.add(selected.listingKey);
    const matches = db.observations.filter((item) => item.listingKey === selected.listingKey);
    if (matches.length !== 1) fail("selected listing must have exactly one current database observation");
    const row = matches[0];
    if (row.listingKey !== `${row.sourceId}:${row.externalId}` || row.cardId !== selected.cardId || !cards.has(selected.cardId)) fail("selected listing/card mapping was not found in the current database and public catalog");
    const suppression = db.listingSuppressions?.[row.listingKey];
    if (suppression && typeof suppression.active !== "boolean") fail("listing suppression status is invalid");
    if (suppression?.active === true) fail("retracted or permission-withdrawn listings are suppressed");
    if (suppression?.active === false) {
      timestamp(suppression.restoredAt, "listing restoration date", now);
      if (Date.parse(row.lastSeenAt) <= Date.parse(suppression.restoredAt)) fail("restored listings require a newer observation after restoration");
    }
    const identityCase = approvedQueueCase(queue, selected.matchCaseId, row, now);
    const sourceReview = approvedSourceReview(db, row, selection.review, now);
    if (Date.parse(identityCase.review.reviewedAt) > Date.parse(reviewedAt)) fail("final publication review must follow identity review");
    if (row.kind === "sold_verified" && (!row.settlementEvidenceRef || !SETTLEMENT_TYPES.has(selected.settlementEvidenceType))) fail("verified sale requires reviewed settlement proof; a sold badge is not a settlement");
    return publicRecord(row, selected, { caseInput: identityCase.input, review: identityCase.review, identityEvidenceRef: identityCase.review.evidenceRef, proposal: identityCase.proposal, sourceReview });
  });
  const input = {
    review: {
      reviewer: selection.review.reviewerRole,
      reviewedAt,
      publicationBasis: selection.review.publicationBasis,
      publicationEvidenceRef: selection.review.publicationEvidenceRef,
      noPersonalData: true,
    },
    observations: records,
  };
  const prepared = prepareReviewedSnapshot(input, market, { siteRoot, now });
  const bytes = JSON.stringify(input, null, 2) + "\n";
  return { input, prepared, sha256: hash(bytes), observationCount: records.length };
}

async function checkedDirectory(directory, create = false) {
  if (create) {
    const existing = await lstat(directory).catch((error) => error.code === "ENOENT" ? null : Promise.reject(error));
    if (!existing) await mkdir(directory);
  }
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("private publication export storage must use real directories");
  return realpath(directory);
}

export async function readPublicationSelection(workspaceRoot, argument) {
  const workspace = await realpath(workspaceRoot);
  const privateRoot = await checkedDirectory(path.join(workspace, ".ops-private"));
  const exportRoot = await checkedDirectory(path.join(privateRoot, "publication-export"));
  const inputPath = path.resolve(workspace, argument);
  const relative = path.relative(exportRoot, inputPath);
  if (!relative || relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) throw new Error("selection file must be inside .ops-private/publication-export");
  const info = await lstat(inputPath);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) throw new Error("selection must be a regular non-symlink JSON file under 1 MiB");
  const realFile = await realpath(inputPath);
  const realRelative = path.relative(exportRoot, realFile);
  if (!realRelative || realRelative === ".." || realRelative.startsWith(".." + path.sep) || path.isAbsolute(realRelative)) throw new Error("selection file must resolve inside private publication export storage");
  return JSON.parse(await readFile(realFile, "utf8"));
}

export async function createPublicationSelectionTemplate(workspaceRoot) {
  const workspace = await realpath(workspaceRoot);
  const privateRoot = await checkedDirectory(path.join(workspace, ".ops-private"));
  const exportRoot = await checkedDirectory(path.join(privateRoot, "publication-export"), true);
  const target = path.join(exportRoot, "selection-template.json");
  const template = {
    schemaVersion: 1,
    review: {
      reviewerRole: "operator",
      reviewedAt: new Date().toISOString(),
      publicationAllowed: false,
      publicationBasis: "written_permission",
      publicationEvidenceRef: "REPLACE_WITH_REAL_PRIVATE_PERMISSION_REF",
      noPersonalData: false,
    },
    observations: [],
  };
  const handle = await open(target, "wx", 0o600).catch((error) => {
    if (error.code === "EEXIST") return null;
    throw error;
  });
  if (!handle) return { created: false, path: path.relative(workspace, target) };
  try { await handle.writeFile(JSON.stringify(template, null, 2) + "\n"); await handle.sync(); }
  finally { await handle.close(); }
  return { created: true, path: path.relative(workspace, target) };
}

export async function writePublicationDraft(workspaceRoot, draft, { dryRun = false } = {}) {
  const workspace = await realpath(workspaceRoot);
  const privateRoot = await checkedDirectory(path.join(workspace, ".ops-private"));
  const exportRoot = await checkedDirectory(path.join(privateRoot, "publication-export"));
  if (!draft || !isObject(draft.input) || typeof draft.sha256 !== "string" || !HASH.test(draft.sha256) || hash(JSON.stringify(draft.input, null, 2) + "\n") !== draft.sha256) throw new Error("publication draft content hash is invalid");
  const bytes = Buffer.from(JSON.stringify(draft.input, null, 2) + "\n", "utf8");
  if (bytes.length > 1024 * 1024) throw new Error("publication draft exceeds 1 MiB");
  const draftsPath = path.join(exportRoot, "drafts");
  if (dryRun) return { dryRun: true, path: path.relative(workspace, path.join(draftsPath, draft.sha256 + ".json")), observationCount: draft.observationCount, sha256: draft.sha256 };
  const draftsDir = await checkedDirectory(draftsPath, true);
  const target = path.join(draftsDir, draft.sha256 + ".json");
  const temporary = path.join(draftsDir, ".draft-" + process.pid + "-" + randomUUID() + ".tmp");
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close(); handle = null;
    await link(temporary, target);
    await unlink(temporary);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await rm(temporary, { force: true });
    if (error.code === "EEXIST") {
      const prior = await readFile(target);
      if (prior.equals(bytes)) return { dryRun: false, alreadyExists: true, path: path.relative(workspace, target), observationCount: draft.observationCount, sha256: draft.sha256 };
    }
    throw error;
  }
  return { dryRun: false, alreadyExists: false, path: path.relative(workspace, target), observationCount: draft.observationCount, sha256: draft.sha256 };
}
