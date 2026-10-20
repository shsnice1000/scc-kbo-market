import { createGunzip } from "node:zlib";
import { StringDecoder } from "node:string_decoder";
import { CONTACT_INFO } from "../privacy.mjs";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
const MAX_UNCOMPRESSED_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_CSV_RECORDS = 10_000_000;
const MAX_MATCHES = 5_000;
const PLACEHOLDER_REF = /^(?:REPLACE|TODO|TBD|EXAMPLE|CHANGE[_-]?ME|TEST)(?:[_-]|$)/i;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

function adapterError(code) {
  const error = new Error(`Bunjang catalog import failed (${code})`);
  error.code = code;
  return error;
}

function isoDate(value, fallback) {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) return fallback;
  return new Date(Date.parse(value)).toISOString();
}

function validateConfig(config) {
  if (config?.permissionConfirmed !== true) throw new Error("Bunjang catalog import is disabled until the partner contract and data scope are confirmed");
  if (typeof config.permissionEvidenceRef !== "string" || !ID.test(config.permissionEvidenceRef) || PLACEHOLDER_REF.test(config.permissionEvidenceRef) || CONTACT_INFO.test(config.permissionEvidenceRef)) {
    throw new Error("Bunjang catalog import requires a real private permission evidence reference");
  }
  if (config.publicationBasis !== "partner_contract") throw new Error("Bunjang catalog import requires a partner contract");
  if (config.historyStorageAllowed !== true || config.publicationAllowed !== true) throw new Error("Bunjang catalog import requires explicit history storage and publication permission");
  if (typeof config.termsReviewedAt !== "string" || Number.isNaN(Date.parse(config.termsReviewedAt))) throw new Error("Bunjang catalog import requires a terms review timestamp");
  if (!Number.isInteger(config.retentionDays) || config.retentionDays < 1 || config.retentionDays > 3650) throw new Error("Bunjang catalog retentionDays must be from 1 to 3650");
  if (!new Set(["full", "segment"]).has(config.mode)) throw new Error("Bunjang catalog mode must be full or segment");
  if (!Array.isArray(config.queryTerms) || !config.queryTerms.length || config.queryTerms.length > 100 || config.queryTerms.some((term) => typeof term !== "string" || !term.trim() || term.length > 100 || CONTACT_INFO.test(term))) {
    throw new Error("Bunjang catalog queryTerms must contain 1 to 100 short non-personal strings");
  }
  if (typeof config.scopeLabel !== "string" || !config.scopeLabel.trim() || config.scopeLabel.length > 250 || CONTACT_INFO.test(config.scopeLabel)) throw new Error("Bunjang catalog scopeLabel must briefly describe the reviewed query");
  if (config.maxUncompressedBytes !== undefined && (!Number.isSafeInteger(config.maxUncompressedBytes) || config.maxUncompressedBytes < 1 || config.maxUncompressedBytes > 2 * 1024 * 1024 * 1024)) throw new Error("maxUncompressedBytes must be from 1 byte to 2 GiB");
  const now = config.now instanceof Date ? config.now : new Date(config.now ?? Date.now());
  if (Number.isNaN(now.getTime())) throw new Error("Bunjang catalog now is invalid");
  if (typeof config.catalogGeneratedAt !== "string" || !ISO_UTC.test(config.catalogGeneratedAt) || Number.isNaN(Date.parse(config.catalogGeneratedAt))) throw new Error("Bunjang catalogGeneratedAt must be an ISO UTC feed timestamp");
  if (Date.parse(config.catalogGeneratedAt) > now.getTime() + 5 * 60_000) throw new Error("Bunjang Catalog feed timestamp cannot be more than 5 minutes in the future");
  return { ...config, queryTerms: config.queryTerms.map((term) => term.trim().toLocaleLowerCase("ko-KR")), now };
}

