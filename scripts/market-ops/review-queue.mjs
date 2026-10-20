import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { SOURCE_BY_ID } from "./catalog.mjs";
import { CONTACT_INFO } from "./privacy.mjs";
import { normalizeIdentityV2, reviewIdentityCaseV2 } from "./identity.mjs";

const MAX_BYTES = 8 * 1024 * 1024;
const REF = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,159}$/;

function reference(value, label) {
  if (typeof value !== "string" || !REF.test(value) || CONTACT_INFO.test(value) || /REPLACE|PLACEHOLDER/i.test(value)) throw new Error(`${label} must be a non-identifying private evidence reference`);
}

export function normalizeQueueInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("queue input must be an object");
  const allowed = new Set(["schemaVersion", "inventoryOrigin", "sourceId", "externalId", "url", "evidenceRefs", "matchCase"]);
  for (const key of Object.keys(input)) if (!allowed.has(key)) throw new Error(`queue input contains unsupported field ${key}`);
  if (input.schemaVersion !== 1) throw new Error("queue input schemaVersion must be 1");
  if (!["independent_market", "owner_held", "unknown"].includes(input.inventoryOrigin)) throw new Error("queue inventoryOrigin must be explicit");
  const source = SOURCE_BY_ID.get(input.sourceId);
  if (!source) throw new Error("queue sourceId is invalid");
  if (typeof input.externalId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(input.externalId)) throw new Error("queue externalId is invalid");
  let url;
  try { url = new URL(input.url); } catch { throw new Error("queue url is invalid"); }
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash || !source.hostnames.includes(url.hostname)) throw new Error("queue url must be a canonical HTTPS source URL without credentials or query data");
  if (source.id === "bunjang" && (!/^\d+$/.test(input.externalId) || url.pathname !== `/products/${input.externalId}`)) throw new Error("Bunjang queue URL must match the numeric product ID");
  if (!Array.isArray(input.evidenceRefs) || !input.evidenceRefs.length || input.evidenceRefs.length > 20) throw new Error("queue evidenceRefs must contain 1–20 private references");
  for (const ref of input.evidenceRefs) reference(ref, "queue evidenceRefs");
  if (input.matchCase?.schemaVersion !== 2) throw new Error("queue matching requires identity schemaVersion 2");
  reviewIdentityCaseV2(input.matchCase);
  return {
    schemaVersion: 1,
    inventoryOrigin: input.inventoryOrigin,
    sourceId: source.id,
    externalId: input.externalId,
    url: url.href,
    evidenceRefs: [...new Set(input.evidenceRefs)].sort(),
    matchCase: {
      schemaVersion: 2, caseId: input.matchCase.caseId, itemType: input.matchCase.itemType,
      catalogIdentity: normalizeIdentityV2(input.matchCase.catalogIdentity),
      listingIdentity: normalizeIdentityV2(input.matchCase.listingIdentity),
    },
  };
}

