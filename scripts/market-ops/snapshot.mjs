import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SOURCE_BY_ID, OBSERVATION_KINDS, OBSERVATION_STATES, MATCH_LEVELS, ITEM_TYPES } from "./catalog.mjs";
import { CONTACT_INFO } from "./privacy.mjs";

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_RECORDS = 5000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
const REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:/#-]{0,199}$/;
const PLACEHOLDER_REF = /^(?:REPLACE|TODO|TBD|EXAMPLE|CHANGE[_-]?ME|TEST)(?:[_-]|$)/i;
const siteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../site-source");
const publicMarket = JSON.parse(readFileSync(path.join(siteRoot, "data", "market.json"), "utf8"));
const CARD_IDS = new Set([
  ...(publicMarket.officialCatalog?.cards ?? []),
  ...(publicMarket.candidates ?? []),
].map((card) => card.id));

function fail(message) {
  throw new Error(`snapshot rejected: ${message}`);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isoDate(value, label) {
  if (typeof value !== "string" || !ISO_DATE.test(value) || Number.isNaN(Date.parse(value))) fail(`${label} must be an ISO UTC timestamp`);
  return value;
}

function canonicalUrl(raw, source, label) {
  if (typeof raw !== "string" || raw.length > 2048) fail(`${label} must be a URL up to 2048 characters`);
  let url;
  try {
    url = new URL(raw);
  } catch {
    fail(`${label} is invalid`);
  }
  const allowed = new Set(source.hostnames);
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) fail(`${label} must use public HTTPS`);
  if (url.search || url.hash) fail(`${label} must be canonical without query or fragment`);
  if (!allowed.has(url.hostname.toLowerCase())) fail(`${label} hostname is not allowed for ${source.id}`);
  if (CONTACT_INFO.test(url.href)) fail(`${label} appears to contain personal contact information`);
  return url.toString();
}

function exactKeys(value, allowed, label) {
  if (!isPlainObject(value)) fail(`${label} must be an object`);
  if (Object.keys(value).some((key) => !allowed.has(key))) fail(`${label} contains unsupported fields`);
}

function validateReview(review, now) {
  const fields = new Set([
    "reviewerRole",
    "reviewedAt",
    "publicationBasis",
    "publicationEvidenceRef",
    "publicationAllowed",
    "termsReviewedAt",
    "historyStorageAllowed",
    "retentionDays",
    "noPersonalData",
  ]);
  exactKeys(review, fields, "review");
  if (!new Set(["market_reviewer", "reviewer", "reviewer_1", "reviewer_2", "operator", "editor", "publisher"]).has(review.reviewerRole)) fail("review.reviewerRole must be a non-identifying role label");
  const reviewedAt = isoDate(review.reviewedAt, "review.reviewedAt");
  const termsReviewedAt = isoDate(review.termsReviewedAt, "review.termsReviewedAt");
  if (Date.parse(reviewedAt) > now + 5 * 60_000) fail("review.reviewedAt cannot be more than 5 minutes in the future");
  const bases = new Set(["written_permission", "terms_allow_metadata_display", "partner_contract", "seller_consent"]);
  if (!bases.has(review.publicationBasis)) fail("review.publicationBasis is not an allowed basis");
  if (typeof review.publicationEvidenceRef !== "string" || !REFERENCE.test(review.publicationEvidenceRef) || CONTACT_INFO.test(review.publicationEvidenceRef) || PLACEHOLDER_REF.test(review.publicationEvidenceRef)) fail("review.publicationEvidenceRef must reference a real private permission record, not a placeholder");
  if (Object.hasOwn(review, "publicationAllowed") && typeof review.publicationAllowed !== "boolean") fail("review.publicationAllowed must be a boolean when supplied");
  if (review.historyStorageAllowed !== true) fail("explicit history storage permission is required");
  if (!Number.isInteger(review.retentionDays) || review.retentionDays < 1 || review.retentionDays > 3650) fail("review.retentionDays must be between 1 and 3650");
  if (review.noPersonalData !== true) fail("review.noPersonalData must be true");
  if (Date.parse(termsReviewedAt) > Date.parse(reviewedAt)) fail("termsReviewedAt cannot be later than reviewedAt");
  return {
    reviewerRole: review.reviewerRole,
    reviewedAt,
    publicationBasis: review.publicationBasis,
    publicationEvidenceRef: review.publicationEvidenceRef,
    ...(Object.hasOwn(review, "publicationAllowed") ? { publicationAllowed: review.publicationAllowed } : {}),
    termsReviewedAt,
    historyStorageAllowed: true,
    retentionDays: review.retentionDays,
    noPersonalData: true,
  };
}

