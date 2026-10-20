import { CONTACT_INFO } from "../privacy.mjs";

const API_URL = "https://openapi.bunjang.co.kr/api/v1/products";
const STOREFRONT_URL = "https://m.bunjang.co.kr/";
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_OBSERVATIONS = 5000;
const MAX_RETRY_AFTER_MS = 60_000;
const MAX_RETRY_BACKOFF_MS = 8_000;
const EVIDENCE_REF = /^[A-Za-z0-9][A-Za-z0-9._:/#-]{0,199}$/;
const PLACEHOLDER_REF = /^(?:REPLACE|TODO|TBD|EXAMPLE|CHANGE[_-]?ME|TEST)(?:[_-]|$)/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

function adapterError(code) {
  const error = new Error("Bunjang partner API collector failed");
  error.code = code;
  return error;
}

function validateOptions(options) {
  if (options?.permissionConfirmed !== true) throw new Error("Bunjang API collector is disabled until the partner contract and data-use scope are confirmed");
  if (typeof options.getBearerToken !== "function") throw new Error("Bunjang API collector requires a secure bearer-token provider");
  if (typeof options.permissionEvidenceRef !== "string" || !EVIDENCE_REF.test(options.permissionEvidenceRef) || PLACEHOLDER_REF.test(options.permissionEvidenceRef) || CONTACT_INFO.test(options.permissionEvidenceRef)) {
    throw new Error("Bunjang API collector requires a real private partner-permission reference");
  }
  if (typeof options.termsReviewedAt !== "string" || !ISO_DATE.test(options.termsReviewedAt) || Number.isNaN(Date.parse(options.termsReviewedAt))) throw new Error("Bunjang API collector requires an ISO UTC terms review timestamp");
  if (options.historyStorageAllowed !== true || options.publicationAllowed !== true) throw new Error("Bunjang API collector requires explicit history-storage and display permission");
  if (!Number.isInteger(options.retentionDays) || options.retentionDays < 1 || options.retentionDays > 3650) throw new Error("Bunjang API collector requires a permitted retention period from 1 to 3650 days");
  if (!Array.isArray(options.queryPlans) || options.queryPlans.length < 1 || options.queryPlans.length > 50) throw new Error("Bunjang API collector requires 1 to 50 approved query plans");
  const queryPlans = options.queryPlans.map((plan) => {
    if (!plan || typeof plan.query !== "string" || !plan.query.trim() || plan.query.length > 120 || CONTACT_INFO.test(plan.query)) throw new Error("Bunjang query plan has an invalid query or includes personal data");
    if (typeof plan.scopeLabel !== "string" || !plan.scopeLabel.trim() || plan.scopeLabel.length > 60 || CONTACT_INFO.test(plan.scopeLabel)) throw new Error("Bunjang query plan requires a short, non-personal scope label");
    if (plan.categoryId != null && (typeof plan.categoryId !== "string" || !/^\d+(?:,\d+)*$/.test(plan.categoryId))) throw new Error("Bunjang query plan categoryId must be a comma-separated list of numeric IDs");
    return { query: plan.query.trim(), scopeLabel: plan.scopeLabel.trim(), categoryId: plan.categoryId ?? null };
  });
  const scope = `Bunjang authorized API search: ${queryPlans.map((plan) => plan.scopeLabel).join("; ")}`;
  if (scope.length > 300) throw new Error("Bunjang query scope labels exceed the 300-character coverage limit");
  const pageSize = options.pageSize ?? 100;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new Error("Bunjang pageSize must be from 1 to 100");
  const maxPagesPerQuery = options.maxPagesPerQuery ?? 10;
  if (!Number.isInteger(maxPagesPerQuery) || maxPagesPerQuery < 1 || maxPagesPerQuery * queryPlans.length > 10_000) throw new Error("Bunjang maxPagesPerQuery is outside the supported page budget");
  const requestIntervalMs = options.requestIntervalMs ?? 1000;
  if (!Number.isInteger(requestIntervalMs) || requestIntervalMs < 0 || requestIntervalMs > 60_000) throw new Error("Bunjang requestIntervalMs must be from 0 to 60000");
  const maxRetries = options.maxRetries ?? 2;
  if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 5) throw new Error("Bunjang maxRetries must be from 0 to 5");
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("Bunjang API collector requires fetch");
  return { ...options, queryPlans, scope, pageSize, maxPagesPerQuery, requestIntervalMs, maxRetries, fetchImpl };
}