function contentHash(input) {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

export function emptyReviewQueue() {
  return { schemaVersion: 1, updatedAt: null, entries: [], events: [] };
}

export function upsertReviewCase(queue, raw, now = new Date()) {
  const input = normalizeQueueInput(raw);
  const hash = contentHash(input);
  const previous = queue.entries.find((entry) => entry.caseId === input.matchCase.caseId);
  if (previous?.contentSha256 === hash) return { changed: false, entry: previous };
  if (!previous && queue.entries.length >= 2000) throw new Error("review queue is full; archive reviewed cases before adding more");
  if (previous && (previous.input.sourceId !== input.sourceId || previous.input.externalId !== input.externalId)) throw new Error("a case ID cannot be reused for another listing");
  const at = now.toISOString();
  const proposal = reviewIdentityCaseV2(input.matchCase);
  const entry = {
    caseId: input.matchCase.caseId, contentSha256: hash, input, proposal,
    status: "pending", revision: (previous?.revision ?? 0) + 1,
    createdAt: previous?.createdAt ?? at, updatedAt: at, review: null,
  };
  if (previous) queue.entries.splice(queue.entries.indexOf(previous), 1, entry);
  else queue.entries.push(entry);
  queue.events.push({ id: randomUUID(), at, caseId: entry.caseId, action: previous ? "case_revised_review_invalidated" : "case_added", contentSha256: hash, previousContentSha256: previous?.contentSha256 ?? null });
  queue.updatedAt = at;
  return { changed: true, entry };
}

export function recordMatchDecision(queue, caseId, decision, evidenceRef, now = new Date()) {
  if (!["approve", "defer", "reject"].includes(decision)) throw new Error("review decision must be approve, defer or reject");
  reference(evidenceRef, "review evidence");
  const entry = queue.entries.find((row) => row.caseId === caseId);
  if (!entry) throw new Error("review case was not found");
  const normalized = normalizeQueueInput(entry.input);
  if (contentHash(normalized) !== entry.contentSha256) throw new Error("case content changed outside the queue; re-add it before review");
  const proposal = reviewIdentityCaseV2(normalized.matchCase);
  if (decision === "approve" && proposal.decision !== "exact_identity") throw new Error("only complete, non-conflicting single-card identities may be approved");
  const at = now.toISOString();
  const status = { approve: "approved", defer: "deferred", reject: "rejected" }[decision];
  if (entry.status === status && entry.review?.evidenceRef === evidenceRef && entry.review?.contentSha256 === entry.contentSha256) return { changed: false, entry };
  entry.proposal = proposal;
  entry.status = status;
  entry.review = { decision, evidenceRef, reviewedAt: at, contentSha256: entry.contentSha256, publicPublicationAllowed: false };
  entry.updatedAt = at;
  queue.updatedAt = at;
  queue.events.push({ id: randomUUID(), at, caseId, action: `review_${decision}`, contentSha256: entry.contentSha256, evidenceRef });
  return { changed: true, entry };
}

export function summarizeReviewQueue(queue) {
  return {
    schemaVersion: 1, updatedAt: queue.updatedAt, publicPublicationAllowed: false,
    counts: Object.fromEntries(["pending", "approved", "deferred", "rejected"].map((state) => [state, queue.entries.filter((entry) => entry.status === state).length])),
    cases: queue.entries.map((entry) => ({ caseId: entry.caseId, sourceId: entry.input.sourceId, status: entry.status, revision: entry.revision, decision: entry.proposal.decision, identityComparable: entry.proposal.identityComparable, missingFields: entry.proposal.missingFields, conflicts: entry.proposal.conflicts, comparisonBlockers: entry.proposal.comparisonBlockers })),
  };
}

function assertQueue(queue) {
  if (!queue || queue.schemaVersion !== 1 || !Array.isArray(queue.entries) || !Array.isArray(queue.events)) throw new Error("review queue format is invalid; preserve it for inspection");
  if (queue.entries.length > 2000 || queue.events.length > 20000) throw new Error("review queue exceeds its archive limit");
  const ids = new Set();
  for (const entry of queue.entries) {
    const input = normalizeQueueInput(entry.input);
    if (entry.caseId !== input.matchCase.caseId || ids.has(entry.caseId)) throw new Error("review queue has invalid or duplicate case IDs");
    ids.add(entry.caseId);
    if (entry.contentSha256 !== contentHash(input)) throw new Error("review queue content hash is invalid");
    if (!["pending", "approved", "deferred", "rejected"].includes(entry.status)) throw new Error("review queue status is invalid");
    if (entry.status === "approved" && (entry.review?.contentSha256 !== entry.contentSha256 || entry.review?.publicPublicationAllowed !== false || reviewIdentityCaseV2(input.matchCase).decision !== "exact_identity")) throw new Error("review approval is stale or invalid");
  }
  return queue;
}

async function assertDirectory(directory) {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("review storage must use real directories, not symlinks");
}

async function storagePaths(workspaceRoot, create = false) {
  const root = await realpath(workspaceRoot);
  const privateDir = path.join(root, ".ops-private");
  const queueDir = path.join(privateDir, "match-review");
  if (create) await mkdir(privateDir, { recursive: true });
  try { await assertDirectory(privateDir); } catch (error) { if (!create && error.code === "ENOENT") return null; throw error; }
  if (create) await mkdir(queueDir, { recursive: true });
  try { await assertDirectory(queueDir); } catch (error) { if (!create && error.code === "ENOENT") return null; throw error; }
  return { queueDir, queuePath: path.join(queueDir, "queue.json"), lockPath: path.join(queueDir, "queue.lock") };
}

async function readQueueAt(filePath) {
  let info;
  try { info = await lstat(filePath); } catch (error) { if (error.code === "ENOENT") return emptyReviewQueue(); throw error; }
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_BYTES) throw new Error("review queue must be a regular file under 8 MiB");
  return assertQueue(JSON.parse(await readFile(filePath, "utf8")));
}

export async function readReviewQueue(workspaceRoot) {
  const paths = await storagePaths(workspaceRoot);
  return paths ? readQueueAt(paths.queuePath) : emptyReviewQueue();
}

export async function updateReviewQueue(workspaceRoot, work) {
  const paths = await storagePaths(workspaceRoot, true);
  let lock;
  try { lock = await open(paths.lockPath, "wx", 0o600); } catch (error) { if (error.code === "EEXIST") throw new Error("review queue is locked; inspect the active process before recovery"); throw error; }
  const tempPath = path.join(paths.queueDir, `queue.${process.pid}.${randomUUID()}.tmp`);
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
    const queue = await readQueueAt(paths.queuePath);
    const result = await work(queue);
    assertQueue(queue);
    if (result?.changed === false) return result;
    const bytes = `${JSON.stringify(queue, null, 2)}\n`;
    if (Buffer.byteLength(bytes) > MAX_BYTES) throw new Error("review queue exceeds 8 MiB; archive reviewed cases first");
    const temp = await open(tempPath, "wx", 0o600);
    try { await temp.writeFile(bytes); await temp.sync(); } finally { await temp.close(); }
    await rename(tempPath, paths.queuePath);
    return result;
  } finally {
    await rm(tempPath, { force: true });
    await lock.close();
    await rm(paths.lockPath, { force: true });
  }
}
