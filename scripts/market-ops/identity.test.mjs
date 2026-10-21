import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { normalizeIdentityV2, buildMatchReviewTemplateV2, compareIdentities, crossListingSuspicions, reviewIdentityCaseV2 } from "./identity.mjs";
import { emptyReviewQueue, upsertReviewCase, recordMatchDecision, summarizeReviewQueue, updateReviewQueue, readReviewQueue } from "./review-queue.mjs";

function identity(overrides = {}) {
  return { year: 2026, product: "SCC SENSATION", player: "Synthetic Player", team: "NC Dinos", checklistCardId: "SCC-26/N06", printedCardCode: "SCC-26/N06", jerseyNumber: 7, category: "patch", parallel: "standard", autograph: "none", relic: "patch", serialLimit: 33, serialNumber: 7, gradingStatus: "raw", gradingCompany: null, grade: null, condition: "raw_near_mint", ...overrides };
}
function matchCase(overrides = {}) {
  return { schemaVersion: 2, caseId: "synthetic-001", itemType: "single_card", catalogIdentity: identity(), listingIdentity: identity(), ...overrides };
}
function queueInput(overrides = {}) {
  return { schemaVersion: 1, inventoryOrigin: "independent_market", sourceId: "bunjang", externalId: "101", url: "https://m.bunjang.co.kr/products/101", evidenceRefs: ["synthetic:source-check:001"], matchCase: matchCase(), ...overrides };
}

test("v2 distinguishes official card codes from jersey numbers and permits only reviewed aliases", () => {
  const a = normalizeIdentityV2(identity());
  const b = normalizeIdentityV2(identity({ product: "2026 KBO LEAGUE SENSATION", team: "NC 다이노스" }));
  assert.deepEqual(a, b);
  assert.throws(() => normalizeIdentityV2(identity({ checklistCardId: "7" })), /official row code/);
  assert.throws(() => normalizeIdentityV2(identity({ team: "두산", checklistCardId: "SCC-26/N06" })), /team prefix/);
  assert.throws(() => normalizeIdentityV2(identity({ year: 2025 })), /year conflicts/);
  assert.equal(compareIdentities(identity(), identity({ checklistCardId: null })).decision, "needs_review");
  assert.equal(compareIdentities(identity(), identity({ jerseyNumber: 8 })).decision, "conflict");
  assert.equal(compareIdentities(identity(), identity({ printedCardCode: "SCC-26/JP" })).decision, "exact_identity");
});

test("unknown variant, grading and condition values cannot become a price comparison", () => {
  for (const field of ["category", "parallel", "autograph", "relic", "checklistCardId"]) {
    assert.equal(compareIdentities(identity(), identity({ [field]: null })).decision, "needs_review");
  }
  assert.equal(compareIdentities(identity(), identity({ parallel: "unspecified" })).decision, "needs_review");
  const unknownGrade = compareIdentities(identity({ gradingStatus: null }), identity({ gradingStatus: null }));
  assert.equal(unknownGrade.matchLevel, "exact");
  assert.equal(unknownGrade.identityComparable, false);
  assert.ok(unknownGrade.comparisonBlockers.includes("grading_status_unconfirmed"));
  assert.equal(compareIdentities(identity(), identity({ condition: "unassessed" })).identityComparable, false);
  assert.throws(() => normalizeIdentityV2(identity({ autograph: true })), /short string/);
  assert.throws(() => normalizeIdentityV2(identity({ category: "on_card_autograph", autograph: "sticker" })), /sticker/);
});

test("same printing and physical-copy comparison are separate, with serial traits preserved", () => {
  const exact = compareIdentities(identity(), identity());
  assert.equal(exact.identityComparable, true);
  assert.ok(exact.comparisonKey);
  assert.deepEqual(exact.serialTraits.catalog, ["jersey_number"]);
  const differentSerial = compareIdentities(identity(), identity({ serialNumber: 8 }));
  assert.equal(differentSerial.matchLevel, "exact");
  assert.equal(differentSerial.printIdentityKey, exact.printIdentityKey);
  assert.equal(differentSerial.comparisonKey, null);
  assert.ok(differentSerial.comparisonBlockers.includes("different_serial_numbers"));
  assert.equal(compareIdentities(identity(), identity({ serialNumber: null })).identityComparable, false);
  assert.equal(compareIdentities(identity(), identity({ gradingStatus: "graded", gradingCompany: "PSA", grade: "10" })).identityComparable, false);
  assert.deepEqual(compareIdentities(identity({ serialNumber: 1 }), identity({ serialNumber: 1 })).serialTraits.listing, ["first_number"]);
  assert.deepEqual(compareIdentities(identity({ serialNumber: 33 }), identity({ serialNumber: 33 })).serialTraits.listing, ["last_number"]);
  assert.equal(compareIdentities(identity({ serialLimit: 0, serialNumber: null }), identity({ serialLimit: 0, serialNumber: null })).identityComparable, true);
});