function validateCoverage(coverage, captureMethod) {
  const fields = new Set(["scope", "level", "pagesVisited", "stopReason"]);
  exactKeys(coverage, fields, "coverage");
  if (typeof coverage.scope !== "string" || !coverage.scope.trim() || coverage.scope.trim().length > 300 || CONTACT_INFO.test(coverage.scope)) {
    fail("coverage.scope must briefly describe the checked query, category, board, or listing without personal data");
  }
  if (!new Set(["point_check", "partial_scan", "complete_scope"]).has(coverage.level)) fail("coverage.level is invalid");
  if (!Number.isInteger(coverage.pagesVisited) || coverage.pagesVisited < 0 || coverage.pagesVisited > 10_000) fail("coverage.pagesVisited must be an integer from 0 to 10000");
  if (!new Set(["single_listing", "operator_sample", "end_of_results", "page_limit", "time_budget", "access_denied", "unknown"]).has(coverage.stopReason)) fail("coverage.stopReason is invalid");
  if (coverage.level === "complete_scope" && captureMethod !== "authorized_api") fail("complete_scope requires an authorized API or full-catalog capture; manual UI checks must remain point_check or partial_scan");
  if (coverage.level === "complete_scope" && (coverage.stopReason !== "end_of_results" || coverage.pagesVisited < 1)) fail("complete_scope requires at least one page and an end_of_results stop reason");
  if (coverage.level !== "complete_scope" && coverage.stopReason === "end_of_results") fail("end_of_results requires complete_scope");
  return {
    scope: coverage.scope.trim(),
    level: coverage.level,
    pagesVisited: coverage.pagesVisited,
    stopReason: coverage.stopReason,
  };
}

function validateRecord(record, source, captureMethod, now) {
  const fields = new Set([
    "externalId",
    "url",
    "itemType",
    "cardId",
    "kind",
    "state",
    "matchLevel",
    "matchNote",
    "price",
    "shippingPrice",
    "observedAt",
    "settlementEvidenceRef",
  ]);
  exactKeys(record, fields, "observation");
  if (typeof record.externalId !== "string" || !ID.test(record.externalId) || CONTACT_INFO.test(record.externalId)) fail("observation.externalId has an invalid format");
  const url = canonicalUrl(record.url, source, "observation.url");
  if (source.id === "bunjang" && (!/^\d{1,30}$/.test(record.externalId) || new URL(url).pathname !== `/products/${record.externalId}`)) {
    fail("Bunjang observation.externalId must be the numeric product ID in its product URL");
  }
  if (!ITEM_TYPES.has(record.itemType)) fail("observation.itemType is invalid");
  if (record.itemType === "single_card") {
    if (typeof record.cardId !== "string" || !CARD_IDS.has(record.cardId)) fail("single-card observation.cardId must reference a card in the local catalog");
    if (!MATCH_LEVELS.has(record.matchLevel) || record.matchLevel === "generic") fail("single-card matchLevel must be candidate or exact");
  } else {
    if (record.cardId !== null) fail("sealed products and references must have cardId null");
    if (record.matchLevel !== "generic") fail("sealed products and references must use generic matchLevel");
  }
  if (!OBSERVATION_KINDS.has(record.kind)) fail("observation.kind is invalid");
  if (!OBSERVATION_STATES.has(record.state)) fail("observation.state is invalid");
  const statesByKind = {
    asking: ["active_asking", "unavailable_on_recheck", "unknown"],
    auction: ["active_at_check", "unavailable_on_recheck", "unknown"],
    auction_current_bid: ["active_at_check", "unavailable_on_recheck", "unknown"],
    auction_final_bid: ["unavailable_on_recheck", "unknown"],
    sold_badge_only: ["sold_badge_only", "sold_badge_sale_price_unverified"],
    sold_verified: ["sold_verified"],
    official_retail: ["active_at_check", "unavailable_on_recheck", "unknown"],
    reference: ["active_at_check", "unavailable_on_recheck", "unknown"],
  };
  if (!statesByKind[record.kind].includes(record.state)) fail(`observation.state ${record.state} is incompatible with kind ${record.kind}`);
  if (typeof record.matchNote !== "string" || !record.matchNote.trim() || record.matchNote.length > 500 || CONTACT_INFO.test(record.matchNote)) fail("observation.matchNote must contain brief non-personal matching evidence");
  if (!Number.isSafeInteger(record.price) || record.price <= 0) fail("observation.price must be a positive integer KRW");
  if (record.shippingPrice !== null && (!Number.isSafeInteger(record.shippingPrice) || record.shippingPrice < 0)) fail("observation.shippingPrice must be null or a non-negative integer KRW");
  const observedAt = isoDate(record.observedAt, "observation.observedAt");
  if (Date.parse(observedAt) > now + 5 * 60_000) fail("observation.observedAt cannot be more than 5 minutes in the future");
  if (captureMethod === "manual_public_page" && record.kind === "sold_verified") fail("manual public-page snapshots cannot assert verified settlement prices");
  if (record.kind === "sold_verified") {
    if (typeof record.settlementEvidenceRef !== "string" || !REFERENCE.test(record.settlementEvidenceRef) || CONTACT_INFO.test(record.settlementEvidenceRef) || PLACEHOLDER_REF.test(record.settlementEvidenceRef)) fail("verified sale requires a real private settlementEvidenceRef, not a placeholder");
  } else if (record.settlementEvidenceRef != null) {
    fail("settlementEvidenceRef is only valid for verified settlement observations");
  }
  return {
    externalId: record.externalId,
    url,
    itemType: record.itemType,
    cardId: record.cardId,
    kind: record.kind,
    state: record.state,
    matchLevel: record.matchLevel,
    matchNote: record.matchNote.trim(),
    price: record.price,
    shippingPrice: record.shippingPrice,
    observedAt,
    ...(record.kind === "sold_verified" ? { settlementEvidenceRef: record.settlementEvidenceRef } : {}),
  };
}