export function bunjangCatalogGeneratedAt(mode, filename) {
  const base = String(filename ?? "").split(/[\\/]/).at(-1);
  const match = mode === "full"
    ? /^full-(\d{4})(\d{2})(\d{2})\.csv\.gz$/i.exec(base)
    : mode === "segment"
      ? /^segment-(\d{4})(\d{2})(\d{2})_(\d{2})\.csv\.gz$/i.exec(base)
      : null;
  if (!match) throw new Error(`Bunjang ${mode} Catalog filename is invalid`);
  const [, year, month, day] = match;
  const hour = mode === "full" ? "03" : match[4];
  const minute = mode === "full" ? "30" : "10";
  const localDateTime = `${year}-${month}-${day}T${hour}:${minute}:00+09:00`;
  const timestamp = new Date(localDateTime);
  const dateParts = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (Number(month) < 1 || Number(month) > 12 || Number(day) < 1 || Number(day) > 31 || Number(hour) > 23 || Number.isNaN(timestamp.getTime()) || dateParts.getUTCFullYear() !== Number(year) || dateParts.getUTCMonth() !== Number(month) - 1 || dateParts.getUTCDate() !== Number(day)) {
    throw new Error(`Bunjang ${mode} Catalog filename contains an invalid date or hour`);
  }
  return timestamp.toISOString();
}

async function* csvRecords(readable, maxUncompressedBytes) {
  const decoder = new StringDecoder("utf8");
  let row = [];
  let field = "";
  let inQuotes = false;
  let quoteSeen = false;
  let skipLineFeed = false;
  let bytesSeen = 0;
  let recordCount = 0;

  const processText = async function* (text) {
    for (const char of text) {
      if (skipLineFeed) {
        skipLineFeed = false;
        if (char === "\n") continue;
      }
      if (inQuotes) {
        if (quoteSeen) {
          if (char === '"') {
            field += '"';
            quoteSeen = false;
            continue;
          }
          if (char !== "," && char !== "\r" && char !== "\n") throw adapterError("MALFORMED_CSV_QUOTE");
          inQuotes = false;
          quoteSeen = false;
        } else if (char === '"') {
          quoteSeen = true;
          continue;
        } else {
          field += char;
          if (field.length > 5 * 1024 * 1024) throw adapterError("CSV_FIELD_TOO_LARGE");
          continue;
        }
      }
      if (char === '"') {
        if (field.length) throw adapterError("MALFORMED_CSV_QUOTE");
        inQuotes = true;
      } else if (char === ",") {
        row.push(field);
        field = "";
      } else if (char === "\n" || char === "\r") {
        row.push(field);
        field = "";
        if (char === "\r") skipLineFeed = true;
        if (row.some((cell) => cell !== "")) {
          recordCount += 1;
          if (recordCount > MAX_CSV_RECORDS) throw adapterError("TOO_MANY_CSV_RECORDS");
          yield row;
        }
        row = [];
      } else {
        field += char;
      }
      if (field.length > 5 * 1024 * 1024) throw adapterError("CSV_FIELD_TOO_LARGE");
    }
  };

  for await (const chunk of readable) {
    bytesSeen += chunk.length;
    if (bytesSeen > maxUncompressedBytes) throw adapterError("CATALOG_TOO_LARGE");
    const text = typeof chunk === "string" ? chunk : decoder.write(chunk);
    yield* processText(text);
  }
  const remaining = decoder.end();
  if (remaining) yield* processText(remaining);
  if (inQuotes && !quoteSeen) throw adapterError("UNTERMINATED_CSV_QUOTE");
  if (quoteSeen) inQuotes = false;
  if (field.length || row.length) {
    row.push(field);
    if (row.some((cell) => cell !== "")) {
      recordCount += 1;
      if (recordCount > MAX_CSV_RECORDS) throw adapterError("TOO_MANY_CSV_RECORDS");
      yield row;
    }
  }
}

function toMap(header, cells) {
  if (cells.length !== header.length) throw adapterError("CSV_COLUMN_COUNT_MISMATCH");
  return Object.fromEntries(header.map((key, index) => [key, cells[index]]));
}

function parsePrice(value, label, nullable = false) {
  if (nullable && (value === "" || value == null)) return null;
  if (typeof value !== "string" || !/^\d+$/.test(value.trim())) throw adapterError(`INVALID_${label.toUpperCase()}`);
  const parsed = Number(value.trim());
  if (!Number.isSafeInteger(parsed) || (label === "price" && parsed <= 0)) throw adapterError(`INVALID_${label.toUpperCase()}`);
  return parsed;
}

function rowMatches(row, queryTerms) {
  const searchable = [row.name, row.description, row.keywords].filter((value) => typeof value === "string").join(" ").toLocaleLowerCase("ko-KR");
  return queryTerms.some((term) => searchable.includes(term));
}

