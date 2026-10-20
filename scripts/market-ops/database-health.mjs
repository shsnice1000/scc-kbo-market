import { lstat } from "node:fs/promises";
import path from "node:path";
import { readDatabase } from "./store.mjs";
import { refreshExitCode } from "./run-outcome.mjs";

export async function databaseHealth(dataDir, { now = Date.now(), maxAgeMs = 24 * 3_600_000 } = {}) {
  if (!Number.isFinite(now) || !Number.isFinite(maxAgeMs) || maxAgeMs <= 0) throw new Error("invalid health clock or freshness window");
  const locks = [];
  for (const name of ["market-ops.lock", "market-ops.refresh.lock"]) {
    try { await lstat(path.join(dataDir, name)); locks.push(name); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  const db = await readDatabase(dataDir);
  if (!db) return { scope: "local_read_only", state: "not_initialized", exitCode: 2, lockCount: locks.length };
  const latest = db.runs.at(-1) ?? null;
  const timestamp = Date.parse(latest?.finishedAt ?? "");
  const fresh = Number.isFinite(timestamp) && timestamp <= now && now - timestamp < maxAgeMs;
  const exitCode = locks.length ? 2 : !latest || !fresh ? 2 : refreshExitCode(latest);
  return {
    scope: "local_read_only", state: locks.length ? "busy_or_interrupted" : !latest ? "no_runs" : !fresh ? "stale_or_invalid_run" : latest.state,
    exitCode, lockCount: locks.length, latestRunId: latest?.id ?? null, latestFinishedAt: latest?.finishedAt ?? null,
    observationCount: db.observations.length, priceEventCount: db.priceEvents.length,
    privateObservationCount: db.privateObservations.length,
    activeSuppressionCount: Object.values(db.listingSuppressions).filter((entry) => entry.active !== false).length,
    sources: Object.fromEntries(Object.entries(db.sourceStatus).map(([id, status]) => [id, { state: status.state, collectorConnected: status.collectorConnected === true, recordCount: status.recordCount ?? 0, lastCollectorSuccessAt: status.lastCollectorSuccessAt ?? null }])),
  };
}
