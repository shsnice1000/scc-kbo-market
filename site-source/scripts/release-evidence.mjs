import { dateBounds } from "./review-policy.mjs";

export const TARGET_SOURCES = ["bunjang", "break", "wyyyes", "community", "kream", "daewon"];
const COLLECTED = new Set(["collector_updated", "collector_unchanged"]);
const WEEK = 7 * 86_400_000;

export function evaluateReleaseEvidence(market, ops, { now = Date.now(), pendingImport = false } = {}) {
  if (!Number.isFinite(now)) throw new Error("release evidence clock must be finite");
  const fresh = (value) => {
    const bounds = dateBounds(value);
    return Boolean(bounds && bounds[0] <= now && now - bounds[0] < WEEK);
  };
  const publicSources = new Set((market?.sources ?? []).map((source) => source.id));
  const connected = TARGET_SOURCES.filter((id) => ops?.sourceStatus?.[id]?.collectorConnected === true
    && COLLECTED.has(ops.sourceStatus[id].state) && fresh(ops.sourceStatus[id].lastCollectorSuccessAt));
  const scheduled = new Map(TARGET_SOURCES.map((id) => [id, []]));
  const idCounts = new Map();
  for (const run of ops?.runs ?? []) idCounts.set(run.id, (idCounts.get(run.id) ?? 0) + 1);
  const seenTimes = new Map(TARGET_SOURCES.map((id) => [id, new Set()]));
  for (const run of ops?.runs ?? []) {
    if (typeof run.id !== "string" || !run.id.trim() || idCounts.get(run.id) !== 1 || !String(run.trigger).startsWith("scheduled_")) continue;
    if (!fresh(run.finishedAt) || !dateBounds(run.startedAt) || run.startedAt.length === 10 || run.finishedAt.length === 10
      || Date.parse(run.startedAt) > Date.parse(run.finishedAt)) continue;
    const results = Array.isArray(run.sources) ? run.sources : [];
    for (const id of TARGET_SOURCES) {
      const matches = results.filter((result) => result.sourceId === id);
      const time = Date.parse(run.finishedAt);
      if (matches.length !== 1 || !COLLECTED.has(matches[0].state) || seenTimes.get(id).has(time)) continue;
      scheduled.get(id).push({ id: run.id, finishedAt: run.finishedAt });
      seenTimes.get(id).add(time);
    }
  }
  const twoSourceCards = new Map();
  for (const row of market?.observations ?? []) {
    if (row.kind !== "asking" || row.matchLevel !== "exact" || !row.cardId || !TARGET_SOURCES.includes(row.sourceId) || !["active_asking", "active_at_check"].includes(row.state)) continue;
    const sources = twoSourceCards.get(row.cardId) ?? new Map();
    sources.set(row.sourceId, [...(sources.get(row.sourceId) ?? []), row]);
    twoSourceCards.set(row.cardId, sources);
  }
  const groups = [...twoSourceCards.values()].filter((sources) => sources.size >= 2);
  const freshComparableCards = groups.filter((sources) => [...sources.values()].filter((rows) => rows.some((row) => fresh(row.checkedAt))).length >= 2).length;
  const scheduledTwice = TARGET_SOURCES.filter((id) => scheduled.get(id).length >= 2);
  const blockers = [];
  if (connected.length < TARGET_SOURCES.length) blockers.push(`currently healthy automated collectors ${connected.length}/${TARGET_SOURCES.length}`);
  const missing = TARGET_SOURCES.filter((id) => !publicSources.has(id));
  if (missing.length) blockers.push("public source status cards missing " + missing.join(", "));
  if (scheduledTwice.length < TARGET_SOURCES.length) blockers.push("two distinct successful scheduled refreshes within seven days per platform have not been recorded");
  if (!freshComparableCards) blockers.push("no fresh exact same-card asking-price comparison across two target platforms within seven days");
  if (market?.officialCatalog?.status !== "verified" || !market.officialCatalog.cards?.length) blockers.push("official verified card checklist is empty");
  if (pendingImport) blockers.push("an active or interrupted public import must finish or be recovered");
  return { connected, scheduled: Object.fromEntries(scheduled), scheduledTwice, comparableCards: groups.length, freshComparableCards, publicSourceCount: TARGET_SOURCES.filter((id) => publicSources.has(id)).length, blockers };
}
