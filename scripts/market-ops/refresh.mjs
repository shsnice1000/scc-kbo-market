import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { SOURCE_CATALOG, SOURCE_BY_ID } from "./catalog.mjs";
import { readReviewedSnapshot, validateSnapshot } from "./snapshot.mjs";
import { applySnapshot, pruneExpired, recordRun, withDatabase } from "./store.mjs";

const DEFAULT_COLLECTOR_TIMEOUT_MS = 60_000;
const MAX_COLLECTOR_TIMEOUT_MS = 15 * 60_000;
const MAX_SEGMENT_SNAPSHOTS_PER_BATCH = 24;

async function withRefreshLock(dataDir, work) {
  await mkdir(dataDir, { recursive: true });
  const lockPath = path.join(dataDir, "market-ops.refresh.lock");
  let handle;
  try {
    handle = await open(lockPath, "wx", 0o600);
  } catch (error) {
    if (error.code === "EEXIST") {
      throw new Error("another refresh is already running, or a previous run left its lock; confirm no market-ops process is active before removing the lock");
    }
    throw error;
  }

  const token = randomUUID();
  try {
    await handle.writeFile(JSON.stringify({ token, pid: process.pid, startedAt: new Date().toISOString() }));
    await handle.sync();
    return await work();
  } finally {
    await handle.close();
    let currentToken = null;
    try {
      currentToken = JSON.parse(await readFile(lockPath, "utf8")).token ?? null;
    } catch {
      // Keep an unreadable/replaced lock for an operator to inspect.
    }
    if (currentToken === token) await rm(lockPath);
  }
}

