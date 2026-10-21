import { createHash } from "node:crypto";

// Version 2 separates an official checklist row from a shirt number and from
// the code actually printed on a physical copy. No value is inferred from price.
const FIELDS = new Set([
  "year", "product", "player", "team", "checklistCardId", "printedCardCode", "jerseyNumber",
  "category", "parallel", "autograph", "relic", "serialLimit", "serialNumber",
  "gradingStatus", "gradingCompany", "grade", "condition",
]);
const UNKNOWN = new Set(["unknown", "unconfirmed", "unspecified", "pending", "unassessed", "확인 전", "확인전", "미확인"]);
const CATEGORIES = new Set(["base", "edge", "curve", "grounds", "chrome", "rookie", "rookie_of_year", "jersey", "patch", "big_jersey", "big_patch", "autograph", "on_card_autograph", "patch_on_card_autograph"]);
const AUTOGRAPHS = new Set(["none", "sticker", "on_card"]);
const RELICS = new Set(["none", "jersey", "patch", "big_jersey", "big_patch"]);
const TEAM_ALIASES = new Map([
  ["lg", "lg"], ["lg twins", "lg"], ["lg 트윈스", "lg"],
  ["hanwha", "hanwha"], ["hanwha eagles", "hanwha"], ["한화", "hanwha"], ["한화 이글스", "hanwha"],
  ["ssg", "ssg"], ["ssg landers", "ssg"], ["ssg 랜더스", "ssg"],
  ["samsung", "samsung"], ["samsung lions", "samsung"], ["삼성", "samsung"], ["삼성 라이온즈", "samsung"],
  ["nc", "nc"], ["nc dinos", "nc"], ["nc 다이노스", "nc"],
  ["kt", "kt"], ["kt wiz", "kt"], ["kt 위즈", "kt"],
  ["lotte", "lotte"], ["lotte giants", "lotte"], ["롯데", "lotte"], ["롯데 자이언츠", "lotte"],
  ["kia", "kia"], ["kia tigers", "kia"], ["kia 타이거즈", "kia"],
  ["doosan", "doosan"], ["doosan bears", "doosan"], ["두산", "doosan"], ["두산 베어스", "doosan"],
  ["kiwoom", "kiwoom"], ["kiwoom heroes", "kiwoom"], ["키움", "kiwoom"], ["키움 히어로즈", "kiwoom"],
]);
const CODE_TEAM = { T: "lg", E: "hanwha", S: "ssg", L: "samsung", N: "nc", W: "kt", G: "lotte", K: "kia", D: "doosan", H: "kiwoom" };
const PRODUCT_ALIASES = new Set(["scc_sensation", "scc sensation", "scc 센세이션", "2026 kbo league sensation", "2026 scc sensation", "2026 scc 센세이션"]);
const IDENTITY_FIELDS = ["year", "product", "player", "team", "checklistCardId", "category", "parallel", "autograph", "relic", "serialLimit"];

function text(value) {
  if (value == null) return null;
  const normalized = value.normalize("NFC").trim().replace(/\s+/g, " ").toLocaleLowerCase("ko-KR");
  return UNKNOWN.has(normalized) ? null : normalized;
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
}

export function buildIdentityTemplate() {
  return Object.fromEntries([...FIELDS].map((key) => [key, null]));
}