test("lots, choice listings, raw source content and incomplete templates stay outside exact matching", () => {
  for (const itemType of ["lot", "choice_listing", "sealed_pack", "sealed_box"]) {
    assert.equal(reviewIdentityCaseV2(matchCase({ itemType })).decision, "excluded_item_type");
  }
  assert.throws(() => reviewIdentityCaseV2(matchCase({ title: "raw source body" })), /unsupported field/);
  assert.throws(() => normalizeIdentityV2(identity({ sellerId: "seller" })), /unsupported field/);
  assert.equal(reviewIdentityCaseV2(buildMatchReviewTemplateV2("template-1")).decision, "needs_review");
});

test("cross-platform duplicate suspicion requires a complete printing identity and same full serial", () => {
  const rows = [
    { sourceId: "bunjang", externalId: "101", itemType: "single_card", identity: identity() },
    { sourceId: "wyyyes", externalId: "202", itemType: "single_card", identity: identity() },
    { sourceId: "break", externalId: "303", itemType: "single_card", identity: identity({ serialNumber: 8 }) },
  ];
  const suspects = crossListingSuspicions([...rows, rows[0]]);
  assert.equal(suspects.length, 1);
  assert.equal(suspects[0].listings.length, 2);
  assert.equal(suspects[0].confirmedDuplicate, false);
  assert.equal(crossListingSuspicions(rows.map((row) => ({ ...row, identity: identity({ serialNumber: null }) }))).length, 0);
});

test("review revisions invalidate approvals and local approval never grants publication", () => {
  const queue = emptyReviewQueue();
  const added = upsertReviewCase(queue, queueInput());
  assert.equal(added.entry.status, "pending");
  assert.equal(upsertReviewCase(queue, queueInput()).changed, false);
  const approved = recordMatchDecision(queue, "synthetic-001", "approve", "synthetic:review:001");
  assert.equal(approved.entry.review.publicPublicationAllowed, false);
  assert.match(approved.entry.review.comparisonGroupId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(recordMatchDecision(queue, "synthetic-001", "approve", "synthetic:review:001").changed, false);
  const sameCopy = upsertReviewCase(queue, queueInput({ externalId: "102", url: "https://m.bunjang.co.kr/products/102", matchCase: matchCase({ caseId: "synthetic-002" }) }));
  assert.equal(sameCopy.changed, true);
  recordMatchDecision(queue, "synthetic-002", "approve", "synthetic:review:002", new Date(), approved.entry.review.comparisonGroupId);
  assert.equal(sameCopy.entry.status, "approved");
  assert.equal(queue.entries[1].review.comparisonGroupId, approved.entry.review.comparisonGroupId);
  assert.throws(() => recordMatchDecision(queue, "synthetic-002", "defer", "synthetic:review:002", new Date(), approved.entry.review.comparisonGroupId), /UUID supplied only with approval/);
  const revised = upsertReviewCase(queue, queueInput({ matchCase: matchCase({ listingIdentity: identity({ parallel: null }) }) }));
  assert.equal(revised.entry.status, "pending");
  assert.equal(revised.entry.revision, 2);
  assert.equal(revised.entry.review, null);
  assert.throws(() => recordMatchDecision(queue, "synthetic-001", "approve", "synthetic:review:002"), /only complete/);
  recordMatchDecision(queue, "synthetic-001", "defer", "synthetic:review:002");
  const summary = summarizeReviewQueue(queue);
  assert.equal(summary.counts.deferred, 1);
  assert.equal(summary.cases[0].comparisonGroupId, null);
  assert.equal(JSON.stringify(summary).includes("serialNumber"), false);
  assert.throws(() => upsertReviewCase(queue, queueInput({ externalId: "102", url: "https://m.bunjang.co.kr/products/102" })), /another listing/);
});

test("queue input validates source URLs, explicit inventory origin and private evidence references", () => {
  for (const change of [
    { url: "https://example.com/products/101" },
    { url: "https://m.bunjang.co.kr/products/102" },
    { url: "https://m.bunjang.co.kr/products/101?token=bad" },
    { inventoryOrigin: null },
    { evidenceRefs: ["PLACEHOLDER_REF"] },
    { sellerEmail: "synthetic@example.test" },
  ]) assert.throws(() => upsertReviewCase(emptyReviewQueue(), queueInput(change)));
});

test("queue persistence is atomic, read-only listing creates no files, and failures retain prior content", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "scc-review-queue-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.deepEqual(await readReviewQueue(root), emptyReviewQueue());
  const file = path.join(root, ".ops-private", "match-review", "queue.json");
  await assert.rejects(readFile(file), /ENOENT/);
  await updateReviewQueue(root, (queue) => upsertReviewCase(queue, queueInput()));
  const before = await readFile(file, "utf8");
  await assert.rejects(updateReviewQueue(root, () => { throw new Error("synthetic rejected update"); }), /synthetic rejected/);
  assert.equal(await readFile(file, "utf8"), before);
  await updateReviewQueue(root, (queue) => recordMatchDecision(queue, "synthetic-001", "approve", "synthetic:review:001"));
  assert.equal((await readReviewQueue(root)).entries[0].status, "approved");
  await writeFile(path.join(root, ".ops-private", "match-review", "queue.lock"), "{}");
  await assert.rejects(updateReviewQueue(root, () => {}), /locked/);
  assert.equal((await readReviewQueue(root)).entries[0].status, "approved");
});