function waitForInterval(ms, signal) {
  if (!ms) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(adapterError("ABORTED"));
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(adapterError("ABORTED"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function retryAfterMs(response, fallbackMs) {
  const value = response?.headers?.get?.("retry-after");
  if (value == null || !String(value).trim()) return fallbackMs;
  const raw = String(value).trim();
  const seconds = /^\d+(?:\.\d+)?$/.test(raw) ? Number(raw) : null;
  const delay = seconds === null ? Date.parse(raw) - Date.now() : seconds * 1000;
  if (!Number.isFinite(delay) || delay < 0) return fallbackMs;
  if (delay > MAX_RETRY_AFTER_MS) throw adapterError("RETRY_AFTER_TOO_LONG");
  return Math.ceil(delay);
}

async function discardResponseBody(response) {
  try {
    await response?.body?.cancel?.();
  } catch {
    // The response is already unusable; keep the source-specific error below.
  }
}

async function fetchPage(config, url, signal, requestCount, recordRequest) {
  for (let attempt = 0; ; attempt += 1) {
    if (signal?.aborted) throw adapterError("ABORTED");
    if (requestCount() > 0) await waitForInterval(config.requestIntervalMs, signal);
    const token = await config.getBearerToken();
    if (typeof token !== "string" || !token.trim() || token.trim().startsWith("Bearer ")) throw adapterError("INVALID_TOKEN_PROVIDER");

    let response;
    try {
      response = await config.fetchImpl(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
        signal,
      });
      recordRequest();
    } catch {
      recordRequest();
      if (signal?.aborted) throw adapterError("ABORTED");
      if (attempt >= config.maxRetries) throw adapterError("NETWORK_ERROR");
      const delay = Math.min(500 * (2 ** attempt), MAX_RETRY_BACKOFF_MS);
      await waitForInterval(delay, signal);
      continue;
    }

    if (response?.ok) return response;
    const status = Number.isInteger(response?.status) ? response.status : null;
    const retryable = status === 429 || (status !== null && status >= 500 && status <= 599);
    if (!retryable || attempt >= config.maxRetries) {
      await discardResponseBody(response);
      throw adapterError(`HTTP_${status ?? "UNKNOWN"}`);
    }

    let delay;
    try {
      delay = status === 429
        ? retryAfterMs(response, Math.min(1000 * (2 ** attempt), MAX_RETRY_BACKOFF_MS))
        : Math.min(500 * (2 ** attempt), MAX_RETRY_BACKOFF_MS);
    } catch (error) {
      await discardResponseBody(response);
      throw error;
    }
    await discardResponseBody(response);
    await waitForInterval(delay, signal);
  }
}

async function readJsonLimited(response) {
  const reader = response.body?.getReader?.();
  if (!reader) throw adapterError("EMPTY_RESPONSE_BODY");
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw adapterError("RESPONSE_TOO_LARGE");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock?.();
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw adapterError("INVALID_JSON");
  }
}

function numeric(value, { positive = false } = {}) {
  if (!Number.isSafeInteger(value) || (positive ? value <= 0 : value < 0)) return null;
  return value;
}

function mapActiveProduct(product, observedAt) {
  if (!product || typeof product !== "object" || Array.isArray(product)) throw adapterError("INVALID_PRODUCT");
  const externalId = String(product.pid ?? "");
  if (!/^\d{1,30}$/.test(externalId)) throw adapterError("INVALID_PRODUCT_ID");
  if (product.saleStatus !== "SELLING" && product.saleStatus !== "DELETED") throw adapterError("UNKNOWN_SALE_STATUS");
  if (product.saleStatus === "DELETED") return null;
  const price = numeric(product.price, { positive: true });
  if (price === null) throw adapterError("INVALID_PRICE");
  const shippingPrice = product.shippingFee == null ? null : numeric(product.shippingFee);
  if (product.shippingFee != null && shippingPrice === null) throw adapterError("INVALID_SHIPPING_FEE");
  return {
    externalId,
    url: `https://m.bunjang.co.kr/products/${externalId}`,
    itemType: "general_reference",
    cardId: null,
    kind: "asking",
    state: "active_asking",
    matchLevel: "generic",
    matchNote: "Authorized API search result; card identity and single-card status require separate review.",
    price,
    shippingPrice,
    observedAt,
  };
}

export function createBunjangSearchCollector(options) {
  const config = validateOptions(options);
  return async ({ source, signal, now = new Date() }) => {
    if (source?.id !== "bunjang") throw new Error("Bunjang search collector can only serve the bunjang source");
    if (signal?.aborted) throw adapterError("ABORTED");
    const observedAt = now.toISOString();
    if (Date.parse(config.termsReviewedAt) > now.getTime() + 5 * 60_000) throw adapterError("TERMS_REVIEW_DATE_FUTURE");
    const byId = new Map();
    const conflicts = new Set();
    const deletedIds = new Set();
    let pagesVisited = 0;
    let hitPageLimit = false;
    let requestsMade = 0;

    for (const plan of config.queryPlans) {
      let cursor = null;
      const seenCursors = new Set();
      for (let page = 0; page < config.maxPagesPerQuery; page += 1) {
        if (signal?.aborted) throw adapterError("ABORTED");
        const url = new URL(API_URL);
        url.searchParams.set("q", plan.query);
        url.searchParams.set("size", String(config.pageSize));
        url.searchParams.set("sort", "score");
        if (plan.categoryId) url.searchParams.set("categoryId", plan.categoryId);
        if (cursor) url.searchParams.set("cursor", cursor);
        const response = await fetchPage(config, url, signal, () => requestsMade, () => { requestsMade += 1; });
        const payload = await readJsonLimited(response);
        if (!Array.isArray(payload?.data) || typeof payload.hasNext !== "boolean") throw adapterError("INVALID_PAGE");
        pagesVisited += 1;
        for (const product of payload.data) {
          if (product?.saleStatus === "DELETED") {
            const deletedId = String(product.pid ?? "");
            if (!/^\d{1,30}$/.test(deletedId)) throw adapterError("INVALID_PRODUCT_ID");
            if (byId.delete(deletedId)) conflicts.add(deletedId);
            deletedIds.add(deletedId);
            continue;
          }
          const observation = mapActiveProduct(product, observedAt);
          if (!observation || conflicts.has(observation.externalId)) continue;
          if (deletedIds.has(observation.externalId)) {
            byId.delete(observation.externalId);
            conflicts.add(observation.externalId);
            continue;
          }
          const previous = byId.get(observation.externalId);
          if (!previous) byId.set(observation.externalId, observation);
          else if (previous.price !== observation.price || previous.shippingPrice !== observation.shippingPrice || previous.state !== observation.state) {
            byId.delete(observation.externalId);
            conflicts.add(observation.externalId);
          }
          if (byId.size >= MAX_OBSERVATIONS) {
            hitPageLimit = true;
            break;
          }
        }
        if (byId.size >= MAX_OBSERVATIONS) break;
        if (!payload.hasNext) break;
        if (typeof payload.nextCursor !== "string" || !payload.nextCursor || seenCursors.has(payload.nextCursor)) throw adapterError("INVALID_CURSOR");
        seenCursors.add(payload.nextCursor);
        cursor = payload.nextCursor;
        if (page + 1 === config.maxPagesPerQuery) hitPageLimit = true;
      }
      if (byId.size >= MAX_OBSERVATIONS) break;
    }

    const partial = hitPageLimit || conflicts.size > 0;
    return {
      schemaVersion: 2,
      sourceId: "bunjang",
      sourceUrl: STOREFRONT_URL,
      captureMethod: "authorized_api",
      review: {
        reviewerRole: "market_reviewer",
        reviewedAt: observedAt,
        publicationBasis: "partner_contract",
        publicationEvidenceRef: config.permissionEvidenceRef,
        publicationAllowed: true,
        termsReviewedAt: config.termsReviewedAt,
        historyStorageAllowed: true,
        retentionDays: config.retentionDays,
        noPersonalData: true,
      },
      coverage: {
        scope: config.scope,
        level: partial ? "partial_scan" : "complete_scope",
        pagesVisited,
        stopReason: hitPageLimit ? "page_limit" : partial ? "unknown" : "end_of_results",
      },
      observations: [...byId.values()],
    };
  };
}
