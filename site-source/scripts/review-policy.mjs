import { createHash } from "node:crypto";

export const BASES = new Set(["partner_contract", "written_permission", "terms_allow_metadata_display", "official_retail_reference", "seller_consent"]);
export const METHODS = new Set(["manual_public_page", "authorized_api", "seller_submitted", "official_retail_page"]);
export const PII = /(?:[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|(?:\+?82[- .]?)?0?1[016789][-. ]?\d{3,4}[- .]?\d{4}|계좌번호|전화번호|휴대폰|연락처|오픈채팅|카카오톡\s*(?:ID|아이디))/i;
const DATE = /^\d{4}-\d{2}-\d{2}(?:T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:0\d|1[0-4]):[0-5]\d))?$/;
const REF = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,159}$/;
const PLACEHOLDER = /(?:^|[._:/-])(?:unknown|none|null|tbd|todo|pending|example|placeholder|replace)(?:$|[._:/-])/i;

// Date-only observations describe a Korean calendar day, rather than midnight UTC.
export function dateBounds(value) {
  if (typeof value !== "string" || !DATE.test(value)) return null;
  const [year, month, day] = value.slice(0, 10).split("-").map(Number);
  const calendar = new Date(0);
  calendar.setUTCFullYear(year, month - 1, day);
  calendar.setUTCHours(0, 0, 0, 0);
  if (calendar.toISOString().slice(0, 10) !== value.slice(0, 10)) return null;
  const start = Date.parse(value.length === 10 ? value + "T00:00:00+09:00" : value);
  return Number.isFinite(start) ? [start, start + (value.length === 10 ? 86_400_000 - 1 : 0)] : null;
}

export function validDate(value, now = Date.now(), timestampOnly = false) {
  const bounds = dateBounds(value);
  return Boolean(bounds && (!timestampOnly || value.length > 10) && bounds[0] <= now + 300_000);
}

export function noLaterThan(first, second) {
  const a = dateBounds(first), b = dateBounds(second);
  return Boolean(a && b && a[0] <= b[1]);
}

export function evidenceRef(value) {
  return typeof value === "string" && REF.test(value) && !PLACEHOLDER.test(value) && !PII.test(value);
}

export function publicRowSha256(row) {
  const canonical = (value) => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
  return createHash("sha256").update(JSON.stringify(canonical(row))).digest("hex");
}

export function methodBasisAllowed(method, basis) {
  if (method === "authorized_api") return basis === "partner_contract";
  if (method === "seller_submitted") return basis === "seller_consent";
  if (["manual_public_page", "official_retail_page"].includes(method)) return ["written_permission", "terms_allow_metadata_display", "official_retail_reference"].includes(basis);
  return false;
}
