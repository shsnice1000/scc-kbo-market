import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { editorialTitleFor } from "./editorial-title.mjs";
import { validateReviewLedger } from "./validate-review-ledger.mjs";
import { validateCatalogReviewLedger } from "./validate-catalog-ledger.mjs";
import { validatePublicCardIdentity } from "./publication-identity.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MAX_BYTES = 5 * 1024 * 1024;
const HOSTS = {
  bunjang: new Set(["m.bunjang.co.kr", "bunjang.co.kr", "www.bunjang.co.kr"]),
  break: new Set(["break.co.kr", "www.break.co.kr", "app.break.market"]),
  wyyyes: new Set(["wyyyes.com", "www.wyyyes.com"]),
  community: new Set(["cafe.naver.com"]),
  joongna: new Set(["web.joongna.com"]),
  kream: new Set(["kream.co.kr", "www.kream.co.kr"]),
  daewon: new Set(["daewonshop.com", "www.daewonshop.com"]),
  kbomarket: new Set(["kbomarket.com", "www.kbomarket.com"]),
};
const REQUIRED_MARKET_SOURCES = ["bunjang", "break", "wyyyes", "community", "kream", "daewon"];
const SOURCE_COVERAGE_STATES = new Set(["not_checked", "access_blocked", "partial_scan", "complete_scope_scan"]);
const OBS_FIELDS = new Set([
  "id", "cardId", "kind", "state", "matchLevel", "sourceId", "title", "price", "shippingPrice",
  "checkedAt", "url", "matchNote", "postedTimeAtCheck",
  "comparisonKey",
]);
const STRING_LIMITS = {
  id: 150, cardId: 120, kind: 40, state: 60, matchLevel: 20, sourceId: 40,
  title: 300, url: 2048, matchNote: 2000, postedTimeAtCheck: 80,
};
const DATE = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?$/;
const PII = /(?:[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|(?:\+?82[- .]?)?0?1[016789][-. ]?\d{3,4}[- .]?\d{4}|계좌번호|전화번호|휴대폰|연락처|오픈채팅|카카오톡\s*(?:ID|아이디))/i;
const ROOT_FIELDS = new Set(["edition", "status", "candidates", "sources", "observations", "officialCatalog"]);
const CARD_FIELDS = new Set(["id", "player", "team", "type", "cardNumber", "variant", "serial", "printingIdentity"]);
const CANDIDATE_FIELDS = new Set([...CARD_FIELDS, "identityStatus", "observations", "photoSources"]);

function publicDate(value, now) {
  if (typeof value !== "string" || !DATE.test(value)) return false;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return false;
  const calendar = value.slice(0, 10);
  const [year, month, day] = calendar.split("-").map(Number);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(0, 0, 0, 0);
  if (date.toISOString().slice(0, 10) !== calendar) return false;
  if (value.length === 10) return calendar <= new Date(now + 9 * 3_600_000).toISOString().slice(0, 10);
  if (!/T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d/.test(value)) return false;
  return timestamp <= now + 5 * 60_000;
}

function validateUrl(raw, sourceId, label, fail) {
  try {
    if (typeof raw !== "string" || raw.length > 2048) throw new Error("invalid URL length");
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) throw new Error("public HTTPS URL required");
    if (url.search || url.hash) throw new Error("use a canonical URL without query or fragment");
    if (!HOSTS[sourceId]?.has(url.hostname.toLowerCase())) throw new Error("host is not allowlisted for " + sourceId);
  } catch (error) {
    fail(label + ": " + error.message);
  }
}

