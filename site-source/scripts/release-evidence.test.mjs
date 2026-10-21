import test from "node:test";
import assert from "node:assert/strict";
import { evaluateReleaseEvidence, TARGET_SOURCES } from "./release-evidence.mjs";

const now = Date.parse("2026-10-21T00:00:00Z");
function fixture() {
  const runs = ["2026-10-19T00:00:00Z", "2026-10-20T00:00:00Z"].map((time, index) => ({ id: "scheduled-" + index, trigger: "scheduled_approved_collectors", startedAt: time, finishedAt: time, sources: TARGET_SOURCES.map((id) => ({ sourceId: id, state: "collector_updated" })) }));
  return {
    market: { sources: TARGET_SOURCES.map((id) => ({ id })), officialCatalog: { status: "verified", cards: [{ id: "synthetic-card" }] }, observations: ["bunjang", "break"].map((sourceId) => ({ cardId: "synthetic-card", kind: "asking", matchLevel: "exact", comparisonKey: "a".repeat(64), state: "active_asking", sourceId, checkedAt: "2026-10-20T00:00:00Z" })) },
    ops: { runs, sourceStatus: Object.fromEntries(TARGET_SOURCES.map((id) => [id, { state: "collector_updated", collectorConnected: true, lastCollectorSuccessAt: "2026-10-20T00:00:00Z" }])) },
  };
}

test("release evidence needs two distinct recent scheduled runs for every target platform", () => {
  const { market, ops } = fixture();
  assert.deepEqual(evaluateReleaseEvidence(market, ops, { now }).blockers, []);
  for (const change of [
    (copy) => { copy.runs[0].startedAt = copy.runs[0].finishedAt = "2026-09-01T00:00:00Z"; },
    (copy) => { copy.runs[0].startedAt = copy.runs[0].finishedAt = "2026-10-22T00:00:00Z"; },
    (copy) => { copy.runs[1].id = copy.runs[0].id; },
    (copy) => { copy.runs[1].finishedAt = copy.runs[1].startedAt = copy.runs[0].finishedAt; },
    (copy) => { copy.runs[1].sources.push({ ...copy.runs[1].sources[0] }); },
    (copy) => { copy.runs[1].trigger = "manual"; },
    (copy) => { copy.runs[1].startedAt = "2026-10-20T01:00:00Z"; },
  ]) {
    const modified = structuredClone(ops); change(modified);
    assert.ok(evaluateReleaseEvidence(market, modified, { now }).blockers.some((reason) => reason.includes("two distinct")));
  }
});

test("historical successes cannot conceal failed current collectors, stale data, or interrupted imports", () => {
  const { market, ops } = fixture();
  const failed = structuredClone(ops); failed.sourceStatus.bunjang.state = "failed";
  assert.ok(evaluateReleaseEvidence(market, failed, { now }).blockers.some((reason) => reason.includes("healthy automated")));
  const stale = structuredClone(market); stale.observations[0].checkedAt = "2026-09-01";
  assert.ok(evaluateReleaseEvidence(stale, ops, { now }).blockers.some((reason) => reason.includes("same-card")));
  assert.ok(evaluateReleaseEvidence(market, ops, { now, pendingImport: true }).blockers.some((reason) => reason.includes("interrupted")));
  assert.equal(evaluateReleaseEvidence({ sources: [], observations: [] }, null, { now }).connected.length, 0);
});

test("same card catalog ID with different serial, grade, or condition keys is not a cross-platform comparison", () => {
  const { market, ops } = fixture();
  market.observations[1].comparisonKey = "b".repeat(64);
  const result = evaluateReleaseEvidence(market, ops, { now });
  assert.equal(result.comparableCards, 0);
  assert.equal(result.freshComparableCards, 0);
  assert.ok(result.blockers.some((reason) => reason.includes("same-copy-condition")));
});