async function loadSnapshots(files, sourceStates = {}) {
  const bySource = new Map();
  const failures = new Map();
  const inputErrors = [];
  const previouslyProcessed = new Set();
  for (const file of files) {
    try {
      const snapshot = await readReviewedSnapshot(file);
      if (failures.has(snapshot.source.id)) continue;
      const feed = bunjangCatalogFeedMetadata(snapshot);
      const watermark = sourceStates[snapshot.source.id]?.lastCatalogFeed;
      if (feed && watermark) {
        const watermarkTime = Date.parse(watermark.generatedAt);
        if (!Number.isFinite(watermarkTime)) {
          failures.set(snapshot.source.id, "stored Bunjang catalog feed watermark is invalid; rebaseline from an approved Full catalog");
          continue;
        }
        if (feed.generatedAt < watermarkTime) {
          previouslyProcessed.add(snapshot.source.id);
          continue;
        }
        if (feed.generatedAt === watermarkTime) {
          if (feed.fileName !== watermark.fileName || feed.scopeLabel !== watermark.scopeLabel || snapshot.contentSha256 !== watermark.contentSha256) {
            failures.set(snapshot.source.id, "Bunjang catalog feed conflicts with the last processed feed at the same timestamp");
            continue;
          }
          previouslyProcessed.add(snapshot.source.id);
          continue;
        }
      }
      const group = bySource.get(snapshot.source.id) ?? [];
      group.push(snapshot);
      bySource.set(snapshot.source.id, group);
    } catch (error) {
      if (typeof error?.sourceId === "string" && SOURCE_BY_ID.has(error.sourceId)) failures.set(error.sourceId, error.message);
      else inputErrors.push(error.message);
    }
  }
  for (const [sourceId, snapshots] of bySource) {
    if (snapshots.length === 1) {
      const feed = bunjangCatalogFeedMetadata(snapshots[0]);
      const watermark = sourceStates[sourceId]?.lastCatalogFeed;
      if (!feed || !watermark) continue;
      if (feed.mode === "segment" && feed.scopeLabel !== watermark.scopeLabel) {
        failures.set(sourceId, "Bunjang query scope changed; import a Full catalog baseline before the new Segment scope");
        continue;
      }
      if (feed.mode === "segment" && feed.generatedAt - Date.parse(watermark.generatedAt) > 24 * 3_600_000) {
        failures.set(sourceId, "Bunjang segment batch has a gap over 24 hours; import a full catalog to rebaseline first");
      }
      continue;
    }
    if (snapshots.length < 2) continue;
    const feeds = snapshots.map(bunjangCatalogFeedMetadata);
    if (feeds.some((feed) => !feed)) {
      failures.set(sourceId, `multiple snapshots supplied for ${SOURCE_BY_ID.get(sourceId).name}; only Bunjang catalog feeds may be batched`);
      continue;
    }
    if (feeds.some((feed) => feed.scopeLabel !== feeds[0].scopeLabel)) {
      failures.set(sourceId, "Bunjang catalog batch contains different query scopes");
      continue;
    }
    const fullFeeds = feeds.filter((feed) => feed.mode === "full");
    const segments = feeds.filter((feed) => feed.mode === "segment");
    if (fullFeeds.length > 1 || (fullFeeds.length === 1 && segments.length === 0)) {
      failures.set(sourceId, "Bunjang catalog batch requires either segments only or one Full baseline followed by at least one Segment");
      continue;
    }
    if (segments.length > MAX_SEGMENT_SNAPSHOTS_PER_BATCH) {
      failures.set(sourceId, `Bunjang segment batch exceeds ${MAX_SEGMENT_SNAPSHOTS_PER_BATCH} feeds; use a full catalog to rebaseline a longer gap`);
      continue;
    }
    if (new Set(feeds.map((feed) => feed.fileName)).size !== feeds.length) {
      failures.set(sourceId, "Bunjang catalog batch contains a duplicate feed filename");
      continue;
    }
    const ordered = snapshots
      .map((snapshot, index) => ({ snapshot, ...feeds[index] }))
      .sort((left, right) => left.generatedAt - right.generatedAt);
    const orderedSegments = ordered.filter((feed) => feed.mode === "segment");
    if (orderedSegments.slice(1).some((segment, index) => segment.generatedAt - orderedSegments[index].generatedAt > 24 * 3_600_000)) {
      failures.set(sourceId, "Bunjang segment batch has a gap over 24 hours; import a full catalog to rebaseline first");
      continue;
    }
    if (fullFeeds.length && (ordered[0].mode !== "full"
      || orderedSegments[0].generatedAt <= fullFeeds[0].generatedAt
      || orderedSegments[0].generatedAt - fullFeeds[0].generatedAt > 24 * 3_600_000)) {
      failures.set(sourceId, "Bunjang Segment feeds must follow the Full baseline within 24 hours");
      continue;
    }
    const watermark = sourceStates[sourceId]?.lastCatalogFeed;
    if (watermark && !fullFeeds.length) {
      if (ordered[0].scopeLabel !== watermark.scopeLabel) {
        failures.set(sourceId, "Bunjang query scope changed; import a Full catalog baseline before the new Segment scope");
        continue;
      }
      if (orderedSegments[0].generatedAt - Date.parse(watermark.generatedAt) > 24 * 3_600_000) {
        failures.set(sourceId, "Bunjang segment batch has a gap over 24 hours; import a full catalog to rebaseline first");
        continue;
      }
    }
    bySource.set(sourceId, ordered.map(({ snapshot }) => snapshot));
  }
  for (const failedSource of failures.keys()) bySource.delete(failedSource);
  const unchanged = new Set([...previouslyProcessed].filter((sourceId) => !bySource.has(sourceId) && !failures.has(sourceId)));
  return { bySource, failures, inputErrors, unchanged };
}

function bunjangCatalogFeedMetadata(snapshot) {
  if (snapshot.source.id !== "bunjang" || snapshot.captureMethod !== "authorized_api") return null;
  const match = /^Bunjang (full|segment) catalog ((?:full-\d{8}|segment-\d{8}_\d{2})\.csv\.gz) candidate scan: (.+)$/.exec(snapshot.coverage.scope);
  if (!match) return null;
  const [, mode, fileName, scopeLabel] = match;
  if ((mode === "full" && snapshot.coverage.level !== "complete_scope")
    || (mode === "segment" && snapshot.coverage.level !== "partial_scan")) return null;
  const dateParts = mode === "full"
    ? /^full-(\d{4})(\d{2})(\d{2})\.csv\.gz$/.exec(fileName)
    : /^segment-(\d{4})(\d{2})(\d{2})_(\d{2})\.csv\.gz$/.exec(fileName);
  const [, year, month, day, hour = "03"] = dateParts;
  const calendar = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (Number(month) < 1 || Number(month) > 12 || Number(day) < 1 || Number(day) > 31 || Number(hour) > 23
    || calendar.getUTCFullYear() !== Number(year) || calendar.getUTCMonth() !== Number(month) - 1 || calendar.getUTCDate() !== Number(day)) return null;
  const generatedAt = mode === "full"
    ? Date.parse(`${year}-${month}-${day}T03:30:00+09:00`)
    : Date.parse(`${year}-${month}-${day}T${hour}:10:00+09:00`);
  return { mode, fileName, scopeLabel, generatedAt };
}

