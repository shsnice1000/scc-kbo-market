import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = path.resolve(root, "..");
const opsDbPath = path.join(workspaceRoot, ".ops-private", "market-ops", "market-ops.json");
const targetSourceIds = ["bunjang", "break", "wyyyes", "community", "kream", "daewon"];
const validators = [
  "validate-market.mjs",
  "validate-review-ledger.mjs",
  "validate-catalog-ledger.mjs",
  "validate-static-dist.mjs",
  "validate-worker.mjs",
];
let validatorFailures = 0;

console.log("SCC Market release readiness (read-only; no network, commit, push, or deployment)\n");
for (const validator of validators) {
  try {
    const output = execFileSync(process.execPath, [path.join(root, "scripts", validator)], {
      cwd: root,
      encoding: "utf8",
      timeout: 30_000,
      windowsHide: true,
    }).trim();
    console.log(`[PASS] ${validator}${output ? `\n${output.split("\n").map((line) => `       ${line}`).join("\n")}` : ""}`);
  } catch (error) {
    validatorFailures += 1;
    const output = [error.stdout, error.stderr, error.message].filter(Boolean).join("\n").trim();
    console.log(`[FAIL] ${validator}\n${output.split("\n").map((line) => `       ${line}`).join("\n")}`);
  }
}

const market = JSON.parse(await readFile(path.join(root, "data", "market.json"), "utf8"));
let ops = null;
try { ops = JSON.parse(await readFile(opsDbPath, "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; }
const publicSourceIds = new Set(market.sources.map((source) => source.id));
const sourceIds = targetSourceIds;
const successfulCollectorStates = new Set(["collector_updated", "collector_unchanged"]);
const historicalCollectorSuccesses = new Set((ops?.runs ?? []).flatMap((run) => (run.sources ?? [])
  .filter((result) => successfulCollectorStates.has(result.state))
  .map((result) => result.sourceId)));
const connected = sourceIds.filter((sourceId) => ops?.sourceStatus?.[sourceId]?.collectorConnected === true
  || successfulCollectorStates.has(ops?.sourceStatus?.[sourceId]?.state)
  || historicalCollectorSuccesses.has(sourceId));
const scheduledSuccesses = new Map(sourceIds.map((sourceId) => [sourceId, 0]));
const latestScheduledAt = new Map(sourceIds.map((sourceId) => [sourceId, null]));
for (const run of ops?.runs ?? []) {
  if (!String(run.trigger || "").startsWith("scheduled")) continue;
  for (const result of run.sources ?? []) {
    if (successfulCollectorStates.has(result.state) && scheduledSuccesses.has(result.sourceId)) {
      scheduledSuccesses.set(result.sourceId, scheduledSuccesses.get(result.sourceId) + 1);
      const finishedAt = run.finishedAt ?? null;
      if (finishedAt && (!latestScheduledAt.get(result.sourceId) || finishedAt > latestScheduledAt.get(result.sourceId))) {
        latestScheduledAt.set(result.sourceId, finishedAt);
      }
    }
  }
}
const twoSourceCards = new Map();
for (const row of market.observations) {
  if (row.kind !== "asking" || row.matchLevel !== "exact" || !row.cardId || !["active_asking", "active_at_check"].includes(row.state)) continue;
  const sourceRecords = twoSourceCards.get(row.cardId) ?? new Map();
  const rows = sourceRecords.get(row.sourceId) ?? [];
  rows.push(row);
  sourceRecords.set(row.sourceId, rows);
  twoSourceCards.set(row.cardId, sourceRecords);
}
const comparableCardGroups = [...twoSourceCards.values()].filter((sourceRecords) => sourceRecords.size >= 2);
const comparableCards = comparableCardGroups.length;
const now = Date.now();
const weekMs = 7 * 86_400_000;
const freshWithinWeek = (timestamp) => Number.isFinite(timestamp) && timestamp <= now && now - timestamp < weekMs;
const freshComparableCards = comparableCardGroups.filter((sourceRecords) => {
  const freshestBySource = [...sourceRecords.values()].map((rows) => Math.max(...rows.map((row) => Date.parse(row.checkedAt || ""))));
  return freshestBySource.filter(freshWithinWeek).length >= 2;
}).length;
const allScheduledTwice = sourceIds.every((sourceId) => scheduledSuccesses.get(sourceId) >= 2);
const allSchedulesRecent = sourceIds.every((sourceId) => {
  const timestamp = Date.parse(latestScheduledAt.get(sourceId) || "");
  return freshWithinWeek(timestamp);
});
const blockers = [];
if (connected.length < sourceIds.length) blockers.push(`automated collectors connected ${connected.length}/${sourceIds.length}`);
if (sourceIds.some((sourceId) => !publicSourceIds.has(sourceId))) blockers.push(`public source status cards missing ${sourceIds.filter((sourceId) => !publicSourceIds.has(sourceId)).join(", ")}`);
if (!allScheduledTwice) blockers.push("two successful scheduled refreshes per platform have not been recorded");
if (!allSchedulesRecent) blockers.push("latest scheduled refresh is older than seven days or missing for one or more platforms");
if (!comparableCards) blockers.push("no exact same-card asking-price comparison across two platforms");
else if (!freshComparableCards) blockers.push("exact same-card comparison records across two platforms are older than seven days or missing a check date");
if (!market.officialCatalog?.cards?.length) blockers.push("official verified card checklist is empty");
if (validatorFailures) blockers.push(`${validatorFailures} static integrity validator(s) failed`);

console.log(`\nData readiness: ${market.officialCatalog?.cards?.length ?? 0} official cards, ${market.observations.length} public observations, ${publicSourceIds.size}/${sourceIds.length} public source status cards, ${connected.length}/${sourceIds.length} automated collectors, ${comparableCards} exact two-platform comparison card(s) (${freshComparableCards} fresh within seven days).`);
console.log(`Scheduled refresh evidence: ${sourceIds.filter((sourceId) => scheduledSuccesses.get(sourceId) >= 2).length}/${sourceIds.length} platforms have two successful scheduled runs.`);
console.log(`Recent scheduled refresh evidence: ${sourceIds.filter((sourceId) => freshWithinWeek(Date.parse(latestScheduledAt.get(sourceId) || ""))).length}/${sourceIds.length} platforms updated within seven days.`);
if (blockers.length) {
  console.log("\n[BLOCKED] Full six-platform comparison release is not ready:");
  for (const blocker of blockers) console.log(`  - ${blocker}`);
  process.exitCode = validatorFailures ? 1 : 2;
} else {
  console.log("\n[READY] Static integrity and six-platform release evidence meet the current gate.");
}
