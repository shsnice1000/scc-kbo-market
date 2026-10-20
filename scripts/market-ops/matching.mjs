import { reviewIdentityCaseV2 } from "./identity.mjs";

const CASE_KEYS = new Set(["schemaVersion", "caseId", "catalogIdentity", "listingIdentity", "itemType"]);
const IDENTITY_KEYS = new Set([
  "year", "product", "player", "team", "cardNumber", "parallel", "autograph", "relic",
  "serialLimit", "serialNumber", "gradingCompany", "grade", "condition",
]);
const CORE_FIELDS = ["year", "product", "player", "team", "cardNumber", "parallel", "autograph", "relic", "serialLimit"];

function normalizedText(value) {
  return typeof value === "string" ? value.normalize("NFC").trim().replace(/\s+/g, " ").toLocaleLowerCase("ko-KR") : null;
}

function validateIdentity(identity, label) {
  if (!identity || typeof identity !== "object" || Array.isArray(identity)) throw new Error(`${label} must be an identity object`);
  for (const key of Object.keys(identity)) if (!IDENTITY_KEYS.has(key)) throw new Error(`${label} contains unsupported field ${key}`);
  if (identity.year != null && (!Number.isInteger(identity.year) || identity.year < 1900 || identity.year > 2200)) throw new Error(`${label}.year must be a four-digit year or null`);
  for (const key of ["product", "player", "team", "cardNumber", "parallel", "autograph", "gradingCompany", "grade", "condition"]) {
    const value = identity[key];
    if (value != null && (typeof value !== "string" || !value.trim() || value.length > 160)) throw new Error(`${label}.${key} must be a non-empty string or null`);
  }
  for (const key of ["relic"]) if (identity[key] != null && typeof identity[key] !== "boolean") throw new Error(`${label}.${key} must be a boolean or null`);
  for (const key of ["serialLimit", "serialNumber"]) {
    const value = identity[key];
    if (value != null && (!Number.isSafeInteger(value) || value < 0)) throw new Error(`${label}.${key} must be a non-negative integer or null`);
  }
  if (identity.serialNumber === 0) throw new Error(`${label}.serialNumber must be positive or null`);
  if (identity.serialLimit === 0 && identity.serialNumber != null) throw new Error(`${label} cannot have a serialNumber when serialLimit is confirmed unnumbered (0)`);
  if (identity.serialLimit > 0 && identity.serialNumber > identity.serialLimit) throw new Error(`${label}.serialNumber cannot exceed serialLimit`);
  if ((identity.gradingCompany == null) !== (identity.grade == null)) throw new Error(`${label} must provide both gradingCompany and grade, or neither`);
}

export function validateMatchReviewCase(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("match review case must be an object");
  for (const key of Object.keys(input)) if (!CASE_KEYS.has(key)) throw new Error(`match review case contains unsupported field ${key}`);
  if (input.schemaVersion !== 1) throw new Error("match review case schemaVersion must be 1");
  if (typeof input.caseId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(input.caseId)) throw new Error("match review case caseId has an invalid format");
  if (!new Set(["single_card", "sealed_box", "sealed_pack", "lot", "general_reference"]).has(input.itemType)) throw new Error("match review case itemType is invalid");
  validateIdentity(input.catalogIdentity, "catalogIdentity");
  validateIdentity(input.listingIdentity, "listingIdentity");
  return input;
}

export function buildMatchReviewTemplate(caseId) {
  if (typeof caseId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(caseId)) throw new Error("match review case id has an invalid format");
  const emptyIdentity = {
    year: null,
    product: null,
    player: null,
    cardNumber: null,
    parallel: null,
    autograph: null,
    relic: null,
    team: null,
    serialLimit: null,
    serialNumber: null,
    gradingCompany: null,
    grade: null,
    condition: null,
  };
  return {
    schemaVersion: 1,
    caseId,
    itemType: "single_card",
    catalogIdentity: { ...emptyIdentity },
    listingIdentity: { ...emptyIdentity },
  };
}

function valueFor(identity, key) {
  const value = identity[key];
  if (key === "year" || key === "serialLimit" || key === "serialNumber" || key === "relic") return value ?? null;
  return normalizedText(value);
}

export function reviewCardMatch(input) {
  if (input?.schemaVersion === 2) return reviewIdentityCaseV2(input);
  const matchCase = validateMatchReviewCase(input);
  if (matchCase.itemType !== "single_card") {
    return {
      caseId: matchCase.caseId,
      decision: "excluded_item_type",
      matchLevel: "generic",
      identityComparable: false,
      reasons: ["Only single-card records enter card identity matching."],
      missingFields: [],
      conflicts: [],
    };
  }

  const catalog = matchCase.catalogIdentity;
  const listing = matchCase.listingIdentity;
  const missingFields = CORE_FIELDS.filter((field) => valueFor(catalog, field) === null || valueFor(listing, field) === null);
  const conflicts = CORE_FIELDS.filter((field) => {
    const a = valueFor(catalog, field);
    const b = valueFor(listing, field);
    return a !== null && b !== null && a !== b;
  });
  const reasons = [];
  if (conflicts.length) reasons.push("Conflicting identity fields prevent linking these records.");
  if (missingFields.length) reasons.push("Required identity fields are incomplete; keep the listing in the review queue.");
  if (!conflicts.length && !missingFields.length) reasons.push("All required printed-card identity fields match exactly.");

  if (conflicts.length) {
    return { caseId: matchCase.caseId, decision: "conflict", matchLevel: "candidate", identityComparable: false, reasons, missingFields, conflicts };
  }
  if (missingFields.length) {
    return { caseId: matchCase.caseId, decision: "needs_review", matchLevel: "candidate", identityComparable: false, reasons, missingFields, conflicts };
  }

  const serialNumbersKnown = catalog.serialNumber != null && listing.serialNumber != null;
  const serialNumberSame = serialNumbersKnown && catalog.serialNumber === listing.serialNumber;
  const gradesKnown = catalog.grade != null && listing.grade != null;
  const gradeSame = gradesKnown
    && normalizedText(catalog.gradingCompany) === normalizedText(listing.gradingCompany)
    && normalizedText(catalog.grade) === normalizedText(listing.grade);
  const gradingCompatible = catalog.grade == null && listing.grade == null || gradeSame;
  const serialComparable = catalog.serialLimit === 0 && listing.serialLimit === 0
    ? catalog.serialNumber == null && listing.serialNumber == null
    : serialNumberSame;
  const conditionComparable = catalog.condition != null && listing.condition != null
    && normalizedText(catalog.condition) === normalizedText(listing.condition);
  const identityComparable = serialComparable && gradingCompatible && conditionComparable;
  if (catalog.serialNumber !== listing.serialNumber) reasons.push("Individual serial numbers differ or are incomplete; do not combine prices without review.");
  if (!gradingCompatible) reasons.push("Grading differs or is incomplete; keep prices in separate comparison groups.");
  if (!conditionComparable) reasons.push("Card condition differs or is unconfirmed; keep prices in separate comparison groups.");
  if (identityComparable) reasons.push("Serial-number, grading and condition details are compatible for a same-group comparison.");
  return {
    caseId: matchCase.caseId,
    decision: "exact_identity",
    matchLevel: "exact",
    identityComparable,
    reasons,
    missingFields: [],
    conflicts: [],
  };
}