function catalogBatchSummary(snapshots, previousWatermark = null) {
  const feeds = snapshots.map(bunjangCatalogFeedMetadata);
  const full = feeds.find((feed) => feed.mode === "full") ?? null;
  const segments = feeds.filter((feed) => feed.mode === "segment");
  const segmentTimes = segments.map((segment) => segment.generatedAt);
  if (!full && previousWatermark && segmentTimes[0] > Date.parse(previousWatermark.generatedAt)) {
    segmentTimes.unshift(Date.parse(previousWatermark.generatedAt));
  }
  const missingIntervals = segmentTimes.slice(1).reduce((sum, time, index) => {
    return sum + Math.max(0, Math.round((time - segmentTimes[index]) / 3_600_000) - 1);
  }, 0);
  return {
    count: feeds.length,
    kind: full ? "full_plus_segments" : "segments_only",
    ...(full ? { fullFeed: full.fileName } : {}),
    ...(!full && previousWatermark ? { previousFeed: previousWatermark.fileName } : {}),
    firstSegment: segments[0].fileName,
    lastSegment: segments.at(-1).fileName,
    missingIntervals,
  };
}

function updateCatalogWatermark(db, snapshot) {
  const feed = bunjangCatalogFeedMetadata(snapshot);
  if (!feed) return;
  db.sourceStatus[snapshot.source.id] = {
    ...db.sourceStatus[snapshot.source.id],
    lastCatalogFeed: {
      fileName: feed.fileName,
      generatedAt: new Date(feed.generatedAt).toISOString(),
      scopeLabel: feed.scopeLabel,
      contentSha256: snapshot.contentSha256,
    },
  };
}

function applySnapshotBatch(db, snapshots, runId, now) {
  if (snapshots.length === 1) {
    const result = applySnapshot(db, snapshots[0], runId, now);
    updateCatalogWatermark(db, snapshots[0]);
    return { ...result, snapshotCount: 1 };
  }
  const draft = JSON.parse(JSON.stringify(db));
  const results = snapshots.map((snapshot, index) => applySnapshot(draft, snapshot, runId, now, index + 1));
  if (results.some((item) => !item.duplicate)) draft.sourceStatus[snapshots[0].source.id].coverage = snapshots.at(-1).coverage;
  updateCatalogWatermark(draft, snapshots.at(-1));
  for (const key of Object.keys(db)) delete db[key];
  Object.assign(db, draft);
  return {
    imported: results.reduce((sum, item) => sum + item.imported, 0),
    eventsAdded: results.reduce((sum, item) => sum + item.eventsAdded, 0),
    suppressed: results.reduce((sum, item) => sum + (item.suppressed ?? 0), 0),
    duplicate: results.every((item) => item.duplicate),
    snapshotCount: snapshots.length,
  };
}

function getCollector(collectors, sourceId) {
  return collectors instanceof Map ? collectors.get(sourceId) : collectors?.[sourceId];
}

async function collectOne(source, collector, since, now, timeoutMs) {
  const controller = new AbortController();
  let timer;
  let timeoutError;
  try {
    let raw;
    try {
      raw = await Promise.race([
        Promise.resolve().then(() => collector({ source, since, signal: controller.signal, now })),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            timeoutError = new Error(`collector timed out after ${timeoutMs} ms`);
            controller.abort();
            reject(timeoutError);
          }, timeoutMs);
        }),
      ]);
    } catch (error) {
      if (timeoutError) throw timeoutError;
      throw error;
    }
    const input = raw && typeof raw === "object" && Object.hasOwn(raw, "snapshot") ? raw.snapshot : raw;
    const snapshot = validateSnapshot(input, now.getTime());
    if (snapshot.source.id !== source.id) throw new Error(`collector returned source ${snapshot.source.id}; expected ${source.id}`);
    return snapshot;
  } finally {
    clearTimeout(timer);
  }
}

