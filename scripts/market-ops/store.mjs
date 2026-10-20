import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { SOURCE_CATALOG } from "./catalog.mjs";

export const DB_SCHEMA_VERSION = 1;
const MAX_RUNS = 200;
const LOCK_WAIT_MS = 5000;

export function emptyDatabase(now = new Date().toISOString()) {
  return {
    schemaVersion: DB_SCHEMA_VERSION,
    createdAt: now,
    updatedAt: now,
    observations: [],
    priceEvents: [],
    privateObservations: [],
    privatePriceEvents: [],
    reviewLedger: [],
    correctionEvents: [],
    retentionEvents: [],
    sourceStatus: Object.fromEntries(SOURCE_CATALOG.map((source) => [source.id, {
      state: "not_connected",
      lastAttemptAt: null,
      lastSuccessAt: null,
      lastRunId: null,
      lastError: null,
      recordCount: 0,
      collectorConnected: false,
      lastCollectorSuccessAt: null,
    }])),
    runs: [],
  };
}

function assertDatabase(db) {
  if (!db || typeof db !== "object" || db.schemaVersion !== DB_SCHEMA_VERSION) {
    throw new Error("local database schema is invalid; preserve the file and inspect it before changing versions");
  }
  db.retentionEvents ??= [];
  db.correctionEvents ??= [];
  for (const key of ["observations", "priceEvents", "reviewLedger", "correctionEvents", "retentionEvents", "runs"]) {
    if (!Array.isArray(db[key])) throw new Error(`local database field ${key} is invalid`);
  }
  db.privateObservations ??= [];
  db.privatePriceEvents ??= [];
  if (!Array.isArray(db.privateObservations) || !Array.isArray(db.privatePriceEvents)) throw new Error("local database private note fields are invalid");
  if (!db.sourceStatus || typeof db.sourceStatus !== "object") throw new Error("local database sourceStatus is invalid");
  for (const source of SOURCE_CATALOG) {
    const status = db.sourceStatus[source.id];
    if (!status || typeof status !== "object") continue;
    const successfulCollectorRun = [...db.runs].reverse().find((run) =>
      run.sources?.some((result) => result.sourceId === source.id && ["collector_updated", "collector_unchanged"].includes(result.state))
    );
    status.collectorConnected ??= Boolean(successfulCollectorRun || ["collector_updated", "collector_unchanged"].includes(status.state));
    status.lastCollectorSuccessAt ??= successfulCollectorRun?.finishedAt
      ?? (["collector_updated", "collector_unchanged"].includes(status.state) ? status.lastSuccessAt ?? null : null);
  }
}

const CORRECTION_REASONS = new Set([
  "source_request",
  "incorrect_card_match",
  "incorrect_price",
  "source_permission_withdrawn",
  "duplicate_record",
  "other_reviewed_correction",
]);

export function retractObservation(db, sourceId, externalId, reasonCode, evidenceRef, now = new Date()) {
  if (!SOURCE_CATALOG.some((source) => source.id === sourceId)) throw new Error(`unknown source id: ${sourceId}`);
  if (typeof externalId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(externalId)) throw new Error("external id has an invalid format");
  if (!CORRECTION_REASONS.has(reasonCode)) throw new Error("correction reason code is not allowed");
  if (typeof evidenceRef !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(evidenceRef)) throw new Error("private evidence reference has an invalid format");
  if (/(?:[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|(?:\+?82[- .]?)?0?1[016789][-. ]?\d{3,4}[- .]?\d{4})/i.test(evidenceRef)) throw new Error("private evidence reference must not contain contact information");
  db.correctionEvents ??= [];
  const listingKey = `${sourceId}:${externalId}`;
  const exists = db.observations.some((row) => row.listingKey === listingKey);
  if (!exists) return { retracted: false, observationsRemoved: 0, priceEventsRemoved: 0 };
  const before = db.observations.length;
  db.observations = db.observations.filter((row) => row.listingKey !== listingKey);
  const observationsRemoved = before - db.observations.length;
  const eventsBefore = db.priceEvents.length;
  db.priceEvents = db.priceEvents.filter((row) => row.listingKey !== listingKey);
  const priceEventsRemoved = eventsBefore - db.priceEvents.length;
  db.correctionEvents.push({
    at: now.toISOString(),
    listingKey,
    reasonCode,
    evidenceRef,
    observationsRemoved,
    priceEventsRemoved,
  });
  db.correctionEvents = db.correctionEvents.slice(-200);
  const sourceStatus = db.sourceStatus?.[sourceId];
  if (sourceStatus) {
    sourceStatus.recordCount = db.observations.filter((row) => row.sourceId === sourceId).length;
    if (!sourceStatus.recordCount && sourceStatus.state === "snapshot_imported") sourceStatus.state = "corrected_empty";
  }
  return { retracted: true, observationsRemoved, priceEventsRemoved };
}

async function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireLock(lockPath) {
  const until = Date.now() + LOCK_WAIT_MS;
  while (true) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
      return handle;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (Date.now() >= until) throw new Error(`database is locked (${lockPath}); confirm no other market-ops process is running`);
      await delay(100);
    }
  }
}

