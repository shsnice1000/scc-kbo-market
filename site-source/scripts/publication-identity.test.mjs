import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prepareReviewedSnapshot } from "./reviewed-snapshot.mjs";
import { publicPrintingIdentity } from "./publication-identity.mjs";
import { validateReviewLedger } from "./validate-review-ledger.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const now = Date.parse("2026-10-21T00:00:00Z");
const comparisonGroupId = "123e4567-e89b-42d3-a456-426614174000";
export function identityFixture() {
  const identity = { year: 2026, product: "SCC SENSATION", player: "Synthetic Player", team: "두산 베어스", checklistCardId: "SCC-26/D01", printedCardCode: "SCC-26/D01", jerseyNumber: 7, category: "chrome", parallel: "gold", autograph: "none", relic: "none", serialLimit: 33, serialNumber: 7, gradingStatus: "raw", gradingCompany: null, grade: null, condition: "reviewed_near_mint" };
  const printing = structuredClone(identity);
  for (const key of ["serialNumber", "gradingStatus", "gradingCompany", "grade", "condition"]) delete printing[key];
  const card = { id: "synthetic-card", player: identity.player, team: identity.team, type: "패럴렐", cardNumber: identity.checklistCardId, variant: "Synthetic gold printing", serial: null, identityStatus: "Synthetic fixture", observations: [], printingIdentity: publicPrintingIdentity(printing) };
  const market = JSON.parse(fs.readFileSync(path.join(root, "data/market.json"), "utf8"));
  market.candidates = [card]; market.observations = [];
  market.officialCatalog = { status: "awaiting_official_checklist", sourceUrl: null, verifiedAt: null, cards: [] };
  const input = {
    review: { reviewer: "publication-reviewer", reviewedAt: "2026-10-20T22:00:00Z", publicationBasis: "written_permission", publicationEvidenceRef: "permission/basis-001", noPersonalData: true },
    observations: [{ id: "synthetic-exact-001", cardId: card.id, kind: "asking", state: "active_asking", matchLevel: "exact", sourceId: "bunjang", price: 1000, shippingPrice: null, checkedAt: "2026-10-20T21:00:00Z", url: "https://m.bunjang.co.kr/products/101", matchNote: "Synthetic reviewed identity", captureMethod: "manual_public_page", termsReviewedAt: "2026-10-20", observedAt: "2026-10-20T20:00:00Z", inventoryOrigin: "independent_market", identityEvidenceRef: "identity/review-001", comparisonGroupId: comparisonGroupId, identityReview: { schemaVersion: 2, caseId: "synthetic-exact-001", itemType: "single_card", catalogIdentity: structuredClone(identity), listingIdentity: structuredClone(identity) } }],
  };
  return { market, input };
}

test("exact publication derives an opaque key from a private random group token and identity without exposing copy metadata", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scc-public-identity-"));
  t.after(() => { assert.equal(path.dirname(dir), path.resolve(os.tmpdir())); fs.rmSync(dir, { recursive: true, force: true }); });
  const { market, input } = identityFixture();
  const result = prepareReviewedSnapshot(input, market, { siteRoot: dir, now });
  const row = result.market.observations[0];
  assert.match(row.comparisonKey, /^[a-f0-9]{64}$/);
  const sameGroup = identityFixture();
  sameGroup.input.observations[0].id = "synthetic-exact-002";
  const sameKey = prepareReviewedSnapshot(sameGroup.input, sameGroup.market, { siteRoot: dir, now }).market.observations[0].comparisonKey;
  assert.equal(sameKey, row.comparisonKey);
  const otherGroup = identityFixture();
  otherGroup.input.observations[0].comparisonGroupId = "123e4567-e89b-42d3-b456-426614174000";
  assert.notEqual(prepareReviewedSnapshot(otherGroup.input, otherGroup.market, { siteRoot: dir, now }).market.observations[0].comparisonKey, row.comparisonKey);
  const differentCopy = identityFixture();
  differentCopy.input.observations[0].identityReview.catalogIdentity.serialNumber = 8;
  differentCopy.input.observations[0].identityReview.listingIdentity.serialNumber = 8;
  assert.notEqual(prepareReviewedSnapshot(differentCopy.input, differentCopy.market, { siteRoot: dir, now }).market.observations[0].comparisonKey, row.comparisonKey);
  for (const field of ["identityReview", "identityEvidenceRef", "inventoryOrigin", "comparisonGroupId", "serialNumber", "gradingStatus", "condition"]) assert.equal(Object.hasOwn(row, field), false);
  assert.deepEqual(validateReviewLedger(result.market, dir, { now, pendingRecords: [result.reviewRecord] }).errors, []);
  const changed = structuredClone(result.reviewRecord); changed.records[0].identityReview.listingIdentity.serialNumber = 8;
  assert.ok(validateReviewLedger(result.market, dir, { now, pendingRecords: [changed] }).errors.some((error) => error.includes("exact public comparison")));
});

test("exact publication rejects unknown or conflicting dimensions, wrong public mappings, and owner-held origins", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scc-public-identity-"));
  t.after(() => { assert.equal(path.dirname(dir), path.resolve(os.tmpdir())); fs.rmSync(dir, { recursive: true, force: true }); });
  for (const alter of [
    (input) => { input.observations[0].identityReview.listingIdentity.serialNumber = 8; },
    (input) => { input.observations[0].identityReview.listingIdentity.condition = null; },
    (input) => { input.observations[0].inventoryOrigin = "owner_held"; },
    (input) => { delete input.observations[0].identityEvidenceRef; },
    (input) => { delete input.observations[0].comparisonGroupId; },
    (input) => { input.observations[0].comparisonGroupId = "00000000-0000-0000-0000-000000000000"; },
    (input, market) => { market.candidates[0].cardNumber = "SCC-26/D02"; },
    (input, market) => { market.candidates[0].printingIdentity.parallel = "silver"; },
    (input, market) => { market.candidates[0].printingIdentity.serialNumber = 7; },
  ]) {
    const { market, input } = identityFixture(); alter(input, market);
    assert.throws(() => prepareReviewedSnapshot(input, market, { siteRoot: dir, now }));
  }
});