function collectorError(error) {
  if (/^collector timed out after \d+ ms$/.test(error?.message ?? "")) return error.message;
  if (error?.name === "AbortError") return "collector was aborted";
  const code = typeof error?.code === "string" && /^[A-Z0-9_]{1,30}$/.test(error.code) ? error.code : "adapter_error";
  return `collector failed (${code}); detailed response text suppressed`;
}

export async function runRefresh(options) {
  if (!options || typeof options.dataDir !== "string" || !options.dataDir) throw new Error("runRefresh requires a dataDir");
  return withRefreshLock(options.dataDir, () => runRefreshLocked(options));
}

async function runRefreshLocked({ dataDir, snapshotFiles = [], collectors = {}, collectorTimeoutMs = DEFAULT_COLLECTOR_TIMEOUT_MS, now = new Date(), runOrigin = "manual" }) {
  if (!Number.isInteger(collectorTimeoutMs) || collectorTimeoutMs < 1 || collectorTimeoutMs > MAX_COLLECTOR_TIMEOUT_MS) {
    throw new Error(`collectorTimeoutMs must be an integer from 1 to ${MAX_COLLECTOR_TIMEOUT_MS}`);
  }
  if (!new Set(["manual", "scheduled"]).has(runOrigin)) throw new Error("runOrigin must be manual or scheduled");
  const startedAt = now.toISOString();
  const runId = `run-${startedAt.replace(/[-:.TZ]/g, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`;
  const priorState = await withDatabase(dataDir, async (db) => {
    const pruned = pruneExpired(db, now);
    return {
      pruned,
      sources: Object.fromEntries(SOURCE_CATALOG.map((source) => [source.id, {
        since: db.sourceStatus[source.id]?.lastSuccessAt ?? null,
        coverage: db.sourceStatus[source.id]?.coverage ?? null,
        lastCatalogFeed: db.sourceStatus[source.id]?.lastCatalogFeed ?? null,
      }])),
    };
  });
  const { bySource, failures, inputErrors, unchanged } = await loadSnapshots(snapshotFiles, priorState.sources);
  const sourceStates = priorState.sources;
  const collected = await Promise.all(SOURCE_CATALOG.map(async (source) => {
    if (bySource.has(source.id) || failures.has(source.id) || unchanged.has(source.id)) return { sourceId: source.id, snapshot: null, error: null };
    const collector = getCollector(collectors, source.id);
    if (typeof collector !== "function") return { sourceId: source.id, snapshot: null, error: null };
    try {
      const result = await collectOne(source, collector, sourceStates[source.id].since, now, collectorTimeoutMs);
      return { sourceId: source.id, snapshot: result, error: null };
    } catch (error) {
      return { sourceId: source.id, snapshot: null, error: collectorError(error) };
    }
  }));
  const collectorSnapshots = new Map(collected.filter((item) => item.snapshot).map((item) => [item.sourceId, item.snapshot]));
  const collectorFailures = new Map(collected.filter((item) => item.error).map((item) => [item.sourceId, item.error]));
  const hasConfiguredCollectors = SOURCE_CATALOG.some((source) => typeof getCollector(collectors, source.id) === "function");
  const sources = [];
  const outcomes = await withDatabase(dataDir, async (db) => {
    const prunedAfterCollection = pruneExpired(db, now);
    const pruned = Object.fromEntries(["observations", "priceEvents", "reviewLedger"].map((key) => [key, priorState.pruned[key] + prunedAfterCollection[key]]));
    for (const source of SOURCE_CATALOG) {
      const fileSnapshots = bySource.get(source.id);
      const collectorSnapshot = collectorSnapshots.get(source.id);
      const snapshots = fileSnapshots ?? (collectorSnapshot ? [collectorSnapshot] : null);
      if (snapshots) {
        try {
          const imported = applySnapshotBatch(db, snapshots, runId, now);
          const lastSnapshot = snapshots.at(-1);
          const priorFeedWatermark = sourceStates[source.id].lastCatalogFeed;
          const catalogFeed = bunjangCatalogFeedMetadata(lastSnapshot);
          const snapshotBatch = imported.snapshotCount > 1 || (!imported.duplicate && catalogFeed?.mode === "segment" && priorFeedWatermark)
            ? catalogBatchSummary(snapshots, priorFeedWatermark)
            : null;
          const state = imported.duplicate
            ? fileSnapshots ? "snapshot_unchanged" : "collector_unchanged"
            : fileSnapshots ? "snapshot_imported" : "collector_updated";
          if (!fileSnapshots) {
            const status = db.sourceStatus[source.id];
            status.state = state;
            status.lastAttemptAt = now.toISOString();
            status.lastSuccessAt = now.toISOString();
            status.lastRunId = runId;
            status.lastError = null;
            status.recordCount = db.observations.filter((row) => row.sourceId === source.id).length;
            status.coverage = lastSnapshot.coverage;
            status.collectorConnected = true;
            status.lastCollectorSuccessAt = now.toISOString();
          }
          sources.push({
            sourceId: source.id,
            state,
            imported: imported.imported,
            eventsAdded: imported.eventsAdded,
            suppressed: imported.suppressed ?? 0,
            coverage: lastSnapshot.coverage,
            ...(snapshotBatch ? { snapshotBatch } : {}),
            error: null,
            route: fileSnapshots ? "reviewed_snapshot" : "approved_collector",
          });
        } catch (error) {
          sources.push({ sourceId: source.id, state: "failed", imported: 0, eventsAdded: 0, error: error.message, route: fileSnapshots ? "reviewed_snapshot" : "approved_collector" });
        }
      } else {
        if (unchanged.has(source.id)) {
          sources.push({ sourceId: source.id, state: "snapshot_unchanged", imported: 0, eventsAdded: 0, ...(sourceStates[source.id].coverage ? { coverage: sourceStates[source.id].coverage } : {}), error: null, route: "reviewed_snapshot" });
          continue;
        }
        const matchingFailure = failures.get(source.id) ?? collectorFailures.get(source.id) ?? null;
        const route = source.route;
        const error = matchingFailure ?? source.blocker;
        const status = db.sourceStatus[source.id];
        status.state = matchingFailure ? "failed" : "blocked";
        status.lastAttemptAt = now.toISOString();
        status.lastRunId = runId;
        status.lastError = error;
        sources.push({
          sourceId: source.id,
          state: matchingFailure ? "failed" : "blocked",
          imported: 0,
          eventsAdded: 0,
          error,
          route,
        });
      }
    }
    const updatedCount = sources.filter((item) => ["snapshot_imported", "collector_updated"].includes(item.state)).length;
    const completedCount = sources.filter((item) => ["snapshot_imported", "collector_updated", "snapshot_unchanged", "collector_unchanged"].includes(item.state)).length;
    const manualTrigger = snapshotFiles.length && hasConfiguredCollectors
      ? "reviewed_snapshot_and_collectors"
      : snapshotFiles.length
        ? "reviewed_snapshots"
        : hasConfiguredCollectors
          ? "approved_collectors"
          : "source_status_check";
    const run = {
      id: runId,
      startedAt,
      finishedAt: new Date().toISOString(),
      trigger: runOrigin === "scheduled" ? `scheduled_${manualTrigger}` : manualTrigger,
      state: sources.some((item) => item.state === "failed") || inputErrors.length
        ? "partial_failure"
        : completedCount === 0
          ? "blocked"
          : completedCount === sources.length
            ? "success"
            : "partial_success",
      sources,
      inputErrors,
      pruned,
    };
    recordRun(db, run);
    return { run, pruned };
  });
  return outcomes;
}

export async function runIngest({ dataDir, snapshotFile }) {
  return runRefresh({ dataDir, snapshotFiles: [snapshotFile] });
}

export function sourceLabel(sourceId) {
  return SOURCE_BY_ID.get(sourceId)?.name ?? sourceId;
}