export async function withDatabase(dataDir, work) {
  await mkdir(dataDir, { recursive: true });
  const dbPath = path.join(dataDir, "market-ops.json");
  const lockPath = path.join(dataDir, "market-ops.lock");
  const handle = await acquireLock(lockPath);
  try {
    let db;
    try {
      db = JSON.parse(await readFile(dbPath, "utf8"));
      assertDatabase(db);
    } catch (error) {
      if (error.code !== "ENOENT") throw new Error(`cannot read local database: ${error.message}`);
      db = emptyDatabase();
    }
    const result = await work(db);
    db.updatedAt = new Date().toISOString();
    assertDatabase(db);
    const tempPath = `${dbPath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      const temp = await open(tempPath, "wx", 0o600);
      try {
        await temp.writeFile(`${JSON.stringify(db, null, 2)}\n`, "utf8");
        await temp.sync();
      } finally {
        await temp.close();
      }
      await rename(tempPath, dbPath);
    } finally {
      await rm(tempPath, { force: true });
    }
    return result;
  } finally {
    await handle.close();
    await rm(lockPath, { force: true });
  }
}

function eventFor(previous, next, runId, ingestedAt, expiresAt) {
  const shared = {
    eventId: randomUUID(),
    listingKey: next.listingKey,
    sourceId: next.sourceId,
    runId,
    observedAt: next.observedAt,
    ingestedAt,
    expiresAt,
    kind: next.kind,
  };
  if (!previous) return { ...shared, type: "first_seen", before: null, after: { price: next.price, shippingPrice: next.shippingPrice, state: next.state, kind: next.kind, itemType: next.itemType, cardId: next.cardId } };
  const changes = [];
  if (previous.price !== next.price) changes.push("price_changed");
  if (previous.shippingPrice !== next.shippingPrice) changes.push("shipping_changed");
  if (previous.state !== next.state) changes.push("state_changed");
  if (previous.kind !== next.kind) changes.push("kind_changed");
  if (previous.itemType !== next.itemType || previous.cardId !== next.cardId) changes.push("scope_changed");
  return changes.map((type) => ({
    ...shared,
    eventId: randomUUID(),
    type,
    before: { price: previous.price, shippingPrice: previous.shippingPrice, state: previous.state, kind: previous.kind, itemType: previous.itemType, cardId: previous.cardId },
    after: { price: next.price, shippingPrice: next.shippingPrice, state: next.state, kind: next.kind, itemType: next.itemType, cardId: next.cardId },
  }));
}

export function applySnapshot(db, snapshot, runId, now = new Date(), reviewOrdinal = null) {
  const ingestedAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + snapshot.review.retentionDays * 86_400_000).toISOString();
  const ledgerId = reviewOrdinal == null ? `${runId}:${snapshot.source.id}` : `${runId}:${snapshot.source.id}:${reviewOrdinal}`;
  const contentSha256 = snapshot.contentSha256 ?? snapshot.inputSha256;
  const duplicateReview = db.reviewLedger.find((row) => row.sourceId === snapshot.source.id && (
    row.contentSha256 === contentSha256 || (!row.contentSha256 && row.inputSha256 === snapshot.inputSha256)
  ));
  if (duplicateReview) return { imported: 0, eventsAdded: 0, duplicate: true };

  for (const row of snapshot.observations) {
    const listingKey = `${snapshot.source.id}:${row.externalId}`;
    const previous = db.observations.find((item) => item.listingKey === listingKey);
    if (!previous) continue;
    const previousTime = Date.parse(previous.lastSeenAt);
    const nextTime = Date.parse(row.observedAt);
    if (nextTime < previousTime) throw new Error("snapshot contains an out-of-order observation timestamp; no records applied");
    const changedAtSameTime = nextTime === previousTime && ["price", "shippingPrice", "state", "kind", "itemType", "cardId"].some((field) => previous[field] !== row[field]);
    if (changedAtSameTime) throw new Error("snapshot contains a price or state conflict without a newer observation timestamp; no records applied");
  }
  db.reviewLedger.push({
    id: ledgerId,
    sourceId: snapshot.source.id,
    captureMethod: snapshot.captureMethod,
    reviewedAt: snapshot.review.reviewedAt,
    publicationBasis: snapshot.review.publicationBasis,
    publicationEvidenceRef: snapshot.review.publicationEvidenceRef,
    publicationAllowed: snapshot.review.publicationAllowed === true,
    termsReviewedAt: snapshot.review.termsReviewedAt,
    historyStorageAllowed: true,
    retentionDays: snapshot.review.retentionDays,
    coverage: snapshot.coverage,
    inputSha256: snapshot.inputSha256,
    contentSha256,
    importedAt: ingestedAt,
    expiresAt,
  });
  const changed = [];
  for (const row of snapshot.observations) {
    const listingKey = `${snapshot.source.id}:${row.externalId}`;
    const previous = db.observations.find((item) => item.listingKey === listingKey) ?? null;
    const hasNewSourceObservation = !previous || Date.parse(row.observedAt) > Date.parse(previous.lastSeenAt);
    const observationExpiresAt = hasNewSourceObservation ? expiresAt : previous.expiresAt ?? expiresAt;
    const next = {
      listingKey,
      sourceId: snapshot.source.id,
      externalId: row.externalId,
      url: row.url,
      itemType: row.itemType,
      cardId: row.cardId,
      kind: row.kind,
      state: row.state,
      matchLevel: row.matchLevel,
      matchNote: row.matchNote,
      price: row.price,
      shippingPrice: row.shippingPrice,
      ...(row.settlementEvidenceRef ? { settlementEvidenceRef: row.settlementEvidenceRef } : {}),
      firstSeenAt: previous?.firstSeenAt ?? row.observedAt,
      lastSeenAt: row.observedAt,
      ingestedAt,
      expiresAt: observationExpiresAt,
    };
    const createdEvents = eventFor(previous, next, runId, ingestedAt, observationExpiresAt);
    if (Array.isArray(createdEvents)) db.priceEvents.push(...createdEvents);
    else db.priceEvents.push(createdEvents);
    if (previous) db.observations.splice(db.observations.indexOf(previous), 1, next);
    else db.observations.push(next);
    changed.push({ listingKey, eventCount: Array.isArray(createdEvents) ? createdEvents.length : 1 });
  }
  const sourceExpiries = db.observations
    .filter((row) => row.sourceId === snapshot.source.id)
    .map((row) => row.expiresAt);
  const retentionUntil = sourceExpiries.length
    ? sourceExpiries.reduce((latest, value) => Date.parse(value) > Date.parse(latest) ? value : latest)
    : expiresAt;
  db.sourceStatus[snapshot.source.id] = {
    state: "snapshot_imported",
    lastAttemptAt: ingestedAt,
    lastSuccessAt: ingestedAt,
    lastRunId: runId,
    lastError: null,
    recordCount: snapshot.observations.length,
    retentionUntil,
    coverage: snapshot.coverage,
  };
  return {
    imported: snapshot.observations.length,
    eventsAdded: changed.reduce((sum, row) => sum + row.eventCount, 0),
    duplicate: false,
  };
}

export function applyPrivateObservation(db, observation, now = new Date()) {
  db.privateObservations ??= [];
  db.privatePriceEvents ??= [];
  const duplicate = db.privateObservations.find((row) => row.noteId === observation.noteId && row.evidence.sha256 === observation.evidence.sha256);
  if (duplicate) return { imported: false, duplicate: true, eventsAdded: 0 };
  const previous = [...db.privateObservations].reverse().find((row) => row.noteId === observation.noteId) ?? null;
  if (previous && previous.observedAt && observation.observedAt) {
    if (Date.parse(observation.observedAt) < Date.parse(previous.observedAt)) throw new Error("private observation is older than the last confirmed check; no note applied");
    if (observation.observedAt === previous.observedAt && (observation.price !== previous.price || observation.shippingPrice !== previous.shippingPrice)) {
      throw new Error("private observation has a price conflict at the same check time; no note applied");
    }
  }
  const recordedAt = now.toISOString();
  const current = { ...observation, recordedAt };
  db.privateObservations.push(current);
  const changes = [];
  const sameListing = Boolean(previous && previous.sourceUrl && previous.sourceUrl === current.sourceUrl);
  if (!previous) changes.push("baseline_recorded");
  else if (!sameListing) changes.push("candidate_observation_added");
  else {
    if (previous.price !== current.price) changes.push("asking_price_changed");
    if (previous.shippingPrice !== current.shippingPrice) changes.push("shipping_price_changed");
  }
  for (const type of changes) {
    db.privatePriceEvents.push({
      eventId: randomUUID(),
      noteId: current.noteId,
      sourceId: current.sourceId,
      type,
      before: previous ? { sourceUrl: previous.sourceUrl, price: previous.price, shippingPrice: previous.shippingPrice, observedAt: previous.observedAt } : null,
      after: { sourceUrl: current.sourceUrl, price: current.price, shippingPrice: current.shippingPrice, observedAt: current.observedAt },
      ...(sameListing && previous.price !== current.price ? {
        priceDelta: current.price - previous.price,
        priceChangePercent: Number((((current.price - previous.price) / previous.price) * 100).toFixed(2)),
      } : {}),
      ...(sameListing && previous.shippingPrice !== current.shippingPrice && previous.shippingPrice !== null && current.shippingPrice !== null
        ? { shippingDelta: current.shippingPrice - previous.shippingPrice }
        : {}),
      eventAt: current.observedAt ?? recordedAt,
      timeBasis: current.observedAt ? "operator_observed_at" : "recorded_at_observation_time_unknown",
      evidence: current.evidence,
    });
  }
  return { imported: true, duplicate: false, eventsAdded: changes.length };
}

export function pruneExpired(db, now = new Date()) {
  const current = now.getTime();
  const before = { observations: db.observations.length, priceEvents: db.priceEvents.length, reviewLedger: db.reviewLedger.length };
  const expiredKeys = new Set(db.observations.filter((row) => Date.parse(row.expiresAt) <= current).map((row) => row.listingKey));
  const expiredReviewIds = new Set(db.reviewLedger.filter((row) => Date.parse(row.expiresAt) <= current).map((row) => row.id));
  db.observations = db.observations.filter((row) => Date.parse(row.expiresAt) > current);
  db.priceEvents = db.priceEvents.filter((row) => Date.parse(row.expiresAt) > current && !expiredKeys.has(row.listingKey));
  db.reviewLedger = db.reviewLedger.filter((row) => !expiredReviewIds.has(row.id));
  const deleted = {
    observations: before.observations - db.observations.length,
    priceEvents: before.priceEvents - db.priceEvents.length,
    reviewLedger: before.reviewLedger - db.reviewLedger.length,
  };
  if (deleted.observations || deleted.priceEvents || deleted.reviewLedger) {
    db.retentionEvents.push({
      at: now.toISOString(),
      reason: "approved_retention_expired",
      deleted,
    });
    db.retentionEvents = db.retentionEvents.slice(-200);
  }
  for (const [sourceId, status] of Object.entries(db.sourceStatus)) {
    status.recordCount = db.observations.filter((row) => row.sourceId === sourceId).length;
    if (!status.recordCount && status.state === "snapshot_imported") status.state = "retention_expired";
  }
  return deleted;
}

export function recordRun(db, run) {
  db.runs.push(run);
  db.runs = db.runs.slice(-MAX_RUNS);
  for (const result of run.sources) {
    const prior = db.sourceStatus[result.sourceId] ?? {};
    db.sourceStatus[result.sourceId] = {
      ...prior,
      state: result.state,
      lastAttemptAt: run.startedAt,
      lastRunId: run.id,
      lastError: result.error ?? null,
      recordCount: db.observations.filter((row) => row.sourceId === result.sourceId).length,
    };
    if (["snapshot_imported", "collector_updated"].includes(result.state)) db.sourceStatus[result.sourceId].lastSuccessAt = run.finishedAt;
  }
}
