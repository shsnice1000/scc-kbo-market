import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { SOURCE_BY_ID } from "./catalog.mjs";
import { CONTACT_INFO } from "./privacy.mjs";

const MAX_INPUT_BYTES = 1024 * 1024;
const MAX_EVIDENCE_BYTES = 25 * 1024 * 1024;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".heic"]);

function reject(message) {
  throw new Error(`private observation rejected: ${message}`);
}

function exactKeys(value, allowed, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) reject(`${label} must be an object`);
  if (Object.keys(value).some((key) => !allowed.has(key))) reject(`${label} contains unsupported fields`);
}

function requireText(value, label, maxLength) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maxLength || CONTACT_INFO.test(value)) {
    reject(`${label} must be brief text without contact information`);
  }
  return value.trim();
}

function requireTimestamp(value, label, now, nullable = false) {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || !ISO_DATE.test(value) || Number.isNaN(Date.parse(value))) reject(`${label} must be an ISO UTC timestamp${nullable ? " or null" : ""}`);
  if (Date.parse(value) > now + 5 * 60_000) reject(`${label} cannot be more than 5 minutes in the future`);
  return value;
}

function checkedSourceUrl(value, source) {
  if (value === null) return null;
  if (typeof value !== "string" || value.length > 2048) reject("sourceUrl must be null or a canonical HTTPS listing URL");
  let url;
  try {
    url = new URL(value);
  } catch {
    reject("sourceUrl is invalid");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || !source.hostnames.includes(url.hostname.toLowerCase())) {
    reject(`sourceUrl must use an allowed ${source.name} hostname without query or fragment`);
  }
  return url.toString();
}

async function evidenceFor(filePath, workspaceRoot) {
  if (typeof filePath !== "string" || !filePath.trim() || path.isAbsolute(filePath)) reject("evidenceFile must be a workspace-relative image path");
  const normalizedInput = filePath.replaceAll("\\", "/");
  if (normalizedInput.split("/").some((segment) => segment === ".." || segment === "")) reject("evidenceFile cannot traverse directories");
  if (!IMAGE_EXTENSIONS.has(path.extname(filePath).toLowerCase())) reject("evidenceFile must reference an image file");
  const resolvedRoot = await realpath(workspaceRoot);
  const resolvedFile = await realpath(path.resolve(workspaceRoot, filePath));
  if (!resolvedFile.startsWith(`${resolvedRoot}${path.sep}`)) reject("evidenceFile must stay inside the workspace");
  const fileStat = await stat(resolvedFile);
  if (!fileStat.isFile() || fileStat.size > MAX_EVIDENCE_BYTES) reject("evidenceFile must be a file no larger than 25 MiB");
  const bytes = await readFile(resolvedFile);
  return {
    filePath: path.relative(workspaceRoot, resolvedFile).split(path.sep).join("/"),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    fileMtime: fileStat.mtime.toISOString(),
  };
}

function manualUiEvidence({ noteId, sourceUrl, subject, observedAt, price, shippingPrice }) {
  const canonical = JSON.stringify({ noteId, sourceUrl, subject, observedAt, price, shippingPrice });
  return {
    filePath: null,
    fileMtime: null,
    sha256: createHash("sha256").update(canonical).digest("hex"),
    captureMethod: "manual-browser-ui",
  };
}

export async function readPrivateObservation(filePath, { workspaceRoot, now = Date.now() }) {
  let fileStat;
  try {
    fileStat = await stat(filePath);
  } catch {
    reject("cannot access input file");
  }
  if (!fileStat.isFile() || fileStat.size > MAX_INPUT_BYTES) reject("input must be a JSON file no larger than 1 MiB");
  let raw;
  try {
    raw = JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    reject("input is not valid JSON");
  }
  exactKeys(raw, new Set([
    "schemaVersion", "noteId", "sourceId", "sourceUrl", "subject", "matchLevel", "matchNote",
    "priceType", "price", "shippingPrice", "observedAt", "captureMethod", "evidenceFile", "privateAuthorization",
  ]), "input");
  if (raw.schemaVersion !== 1) reject("schemaVersion must be 1");
  if (typeof raw.noteId !== "string" || !ID.test(raw.noteId)) reject("noteId has an invalid format");
  const source = SOURCE_BY_ID.get(raw.sourceId);
  if (!source) reject("sourceId is not in the six-platform catalog");
  if (!new Set(["candidate", "exact", "unresolved"]).has(raw.matchLevel)) reject("matchLevel is invalid");
  if (raw.priceType !== "asking") reject("private observations may only record displayed asking prices");
  if (!Number.isSafeInteger(raw.price) || raw.price <= 0) reject("price must be a positive integer KRW");
  if (raw.shippingPrice !== null && (!Number.isSafeInteger(raw.shippingPrice) || raw.shippingPrice < 0)) reject("shippingPrice must be null or a non-negative integer KRW");
  const observedAt = requireTimestamp(raw.observedAt, "observedAt", now, true);
  const captureMethod = raw.captureMethod ?? "user-provided-screenshot";
  if (!new Set(["user-provided-screenshot", "manual-browser-ui"]).has(captureMethod)) reject("captureMethod is invalid");
  const sourceUrl = checkedSourceUrl(raw.sourceUrl, source);
  const subject = requireText(raw.subject, "subject", 300);
  const matchNote = requireText(raw.matchNote, "matchNote", 500);
  let evidence;
  if (captureMethod === "manual-browser-ui") {
    if (!sourceUrl || !observedAt) reject("manual-browser-ui notes require a canonical sourceUrl and observedAt");
    if (raw.evidenceFile !== null) reject("manual-browser-ui notes must not include a screenshot evidenceFile");
    evidence = manualUiEvidence({
      noteId: raw.noteId,
      sourceUrl,
      subject,
      observedAt,
      price: raw.price,
      shippingPrice: raw.shippingPrice,
    });
  } else {
    evidence = await evidenceFor(raw.evidenceFile, workspaceRoot);
    evidence.captureMethod = "user-provided-screenshot";
  }
  exactKeys(raw.privateAuthorization, new Set(["basis", "grantedAt", "privateStorageAllowed", "publicationAllowed", "apiAccessAllowed", "retentionPolicy"]), "privateAuthorization");
  if (raw.privateAuthorization.basis !== "user_instruction" || raw.privateAuthorization.privateStorageAllowed !== true || raw.privateAuthorization.publicationAllowed !== false || raw.privateAuthorization.apiAccessAllowed !== false) {
    reject("authorization must cover private local storage only; publication and provider API access must remain false");
  }
  if (raw.privateAuthorization.retentionPolicy !== "local_until_operator_deletes") reject("retentionPolicy must be local_until_operator_deletes");
  const authorizedAt = requireTimestamp(raw.privateAuthorization.grantedAt, "privateAuthorization.grantedAt", now);
  return {
    noteId: raw.noteId,
    sourceId: source.id,
    sourceName: source.name,
    sourceUrl,
    subject,
    matchLevel: raw.matchLevel,
    matchNote,
    priceType: "asking",
    currentStatus: "unknown_current_status",
    price: raw.price,
    shippingPrice: raw.shippingPrice,
    observedAt,
    captureMethod,
    evidence,
    privateAuthorization: {
      basis: "user_instruction",
      grantedAt: authorizedAt,
      privateStorageAllowed: true,
      publicationAllowed: false,
      apiAccessAllowed: false,
      retentionPolicy: "local_until_operator_deletes",
    },
  };
}
