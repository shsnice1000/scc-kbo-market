import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeIdentityV2, reviewIdentityCaseV2 } from "./identity.mjs";
import { emptyReviewQueue, recordMatchDecision, upsertReviewCase } from "./review-queue.mjs";
import { buildPublicationDraft, createPublicationSelectionTemplate, readPublicationSelection, writePublicationDraft } from "./publication-export.mjs";
import { normalizeIdentityV2 as normalizeSiteIdentity, reviewIdentityCaseV2 as reviewSiteIdentityCase } from "../../site-source/scripts/identity-policy.mjs";

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const siteSource = path.join(workspace, "site-source");
const now = Date.parse("2026-10-21T00:00:00Z");
const at = "2026-10-20T21:00:00Z";
const listingUrl = "https://m.bunjang.co.kr/products/101";

function identity() {
  return {
    year: 2026, product: "scc_sensation", player: "Synthetic Player", team: "doosan",
    checklistCardId: "SCC-26/D01", printedCardCode: "SCC-26/D01", jerseyNumber: 7,
    category: "chrome", parallel: "gold", autograph: "none", relic: "none", serialLimit: 33,
    serialNumber: 7, gradingStatus: "raw", gradingCompany: null, grade: null, condition: "reviewed_near_mint",
  };
}

function fixture(t) {
  const siteRoot = fs.mkdtempSync(path.join(os.tmpdir(), "scc-export-site-"));
  const privateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "scc-export-workspace-"));
  t.after(() => {
    for (const dir of [siteRoot, privateRoot]) {
      assert.equal(path.dirname(dir), path.resolve(os.tmpdir()));
      assert.ok(path.basename(dir).startsWith("scc-export-"));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  fs.mkdirSync(path.join(privateRoot, ".ops-private", "publication-export"), { recursive: true });

  const print = identity();
  const card = {
    id: "synthetic-card", player: print.player, team: print.team, type: "parallel",
    cardNumber: print.checklistCardId, variant: "Synthetic gold printing", serial: null,
    identityStatus: "Synthetic local fixture", observations: [],
    printingIdentity: {
      year: print.year, product: print.product, player: print.player, team: print.team,
      checklistCardId: print.checklistCardId, printedCardCode: print.printedCardCode,
      jerseyNumber: print.jerseyNumber, category: print.category, parallel: print.parallel,
      autograph: print.autograph, relic: print.relic, serialLimit: print.serialLimit,
    },
  };
  const market = JSON.parse(fs.readFileSync(path.join(siteSource, "data/market.json"), "utf8"));
  market.observations = [];
  market.candidates = [...market.candidates, card];

  const caseId = "synthetic-match-001";
  const matchCase = { schemaVersion: 2, caseId, itemType: "single_card", catalogIdentity: print, listingIdentity: structuredClone(print) };
  const queue = emptyReviewQueue();
  upsertReviewCase(queue, {
    schemaVersion: 1, inventoryOrigin: "independent_market", sourceId: "bunjang", externalId: "101",
    url: listingUrl, evidenceRefs: ["evidence/listing-001"], matchCase,
  }, new Date("2026-10-20T22:00:00Z"));
  recordMatchDecision(queue, caseId, "approve", "evidence/identity-001", new Date("2026-10-20T22:30:00Z"));

  const listingKey = "bunjang:101", ledgerId = "synthetic-run:bunjang:0";
  const row = {
    listingKey, sourceId: "bunjang", externalId: "101", url: listingUrl, itemType: "single_card",
    cardId: card.id, kind: "asking", state: "active_asking", matchLevel: "exact",
    matchNote: "private fixture input", price: 12345, shippingPrice: 0, reviewLedgerId: ledgerId,
    firstSeenAt: at, lastSeenAt: at, ingestedAt: "2026-10-20T22:05:00Z", expiresAt: "2026-11-19T22:05:00Z",
  };
  const db = {
    observations: [row], listingSuppressions: {},
    reviewLedger: [{
      id: ledgerId, sourceId: "bunjang", captureMethod: "manual_public_page", reviewedAt: "2026-10-20T22:00:00Z",
      publicationBasis: "written_permission", publicationEvidenceRef: "permission/basis-001", publicationAllowed: true,
      termsReviewedAt: "2026-10-20T18:00:00Z", historyStorageAllowed: true, retentionDays: 30,
      expiresAt: "2026-11-19T22:05:00Z",
    }],
  };
  const selection = {
    schemaVersion: 1,
    review: {
      reviewerRole: "publisher", reviewedAt: "2026-10-20T23:00:00Z", publicationAllowed: true,
      publicationBasis: "written_permission", publicationEvidenceRef: "permission/basis-001", noPersonalData: true,
    },
    observations: [{ listingKey, matchCaseId: caseId, cardId: card.id }],
  };
  return { siteRoot, privateRoot, market, card, queue, db, row, listingKey, caseId, selection };
}

function build(state) {
  return buildPublicationDraft({ ...state, now, siteRoot: state.siteRoot });
}

test("private operations and independent Sites validator use the same identity policy", () => {
  const privatePolicy = fs.readFileSync(new URL("./identity.mjs", import.meta.url), "utf8");
  const sitePolicy = fs.readFileSync(new URL("../../site-source/scripts/identity-policy.mjs", import.meta.url), "utf8");
  assert.equal(sitePolicy, privatePolicy, "standalone Sites policy is kept byte-identical to private match review policy");
  const copy = identity();
  const rootNormalized = normalizeIdentityV2(copy);
  assert.deepEqual(normalizeSiteIdentity(copy), rootNormalized);
  const review = { schemaVersion: 2, caseId: "policy-parity", itemType: "single_card", catalogIdentity: copy, listingIdentity: structuredClone(copy) };
  assert.deepEqual(reviewSiteIdentityCase(review), reviewIdentityCaseV2(review));
});

test("approved independent exact observation becomes a private draft and a validated public preview", (t) => {
  const state = fixture(t);
  const result = build(state);
  assert.equal(result.observationCount, 1);
  const published = result.prepared.market.observations[0];
  assert.match(published.comparisonKey, /^[a-f0-9]{64}$/);
  assert.notEqual(published.comparisonKey, reviewIdentityCaseV2(state.queue.entries[0].input.matchCase).comparisonKey, "public comparison key is salted by the private random group token");
  assert.equal(published.price, 12345);
  assert.equal(published.title.includes("Synthetic Player"), true);
  for (const privateField of ["inventoryOrigin", "identityReview", "identityEvidenceRef", "comparisonGroupId", "captureMethod", "settlementEvidenceRef"]) assert.equal(Object.hasOwn(published, privateField), false);
  assert.equal(JSON.stringify(result.prepared.market).includes(state.queue.entries[0].review.comparisonGroupId), false, "private random group UUID is not published");
  const draftText = JSON.stringify(result.input);
  assert.match(draftText, /reviewed_near_mint/);
  assert.match(draftText, /serialNumber/);
  assert.doesNotMatch(JSON.stringify(result.prepared.market), /reviewed_near_mint|serialNumber|evidence\/identity-001/);
});

test("draft refuses stale, unauthorized, owner-held, suppressed, or unreviewed identity records", (t) => {
  const cases = [
    (s) => { s.db.reviewLedger[0].publicationAllowed = false; },
    (s) => { s.db.reviewLedger[0].historyStorageAllowed = false; },
    (s) => { s.selection.review.publicationAllowed = false; },
    (s) => { s.queue.entries[0].review.contentSha256 = "f".repeat(64); },
    (s) => { s.queue.entries[0].review.publicPublicationAllowed = true; },
    (s) => { s.queue.entries[0].status = "pending"; },
    (s) => { s.db.observations.push(structuredClone(s.row)); },
    (s) => { s.db.reviewLedger.push(structuredClone(s.db.reviewLedger[0])); },
    (s) => { s.db.listingSuppressions[s.listingKey] = { active: "false" }; },
    (s) => { s.row.expiresAt = "2026-10-20T23:00:00Z"; },
    (s) => { s.db.reviewLedger[0].expiresAt = "2026-10-20T23:00:00Z"; },
    (s) => { s.db.listingSuppressions[s.listingKey] = { active: true, at, reasonCode: "source_request" }; },
    (s) => { s.db.listingSuppressions[s.listingKey] = { active: false, restoredAt: at }; },
    (s) => { s.selection.observations[0].cardId = "different-card"; },
    (s) => { s.selection.review.publicationEvidenceRef = "permission/other-001"; },
    (s) => { s.selection.observations[0].kind = "sold_verified"; },
  ];
  for (const alter of cases) {
    const state = fixture(t);
    alter(state);
    assert.throws(() => build(state), /publication draft rejected/);
  }
});

test("a fresh identity approval still cannot authorize owner-held inventory for export", (t) => {
  const state = fixture(t);
  const caseInput = structuredClone(state.queue.entries[0].input);
  caseInput.inventoryOrigin = "owner_held";
  state.queue = emptyReviewQueue();
  upsertReviewCase(state.queue, caseInput, new Date("2026-10-20T22:00:00Z"));
  recordMatchDecision(state.queue, state.caseId, "approve", "evidence/identity-001", new Date("2026-10-20T22:30:00Z"));
  assert.throws(() => build(state), /owner-held or unknown inventory/);
});

test("restored listing can export only a newer checked observation", (t) => {
  const state = fixture(t);
  state.db.listingSuppressions[state.listingKey] = { active: false, restoredAt: "2026-10-20T20:00:00Z", restorationEvidenceRef: "correction/restore-001" };
  assert.equal(build(state).observationCount, 1);
  state.db.listingSuppressions[state.listingKey].restoredAt = "2026-10-20T21:00:00Z";
  assert.throws(() => build(state), /newer observation/);
});

test("verified settlement needs independent settlement proof and a separately declared evidence type", (t) => {
  const state = fixture(t);
  state.row.kind = "sold_verified";
  state.row.state = "sold_verified";
  state.row.settlementEvidenceRef = "settlement/order-001";
  assert.throws(() => build(state), /settlement proof/);
  state.db.reviewLedger[0].captureMethod = "seller_submitted";
  state.db.reviewLedger[0].publicationBasis = "seller_consent";
  state.db.reviewLedger[0].publicationEvidenceRef = "permission/seller-001";
  state.selection.review.publicationBasis = "seller_consent";
  state.selection.review.publicationEvidenceRef = "permission/seller-001";
  state.selection.observations[0].settlementEvidenceType = "payment_settlement";
  const draft = build(state);
  const row = draft.input.observations[0];
  assert.equal(row.settlementEvidenceType, "payment_settlement");
  assert.equal(row.settlementEvidenceRef, "settlement/order-001");
  state.selection.observations[0].settlementEvidenceType = "sold_badge";
  assert.throws(() => build(state), /settlement proof/);
});

test("private selection and draft paths are bounded, dry-run is read-only, and outputs cannot escape", async (t) => {
  const state = fixture(t);
  const template = await createPublicationSelectionTemplate(state.privateRoot);
  assert.equal(template.created, true);
  const loaded = await readPublicationSelection(state.privateRoot, template.path);
  assert.equal(loaded.review.publicationAllowed, false);
  await assert.rejects(readPublicationSelection(state.privateRoot, path.join(os.tmpdir(), "outside.json")), /inside/);
  const draft = build(state);
  const dry = await writePublicationDraft(state.privateRoot, draft, { dryRun: true });
  assert.equal(dry.dryRun, true);
  assert.equal(fs.existsSync(path.join(state.privateRoot, ".ops-private", "publication-export", "drafts")), false);
  const written = await writePublicationDraft(state.privateRoot, draft);
  assert.equal(written.alreadyExists, false);
  assert.match(written.path, /^\.ops-private[\\/]publication-export[\\/]drafts[\\/][a-f0-9]{64}\.json$/);
  assert.equal((await writePublicationDraft(state.privateRoot, draft)).alreadyExists, true);
  await assert.rejects(writePublicationDraft(state.privateRoot, { ...draft, sha256: "../outside" }), /content hash/);
});
