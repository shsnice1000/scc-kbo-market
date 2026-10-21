import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { emptyDatabase, applySnapshot, retractObservation, restoreSuppressedListing, withDatabase, readDatabase, pruneExpired } from "./store.mjs";
import { refreshExitCode } from "./run-outcome.mjs";
import { databaseHealth } from "./database-health.mjs";

const now = new Date("2026-10-21T00:00:00Z");
function normalized(time, price = 1000) {
  return { source: { id: "bunjang" }, captureMethod: "manual_public_page", inputSha256: time + price,
    review: { retentionDays: 1, reviewedAt: time, publicationBasis: "written_permission", publicationEvidenceRef: "permission-001", termsReviewedAt: time },
    observations: [{ externalId: "101", url: "https://m.bunjang.co.kr/products/101", itemType: "single_card", cardId: "synthetic-card", kind: "asking", state: "active_asking", matchLevel: "candidate", matchNote: "Synthetic fixture", price, shippingPrice: null, observedAt: time }],
  };
}
function temporary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scc-lifecycle-"));
  t.after(() => { assert.equal(path.dirname(dir), path.resolve(os.tmpdir())); assert.ok(path.basename(dir).startsWith("scc-lifecycle-")); fs.rmSync(dir, { recursive: true, force: true }); });
  return dir;
}

test("withdrawal stays suppressed across changed snapshots and retention until explicit reviewed restoration", () => {
  const db = emptyDatabase(now.toISOString());
  applySnapshot(db, normalized("2026-10-20T00:00:00Z"), "initial", now);
  retractObservation(db, "bunjang", "101", "source_permission_withdrawn", "withdrawal-001", now);
  const second = applySnapshot(db, normalized("2026-10-20T12:00:00Z", 2000), "changed", now);
  assert.equal(second.suppressed, 1);
  assert.equal(second.imported, 0);
  assert.equal(db.observations.length, 0);
  assert.equal(db.priceEvents.length, 0);
  pruneExpired(db, new Date("2026-10-25T00:00:00Z"));
  assert.equal(db.listingSuppressions["bunjang:101"].active, true);
  assert.equal(restoreSuppressedListing(db, "bunjang", "101", "new-permission-001", "market_reviewer", now).restored, true);
  assert.equal(applySnapshot(db, normalized("2026-10-20T18:00:00Z", 3000), "stale-after-restore", now).suppressed, 1);
  const fresh = applySnapshot(db, normalized("2026-10-21T01:00:00Z", 4000), "fresh-after-restore", new Date("2026-10-21T02:00:00Z"));
  assert.equal(fresh.imported, 1);
  assert.equal(db.observations[0].price, 4000);
  assert.equal(db.correctionEvents.at(-1).action, "restore");
});

test("withdrawal before first import and legacy correction migration both prevent re-entry", async (t) => {
  const db = emptyDatabase(now.toISOString());
  retractObservation(db, "bunjang", "101", "source_request", "request-001", now);
  assert.equal(applySnapshot(db, normalized("2026-10-21T01:00:00Z"), "later", now).suppressed, 1);
  const dir = temporary(t), legacy = emptyDatabase();
  delete legacy.listingSuppressions;
  legacy.correctionEvents.push({ listingKey: "bunjang:101", at: now.toISOString(), reasonCode: "incorrect_price", evidenceRef: "correction-001" });
  fs.writeFileSync(path.join(dir, "market-ops.json"), JSON.stringify(legacy));
  await withDatabase(dir, async (loaded) => {
    assert.equal(applySnapshot(loaded, normalized("2026-10-21T01:00:00Z"), "legacy", now).suppressed, 1);
  });
  assert.equal((await readDatabase(dir)).listingSuppressions["bunjang:101"].active, true);
});

test("refresh exit codes distinguish a configured working subset, failed inputs, and all-blocked runs", () => {
  assert.equal(refreshExitCode({ state: "partial_success", sources: [{ state: "collector_updated" }, { state: "blocked" }] }), 0);
  assert.equal(refreshExitCode({ state: "success", sources: [{ state: "collector_unchanged" }] }), 0);
  assert.equal(refreshExitCode({ state: "partial_failure", sources: [{ state: "collector_updated" }, { state: "failed" }] }), 1);
  assert.equal(refreshExitCode({ state: "success", sources: [{ state: "collector_updated" }], inputErrors: ["invalid JSON"] }), 1);
  assert.equal(refreshExitCode({ state: "blocked", sources: [{ state: "blocked" }] }), 2);
});

test("health is read-only, reports stale/blocked/locked states, and never prunes expired records", async (t) => {
  const dir = temporary(t);
  assert.equal((await databaseHealth(dir, { now: now.getTime() })).state, "not_initialized");
  assert.deepEqual(fs.readdirSync(dir), []);
  const db = emptyDatabase(now.toISOString());
  db.observations.push({ expiresAt: "2020-01-01T00:00:00Z", price: 12345 });
  db.runs.push({ id: "synthetic-run", finishedAt: now.toISOString(), state: "blocked", sources: [{ state: "blocked" }] });
  const file = path.join(dir, "market-ops.json"); fs.writeFileSync(file, JSON.stringify(db));
  const before = fs.readFileSync(file), modifiedAt = fs.statSync(file).mtimeMs;
  const health = await databaseHealth(dir, { now: now.getTime() });
  assert.equal(health.exitCode, 2); assert.equal(health.observationCount, 1);
  assert.equal(JSON.stringify(health).includes("12345"), false);
  assert.equal((await databaseHealth(dir, { now: now.getTime() + 2 * 86_400_000 })).state, "stale_or_invalid_run");
  fs.writeFileSync(path.join(dir, "market-ops.refresh.lock"), "{}");
  assert.equal((await databaseHealth(dir, { now: now.getTime() })).state, "busy_or_interrupted");
  assert.ok(before.equals(fs.readFileSync(file))); assert.equal(fs.statSync(file).mtimeMs, modifiedAt);
});