export async function buildBunjangCatalogSnapshot(gzipReadable, rawConfig) {
  const config = validateConfig(rawConfig);
  const gunzip = gzipReadable.pipe(createGunzip());
  const rows = csvRecords(gunzip, config.maxUncompressedBytes ?? MAX_UNCOMPRESSED_BYTES);
  const first = await rows.next();
  if (first.done) throw adapterError("EMPTY_CATALOG");
  const header = first.value.map((cell, index) => index === 0 ? cell.replace(/^\uFEFF/, "").trim() : cell.trim());
  if (new Set(header).size !== header.length || !["pid", "name", "price", "saleStatus"].every((key) => header.includes(key))) throw adapterError("INVALID_CATALOG_HEADER");
  const shippingColumn = header.includes("shippingFee") ? "shippingFee" : header.includes("shipppingFee") ? "shipppingFee" : null;
  if (!shippingColumn) throw adapterError("MISSING_SHIPPING_FEE_COLUMN");
  const observations = [];
  const byId = new Map();
  let parsedRecords = 0;
  const nowIso = config.now.toISOString();

  for await (const cells of rows) {
    parsedRecords += 1;
    const product = toMap(header, cells);
    if (!rowMatches(product, config.queryTerms)) continue;
    const externalId = String(product.pid ?? "").trim();
    if (!ID.test(externalId)) throw adapterError("INVALID_PRODUCT_ID");
    const price = parsePrice(product.price, "price");
    const shippingPrice = parsePrice(product[shippingColumn], "shipping_fee", true);
    if (!new Set(["SELLING", "DELETED"]).has(product.saleStatus)) throw adapterError("UNKNOWN_SALE_STATUS");
    const state = product.saleStatus === "SELLING" ? "active_asking" : "unavailable_on_recheck";
    const updatedAt = isoDate(product.updatedAt, config.catalogGeneratedAt);
    if (Date.parse(updatedAt) > Date.parse(config.catalogGeneratedAt) + 5 * 60_000) throw adapterError("PRODUCT_UPDATE_AFTER_FEED_TIME");
    const observation = {
      externalId,
      url: `https://m.bunjang.co.kr/products/${externalId}`,
      itemType: "general_reference",
      cardId: null,
      kind: "asking",
      state,
      matchLevel: "generic",
      matchNote: "Catalog text matched the configured query; card identity still requires manual review.",
      price,
      shippingPrice,
      observedAt: updatedAt,
    };
    const previous = byId.get(externalId);
    if (previous && JSON.stringify(previous) !== JSON.stringify(observation)) throw adapterError("CONFLICTING_DUPLICATE_PRODUCT");
    if (previous) continue;
    byId.set(externalId, observation);
    observations.push(observation);
    if (observations.length > MAX_MATCHES) throw adapterError("TOO_MANY_QUERY_MATCHES");
  }

  if (parsedRecords < 1) throw adapterError("EMPTY_CATALOG");
  const snapshot = {
    schemaVersion: 2,
    sourceId: "bunjang",
    sourceUrl: "https://m.bunjang.co.kr/",
    captureMethod: "authorized_api",
    review: {
      reviewerRole: "market_reviewer",
      reviewedAt: nowIso,
      publicationBasis: config.publicationBasis,
      publicationEvidenceRef: config.permissionEvidenceRef,
      publicationAllowed: true,
      termsReviewedAt: new Date(config.termsReviewedAt).toISOString(),
      historyStorageAllowed: true,
      retentionDays: config.retentionDays,
      noPersonalData: true,
    },
    coverage: {
      scope: `Bunjang ${config.mode} catalog${config.catalogFileName ? ` ${config.catalogFileName}` : ""} candidate scan: ${config.scopeLabel}`,
      level: config.mode === "full" ? "complete_scope" : "partial_scan",
      pagesVisited: 1,
      stopReason: config.mode === "full" ? "end_of_results" : "unknown",
    },
    observations,
  };
  return {
    snapshot,
    catalogMetadata: {
      mode: config.mode,
      fileName: config.catalogFileName ?? null,
      parsedRecords,
      matchedRecords: observations.length,
      generatedAt: config.catalogGeneratedAt,
    },
  };
}