export function validateSnapshot(raw, now = Date.now()) {
  const legacyFields = new Set(["schemaVersion", "sourceId", "sourceUrl", "captureMethod", "review", "observations"]);
  const currentFields = new Set([...legacyFields, "coverage"]);
  if (raw?.schemaVersion === 1) exactKeys(raw, legacyFields, "snapshot");
  else if (raw?.schemaVersion === 2) exactKeys(raw, currentFields, "snapshot");
  else fail("schemaVersion must be 1 or 2");
  const source = SOURCE_BY_ID.get(raw.sourceId);
  if (!source) fail("sourceId is not in the six-platform catalog");
  const methods = new Set(["manual_public_page", "authorized_api", "seller_submitted"]);
  if (!methods.has(raw.captureMethod)) fail("captureMethod is invalid");
  if (raw.captureMethod === "manual_public_page" && !["written_permission", "terms_allow_metadata_display"].includes(raw.review?.publicationBasis)) fail("manual public-page capture requires written permission or terms that allow metadata display");
  if (raw.captureMethod === "authorized_api" && raw.review?.publicationBasis !== "partner_contract") fail("authorized API capture requires a partner contract");
  if (raw.captureMethod === "authorized_api" && raw.review?.publicationAllowed !== true) fail("authorized API capture requires explicit public display permission");
  if (raw.captureMethod === "seller_submitted" && raw.review?.publicationBasis !== "seller_consent") fail("seller-submitted capture requires seller consent");
  const sourceUrl = canonicalUrl(raw.sourceUrl, source, "sourceUrl");
  const review = validateReview(raw.review, now);
  const coverage = raw.schemaVersion === 1
    ? { scope: "Legacy snapshot: collection scope not recorded", level: "point_check", pagesVisited: 0, stopReason: "unknown", recorded: false }
    : { ...validateCoverage(raw.coverage, raw.captureMethod), recorded: true };
  if (!Array.isArray(raw.observations) || raw.observations.length > MAX_RECORDS) fail(`observations must be an array of at most ${MAX_RECORDS} records`);
  const seen = new Set();
  const observations = raw.observations.map((record) => {
    const normalized = validateRecord(record, source, raw.captureMethod, now);
    if (seen.has(normalized.externalId)) fail("duplicate externalId in snapshot");
    seen.add(normalized.externalId);
    return normalized;
  });
  const normalizedForHash = {
    schemaVersion: raw.schemaVersion,
    sourceId: source.id,
    sourceUrl,
    captureMethod: raw.captureMethod,
    review,
    coverage,
    observations: [...observations].sort((left, right) => left.externalId < right.externalId ? -1 : left.externalId > right.externalId ? 1 : 0),
  };
  const contentSha256 = createHash("sha256").update(JSON.stringify(normalizedForHash)).digest("hex");
  const inputSha256 = createHash("sha256").update(JSON.stringify(raw)).digest("hex");
  return { source, sourceUrl, captureMethod: raw.captureMethod, review, coverage, observations, inputSha256, contentSha256 };
}

export async function readReviewedSnapshot(filePath) {
  let fileStat;
  try {
    fileStat = await stat(filePath);
  } catch (error) {
    fail(`cannot access snapshot file (${/^[A-Z0-9_]+$/.test(error.code ?? "") ? error.code : "read_error"})`);
  }
  if (fileStat.size > MAX_BYTES) fail("file exceeds 10 MiB");
  let bytes;
  try {
    bytes = await readFile(filePath);
  } catch (error) {
    fail(`cannot read snapshot file (${/^[A-Z0-9_]+$/.test(error.code ?? "") ? error.code : "read_error"})`);
  }
  if (bytes.length > MAX_BYTES) fail("file exceeds 10 MiB");
  let input;
  try {
    input = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("file is not valid JSON");
  }
  let result;
  try {
    result = validateSnapshot(input);
  } catch (error) {
    if (SOURCE_BY_ID.has(input?.sourceId)) Object.defineProperty(error, "sourceId", { value: input.sourceId, configurable: true });
    throw error;
  }
  return {
    ...result,
    inputSha256: createHash("sha256").update(bytes).digest("hex"),
    fileBytes: bytes.length,
  };
}