export function normalizeIdentityV2(input, label = "identity") {
  object(input, label);
  for (const key of Object.keys(input)) if (!FIELDS.has(key)) throw new Error(`${label} contains unsupported field ${key}`);
  const result = buildIdentityTemplate();
  for (const key of FIELDS) {
    const value = input[key];
    if (value == null) continue;
    if (["year", "jerseyNumber", "serialLimit", "serialNumber"].includes(key)) {
      if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label}.${key} must be a non-negative integer or null`);
      result[key] = value;
    } else {
      if (typeof value !== "string" || !value.trim() || value.length > 160 || /[\x00-\x1f]/.test(value)) throw new Error(`${label}.${key} must be a short string or null`);
      result[key] = text(value);
    }
  }
  if (result.year != null && (result.year < 1900 || result.year > 2200)) throw new Error(`${label}.year is invalid`);
  if (result.jerseyNumber > 999) throw new Error(`${label}.jerseyNumber is invalid`);
  if (result.serialNumber === 0) throw new Error(`${label}.serialNumber must be positive or null`);
  if (result.serialLimit === 0 && result.serialNumber != null) throw new Error(`${label}: an unnumbered card cannot have a serialNumber`);
  if (result.serialLimit != null && result.serialNumber > result.serialLimit) throw new Error(`${label}.serialNumber cannot exceed serialLimit`);
  if (result.product != null) {
    if (!PRODUCT_ALIASES.has(result.product)) throw new Error(`${label}.product is not a reviewed product identifier`);
    result.product = "scc_sensation";
  }
  if (result.team != null) {
    if (!TEAM_ALIASES.has(result.team)) throw new Error(`${label}.team is not a reviewed team identifier`);
    result.team = TEAM_ALIASES.get(result.team);
  }
  for (const [field, allowed] of [["category", CATEGORIES], ["autograph", AUTOGRAPHS], ["relic", RELICS], ["gradingStatus", new Set(["raw", "graded"])]] ) {
    if (result[field] != null && !allowed.has(result[field])) throw new Error(`${label}.${field} is invalid`);
  }
  if (result.checklistCardId != null) {
    result.checklistCardId = result.checklistCardId.toUpperCase();
    const code = /^SCC-(\d{2})\/([A-Z])(\d{2})$/.exec(result.checklistCardId);
    if (!code || Number(code[3]) === 0) throw new Error(`${label}.checklistCardId must be an official row code, not a jersey number`);
    if (result.year != null && Number(code[1]) !== result.year % 100) throw new Error(`${label}.checklistCardId year conflicts with year`);
    if (result.year === 2026 && result.product === "scc_sensation" && result.team != null && CODE_TEAM[code[2]] !== result.team) throw new Error(`${label}.checklistCardId conflicts with the official team prefix`);
  }
  if (result.printedCardCode != null) result.printedCardCode = result.printedCardCode.toUpperCase();
  if ((result.gradingCompany == null) !== (result.grade == null)) throw new Error(`${label} must provide gradingCompany and grade together`);
  if (result.gradingStatus === "graded" && (result.grade == null || result.gradingCompany == null)) throw new Error(`${label}: graded cards require a company and grade`);
  if (result.gradingStatus === "raw" && (result.grade != null || result.gradingCompany != null)) throw new Error(`${label}: raw cards cannot have a grading company or grade`);
  if (["autograph", "on_card_autograph", "patch_on_card_autograph"].includes(result.category) && result.autograph === "none") throw new Error(`${label}: autograph category conflicts with autograph none`);
  if (["on_card_autograph", "patch_on_card_autograph"].includes(result.category) && result.autograph === "sticker") throw new Error(`${label}: on-card category conflicts with sticker autograph`);
  if (["jersey", "patch", "big_jersey", "big_patch"].includes(result.category) && result.relic != null && result.relic !== result.category) throw new Error(`${label}: relic category conflicts with relic type`);
  if (result.category === "patch_on_card_autograph" && result.relic === "none") throw new Error(`${label}: patch autograph requires a relic`);
  return result;
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function serialTraits(identity) {
  const row = normalizeIdentityV2(identity);
  if (!row.serialNumber || !row.serialLimit) return [];
  return [
    ...(row.serialNumber === 1 ? ["first_number"] : []),
    ...(row.serialNumber === row.serialLimit ? ["last_number"] : []),
    ...(row.jerseyNumber === row.serialNumber ? ["jersey_number"] : []),
  ];
}

export function compareIdentities(catalogInput, listingInput) {
  const catalog = normalizeIdentityV2(catalogInput, "catalogIdentity");
  const listing = normalizeIdentityV2(listingInput, "listingIdentity");
  const missingFields = IDENTITY_FIELDS.filter((key) => catalog[key] == null || listing[key] == null);
  const conflicts = IDENTITY_FIELDS.filter((key) => catalog[key] != null && listing[key] != null && catalog[key] !== listing[key]);
  // A shirt number can disprove a proposed match, but never establishes one.
  if (catalog.jerseyNumber != null && listing.jerseyNumber != null && catalog.jerseyNumber !== listing.jerseyNumber) conflicts.push("jerseyNumber");
  const comparisonBlockers = [];
  if (catalog.serialLimit > 0 && (catalog.serialNumber == null || listing.serialNumber == null)) comparisonBlockers.push("serial_number_unconfirmed");
  else if (catalog.serialNumber !== listing.serialNumber) comparisonBlockers.push("different_serial_numbers");
  if (catalog.gradingStatus == null || listing.gradingStatus == null) comparisonBlockers.push("grading_status_unconfirmed");
  else if (catalog.gradingStatus !== listing.gradingStatus || catalog.gradingCompany !== listing.gradingCompany || catalog.grade !== listing.grade) comparisonBlockers.push("grading_differs");
  if (catalog.condition == null || listing.condition == null) comparisonBlockers.push("condition_unconfirmed");
  else if (catalog.condition !== listing.condition) comparisonBlockers.push("condition_differs");
  const exact = !missingFields.length && !conflicts.length;
  const printKey = exact ? digest(IDENTITY_FIELDS.map((key) => catalog[key])) : null;
  return {
    decision: conflicts.length ? "conflict" : missingFields.length ? "needs_review" : "exact_identity",
    matchLevel: exact ? "exact" : "candidate",
    identityComparable: exact && comparisonBlockers.length === 0,
    missingFields, conflicts, comparisonBlockers,
    printIdentityKey: printKey,
    comparisonKey: exact && !comparisonBlockers.length ? digest([printKey, catalog.serialNumber, catalog.gradingStatus, catalog.gradingCompany, catalog.grade, catalog.condition]) : null,
    serialTraits: { catalog: serialTraits(catalog), listing: serialTraits(listing) },
    reasons: [
      ...(conflicts.length ? ["Known identity dimensions conflict; do not link these records."] : []),
      ...(missingFields.length ? ["Required identity dimensions are unconfirmed; retain for review."] : []),
      ...(exact ? ["Required checklist, player and card-variant dimensions agree; this is a local identity proposal."] : []),
      ...(comparisonBlockers.length ? ["Physical-copy details do not support a combined price comparison."] : []),
    ],
  };
}

export function reviewIdentityCaseV2(input) {
  object(input, "match review case");
  const allowed = new Set(["schemaVersion", "caseId", "itemType", "catalogIdentity", "listingIdentity"]);
  for (const key of Object.keys(input)) if (!allowed.has(key)) throw new Error(`match review case contains unsupported field ${key}`);
  if (input.schemaVersion !== 2) throw new Error("match review case schemaVersion must be 2");
  if (typeof input.caseId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(input.caseId)) throw new Error("match review case caseId is invalid");
  if (!["single_card", "sealed_box", "sealed_pack", "lot", "choice_listing", "general_reference"].includes(input.itemType)) throw new Error("match review case itemType is invalid");
  normalizeIdentityV2(input.catalogIdentity, "catalogIdentity");
  normalizeIdentityV2(input.listingIdentity, "listingIdentity");
  if (input.itemType !== "single_card") return { caseId: input.caseId, decision: "excluded_item_type", matchLevel: "generic", identityComparable: false, missingFields: [], conflicts: [], comparisonBlockers: ["not_single_card"], printIdentityKey: null, comparisonKey: null, reasons: ["Lots, choice listings, boxes and packs do not enter single-card matching."] };
  return { caseId: input.caseId, ...compareIdentities(input.catalogIdentity, input.listingIdentity) };
}

export function buildMatchReviewTemplateV2(caseId) {
  const result = { schemaVersion: 2, caseId, itemType: "single_card", catalogIdentity: buildIdentityTemplate(), listingIdentity: buildIdentityTemplate() };
  reviewIdentityCaseV2(result);
  return result;
}

export function crossListingSuspicions(records) {
  if (!Array.isArray(records)) throw new Error("cross-listing input must be an array");
  const groups = new Map();
  for (const record of records) {
    if (record.itemType !== "single_card" || typeof record.sourceId !== "string" || typeof record.externalId !== "string") continue;
    const identity = normalizeIdentityV2(record.identity);
    const match = compareIdentities(identity, identity);
    if (match.matchLevel !== "exact" || identity.serialLimit === 0 || identity.serialNumber == null) continue;
    const key = digest([match.printIdentityKey, identity.serialNumber]);
    const group = groups.get(key) ?? [];
    if (!group.some((row) => row.sourceId === record.sourceId && row.externalId === record.externalId)) group.push({ sourceId: record.sourceId, externalId: record.externalId });
    groups.set(key, group);
  }
  return [...groups.entries()].filter(([, rows]) => new Set(rows.map((row) => row.sourceId)).size > 1)
    .map(([groupId, listings]) => ({ groupId, status: "suspected_cross_listing", listings, reviewRequired: true, confirmedDuplicate: false }));
}