export function validateMarket(data, label = "market.json", { now = Date.now(), siteRoot = root, pendingRecords = [] } = {}) {
  const errors = [];
  const warningSet = new Set();
  const fail = (message) => errors.push(label + ": " + message);
  if (!data || typeof data !== "object" || Array.isArray(data)) return { errors: [label + ": root must be an object"], warnings: [] };
  if (!Number.isFinite(now)) throw new Error("market validation clock must be finite");
  for (const key of Object.keys(data)) if (!ROOT_FIELDS.has(key)) fail("root contains unsupported public field " + key);
  for (const key of ["edition", "status"]) if (typeof data[key] !== "string" || !data[key].trim() || data[key].length > 160 || PII.test(data[key])) fail(key + " must be a short public label without personal contact information");
  for (const key of ["candidates", "sources", "observations"]) if (!Array.isArray(data[key])) fail(key + " must be an array");
  const official = data.officialCatalog;
  if (!official || typeof official !== "object" || Array.isArray(official)) fail("officialCatalog must be an object");
  else {
    for (const key of Object.keys(official)) if (!new Set(["status", "sourceUrl", "verifiedAt", "cards"]).has(key)) fail("officialCatalog contains unsupported field " + key);
    if (!Array.isArray(official.cards)) fail("officialCatalog.cards must be an array");
    if (!["awaiting_official_checklist", "verified"].includes(official.status)) fail("officialCatalog.status is invalid");
    if (Array.isArray(official.cards) && official.status === "awaiting_official_checklist" && (official.cards.length || official.sourceUrl !== null || official.verifiedAt !== null)) fail("unverified official catalog must stay empty");
    if (Array.isArray(official.cards) && official.status === "verified") {
      if (!official.cards.length) fail("verified official catalog needs cards");
      if (typeof official.sourceUrl !== "string" || official.sourceUrl.length > 2048) fail("verified official catalog needs a source URL");
      else { try { const url = new URL(official.sourceUrl); if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443") || url.search || url.hash) fail("official catalog source must be a canonical public HTTPS URL"); } catch { fail("official catalog source URL is invalid"); } }
      if (!publicDate(official.verifiedAt, now)) fail("verified official catalog needs a valid non-future verifiedAt");
    }
  }
  if (errors.length) return { errors, warnings: [] };
  if (data.observations.length > 100000) fail("observations exceeds 100,000-record limit");

  const uniqueIds = (rows, section) => {
    const ids = new Set();
    for (const row of rows) {
      if (!row || typeof row !== "object" || Array.isArray(row) || typeof row.id !== "string" || !row.id.trim() || row.id.length > 150 || PII.test(row.id)) fail(section + " contains an invalid id");
      else if (ids.has(row.id)) fail(section + " contains a duplicate id");
      else ids.add(row.id);
    }
    return ids;
  };
  const candidateIds = uniqueIds(data.candidates, "candidates");
  const officialCardIds = uniqueIds(data.officialCatalog.cards, "officialCatalog.cards");
  for (const id of candidateIds) if (officialCardIds.has(id)) fail("card id is duplicated across candidates and officialCatalog: " + id);
  const cardIds = new Set([...candidateIds, ...officialCardIds]);
  const sourceIds = uniqueIds(data.sources, "sources");
  for (const id of REQUIRED_MARKET_SOURCES) if (!sourceIds.has(id)) fail("market sources must include the six target platforms; missing " + id);
  uniqueIds(data.observations, "observations");
  if (errors.length) return { errors, warnings: [] };
  const cardsById = new Map([...data.officialCatalog.cards, ...data.candidates].map((card) => [card.id, card]));
  for (const card of cardsById.values()) {
    const allowed = officialCardIds.has(card.id) ? CARD_FIELDS : CANDIDATE_FIELDS;
    for (const key of Object.keys(card)) if (!allowed.has(key)) fail("card " + card.id + " contains unsupported public field " + key);
    for (const key of ["player", "team", "type"]) if (typeof card[key] !== "string" || !card[key].trim() || card[key].length > 120) fail("card " + card.id + " needs a valid " + key);
    for (const key of ["variant", "cardNumber", "serial"]) if (card[key] != null && (typeof card[key] !== "string" || card[key].length > 120)) fail("card " + card.id + " has invalid " + key);
    if (card.identityStatus != null && (typeof card.identityStatus !== "string" || card.identityStatus.length > 1000)) fail("card " + card.id + " has invalid identityStatus");
    if (Object.hasOwn(card, "observations") && (!Array.isArray(card.observations) || card.observations.length)) fail("card " + card.id + " nested observations must stay empty; use the reviewed global observations array");
    for (const value of Object.values(card)) if (typeof value === "string" && PII.test(value)) fail("card " + card.id + " appears to contain personal contact information");
    if (card.printingIdentity != null) {
      try { validatePublicCardIdentity(card); } catch (error) { fail("card " + card.id + ": " + error.message); }
    }
  }

  for (const source of data.sources) {
    const allowedSourceFields = new Set(["id", "name", "kind", "status", "note", "url", "coverage"]);
    for (const key of Object.keys(source)) if (!allowedSourceFields.has(key)) fail("source contains unsupported field " + key);
    validateUrl(source.url, source.id, "source " + source.id, fail);
    for (const key of ["id", "name", "kind", "status", "note"]) if (typeof source[key] !== "string" || !source[key].trim() || source[key].length > (key === "note" ? 1000 : 160) || PII.test(source[key])) fail("source has invalid public " + key);
    const coverage = source.coverage;
    if (!coverage || typeof coverage !== "object" || Array.isArray(coverage)) {
      fail("source " + source.id + " needs a public coverage state");
    } else {
      for (const key of Object.keys(coverage)) if (!new Set(["state", "checkedAt", "scope"]).has(key)) fail("source " + source.id + " coverage contains unsupported field " + key);
      if (!SOURCE_COVERAGE_STATES.has(coverage.state)) fail("source " + source.id + " has an unknown coverage state");
      if (coverage.state === "not_checked") {
        if (coverage.checkedAt !== null || coverage.scope !== null) fail("unverified source " + source.id + " must not claim a checked date or scope");
      } else {
        if (!publicDate(coverage.checkedAt, now)) fail("source " + source.id + " needs a valid non-future coverage checkedAt");
        if (typeof coverage.scope !== "string" || !coverage.scope.trim() || coverage.scope.length > 500 || PII.test(coverage.scope)) fail("source " + source.id + " needs a concise public coverage scope");
      }
    }
  }

  for (const card of cardsById.values()) {
    if (card.photoSources == null) continue;
    if (!Array.isArray(card.photoSources) || card.photoSources.length > 20) {
      fail("card " + card.id + " photoSources must be an array with at most 20 links");
      continue;
    }
    for (const photo of card.photoSources) {
      if (!photo || typeof photo !== "object" || Array.isArray(photo)) { fail("card " + card.id + " has an invalid photo source"); continue; }
      for (const key of Object.keys(photo)) if (!new Set(["sourceId", "title", "note", "url"]).has(key)) fail("card " + card.id + " photo source contains unsupported field " + key);
      if (!sourceIds.has(photo.sourceId)) fail("card " + card.id + " photo source has unknown sourceId");
      if (typeof photo.title !== "string" || !photo.title.trim() || photo.title.length > 180) fail("card " + card.id + " photo source needs a concise title");
      if (typeof photo.note !== "string" || photo.note.length > 500) fail("card " + card.id + " photo source has an invalid note");
      validateUrl(photo.url, photo.sourceId, "card " + card.id + " photo source", fail);
      for (const key of ["title", "note"]) if (PII.test(String(photo[key] ?? ""))) fail("photo source appears to contain personal contact information");
    }
  }

  const kinds = new Set(["asking", "auction", "auction_current_bid", "auction_final_bid", "sold", "sold_verified", "official_retail", "reference"]);
  const states = new Set(["active_asking", "active_at_check", "unavailable_on_recheck", "sold_badge_sale_price_unverified", "sold_badge_only", "sold_verified", "unknown"]);
  const matches = new Set(["candidate", "exact", "generic"]);
  for (const row of data.observations) {
    if (!row || typeof row !== "object" || Array.isArray(row)) { fail("observation must be an object"); continue; }
    for (const key of Object.keys(row)) if (!OBS_FIELDS.has(key)) fail("observation " + row.id + " has unsupported public field " + key);
    for (const [key, max] of Object.entries(STRING_LIMITS)) {
      if (row[key] != null && (typeof row[key] !== "string" || row[key].length > max)) fail("observation " + row.id + " has invalid or oversized " + key);
    }
    if (!sourceIds.has(row.sourceId)) fail("observation " + row.id + " has unknown sourceId");
    if (!kinds.has(row.kind)) fail("observation " + row.id + " has unknown kind");
    if (!states.has(row.state)) fail("observation " + row.id + " has unknown state");
    if (!matches.has(row.matchLevel)) fail("observation " + row.id + " has unknown matchLevel");
    if (row.matchLevel === "exact" && !/^[a-f0-9]{64}$/.test(row.comparisonKey ?? "")) fail("exact observation " + row.id + " requires a verified comparisonKey");
    if (row.matchLevel !== "exact" && row.comparisonKey != null) fail("unconfirmed observation " + row.id + " cannot carry a comparisonKey");
    if (!publicDate(row.checkedAt, now)) fail("observation " + row.id + " has invalid or future checkedAt");
    if (typeof row.title !== "string" || !row.title.trim()) fail("observation " + row.id + " needs a title");
    try {
      if (row.title !== editorialTitleFor(row, cardsById)) fail("observation " + row.id + " title must use its generated editorial label");
    } catch (error) {
      fail("observation " + row.id + " cannot generate editorial title: " + error.message);
    }
    if (typeof row.matchNote !== "string" || !row.matchNote.trim()) fail("observation " + row.id + " needs match evidence in matchNote");
    if (!Number.isSafeInteger(row.price) || row.price <= 0) fail("observation " + row.id + " price must be a positive integer KRW");
    if (row.shippingPrice !== null && row.shippingPrice !== undefined && (!Number.isSafeInteger(row.shippingPrice) || row.shippingPrice < 0)) fail("observation " + row.id + " shippingPrice must be null or a non-negative integer");
    validateUrl(row.url, row.sourceId, "observation " + row.id, fail);
    if (row.cardId != null && !cardIds.has(row.cardId)) fail("observation " + row.id + " points to unknown cardId");
    if (row.matchLevel === "generic" && row.cardId != null) fail("generic observation " + row.id + " must not have cardId");
    if (row.matchLevel !== "generic" && !cardIds.has(row.cardId)) fail(row.matchLevel + " observation " + row.id + " needs a known cardId");
    if (row.kind === "reference" && row.matchLevel !== "generic") fail("reference observation " + row.id + " must be generic");
    if (["sold", "sold_verified"].includes(row.kind) && row.state !== "sold_verified") fail("sold observation " + row.id + " needs verified sold state");
    if (["sold_badge_sale_price_unverified", "sold_badge_only"].includes(row.state)) {
      if (["sold", "sold_verified"].includes(row.kind)) fail("sold badge cannot be a verified sale");
      warningSet.add("A sold badge is not proof of a settlement price.");
    }
    for (const key of ["title", "matchNote"]) if (PII.test(String(row[key] ?? ""))) fail("observation " + row.id + " appears to contain personal contact information");
  }
  const ledger = validateReviewLedger(data, siteRoot, { now, pendingRecords });
  if (ledger.missingCount > 0) fail("public observations must all have private source-review records; missing " + ledger.missingCount);
  for (const warning of ledger.warnings) warningSet.add(warning);
  for (const error of ledger.errors) fail("private review ledger: " + error);
  const catalogReview = validateCatalogReviewLedger(data, siteRoot, { now });
  for (const error of catalogReview.errors) fail("private catalog review: " + error);
  return { errors, warnings: [...warningSet] };
}

function main() {
  const args = process.argv.slice(2);
  const fileIndex = args.indexOf("--file");
  const selected = fileIndex >= 0 ? path.resolve(args[fileIndex + 1] ?? "") : path.join(root, "data", "market.json");
  let data;
  try {
    if (fs.statSync(selected).size > MAX_BYTES) throw new Error("file exceeds 5 MiB");
    data = JSON.parse(fs.readFileSync(selected, "utf8"));
  } catch (error) {
    console.error("FAIL cannot read market JSON: " + error.message);
    process.exitCode = 1;
    return;
  }
  const result = validateMarket(data, path.relative(root, selected) || selected);
  for (const warning of result.warnings) console.warn("WARN " + warning);
  if (result.errors.length) {
    for (const error of result.errors) console.error("FAIL " + error);
    process.exitCode = 1;
    return;
  }
  if (fileIndex < 0) {
    const dist = path.join(root, "dist", "data", "market.json");
    if (!fs.existsSync(dist) || !fs.readFileSync(selected).equals(fs.readFileSync(dist))) {
      console.error("FAIL source data and dist/data/market.json are not byte-identical");
      process.exitCode = 1;
      return;
    }
  }
  console.log("PASS " + data.officialCatalog.cards.length + " official cards, " + data.candidates.length + " listing candidates, " + data.observations.length + " observations; source/dist synchronized");
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
