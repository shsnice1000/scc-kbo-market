import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { gzipSync } from "node:zlib";
import { validateSnapshot } from "./snapshot.mjs";
import { runRefresh } from "./refresh.mjs";
import { parseRefreshArgs } from "./refresh-args.mjs";
import { buildSnapshotTemplate } from "./snapshot-template.mjs";
import { createBunjangSearchCollector } from "./collectors/bunjang-search.mjs";
import { readPrivateObservation } from "./private-observation.mjs";
import { applyPrivateObservation, emptyDatabase, retractObservation, withDatabase } from "./store.mjs";
import { buildBunjangCatalogSnapshot, bunjangCatalogGeneratedAt } from "./collectors/bunjang-catalog.mjs";
import { buildMatchReviewTemplate, reviewCardMatch } from "./matching.mjs";

const cardId = "2026-scc-jungsu-bin-chrome";
const testTime = new Date("2026-10-18T23:00:00.000Z");

test("refresh CLI options separate manual and scheduled runs and reject ambiguous inputs", () => {
  assert.deepEqual(parseRefreshArgs([]), {
    snapshotFiles: [], bunjangConfigPath: null, inbox: false, runOrigin: "manual",
  });
  assert.deepEqual(parseRefreshArgs(["--scheduled", "--inbox"]), {
    snapshotFiles: [], bunjangConfigPath: null, inbox: true, runOrigin: "scheduled",
  });
  assert.deepEqual(parseRefreshArgs(["--snapshot", "reviewed.json", "--snapshot", "next.json"]), {
    snapshotFiles: [path.resolve("reviewed.json"), path.resolve("next.json")], bunjangConfigPath: null, inbox: false, runOrigin: "manual",
  });
  assert.throws(() => parseRefreshArgs(["--scheduled", "--scheduled"]), /only once/);
  assert.throws(() => parseRefreshArgs(["--inbox", "--snapshot", "reviewed.json"]), /cannot be combined/);
  assert.throws(() => parseRefreshArgs(["--snapshot", "--scheduled"]), /requires a file path/);
});

function snapshot(overrides = {}) {
  return {
    schemaVersion: 2,
    sourceId: "bunjang",
    sourceUrl: "https://m.bunjang.co.kr/",
    captureMethod: "manual_public_page",
    review: {
      reviewerRole: "market_reviewer",
      reviewedAt: testTime.toISOString(),
      publicationBasis: "written_permission",
      publicationEvidenceRef: "permission-record-local-001",
      termsReviewedAt: testTime.toISOString(),
      historyStorageAllowed: true,
      retentionDays: 30,
      noPersonalData: true,
    },
    coverage: {
      scope: "Synthetic test query for a single SCC card",
      level: "point_check",
      pagesVisited: 1,
      stopReason: "operator_sample",
    },
    observations: [{
      externalId: "101",
      url: "https://m.bunjang.co.kr/products/101",
      itemType: "single_card",
      cardId,
      kind: "asking",
      state: "active_asking",
      matchLevel: "candidate",
      matchNote: "Synthetic test record for title and parallel comparison only.",
      price: 120000,
      shippingPrice: 4000,
      observedAt: testTime.toISOString(),
    }],
    ...overrides,
  };
}

test("validates only reviewed, source-matched snapshots and known card IDs", () => {
  const normalized = validateSnapshot(snapshot(), testTime.getTime());
  assert.equal(normalized.source.id, "bunjang");
  assert.equal(normalized.observations[0].price, 120000);
  assert.throws(() => validateSnapshot(snapshot({ sourceUrl: "https://example.com/" }), testTime.getTime()), /hostname is not allowed/);
  assert.throws(() => validateSnapshot(snapshot({ observations: [{ ...snapshot().observations[0], cardId: "unknown-card" }] }), testTime.getTime()), /local catalog/);
  assert.throws(() => validateSnapshot(snapshot({ observations: [{ ...snapshot().observations[0], externalId: "seller-alice", url: "https://m.bunjang.co.kr/products/seller-alice" }] }), testTime.getTime()), /numeric product ID/);
  assert.throws(() => validateSnapshot(snapshot({ review: { ...snapshot().review, historyStorageAllowed: false } }), testTime.getTime()), /history storage permission/);
  const sealed = {
    ...snapshot().observations[0],
    itemType: "sealed_box",
    cardId: null,
    kind: "official_retail",
    state: "active_at_check",
    matchLevel: "generic",
    matchNote: "Synthetic test box; tracked separately from single cards.",
  };
  assert.equal(validateSnapshot(snapshot({ observations: [sealed] }), testTime.getTime()).observations[0].itemType, "sealed_box");
  assert.throws(() => validateSnapshot(snapshot({ observations: [{ ...sealed, cardId }] }), testTime.getTime()), /must have cardId null/);
});

function matchIdentity(overrides = {}) {
  return {
    year: 2026,
    product: "SCC SENSATION",
    player: "최형우",
    team: "삼성 라이온즈",
    cardNumber: "AU-CHW",
    parallel: "실버 오토",
    autograph: "on-card",
    relic: false,
    serialLimit: 25,
    serialNumber: 7,
    gradingCompany: null,
    grade: null,
    condition: "raw_near_mint",
    ...overrides,
  };
}

function matchCase(overrides = {}) {
  return {
    schemaVersion: 1,
    caseId: "synthetic-card-match-001",
    itemType: "single_card",
    catalogIdentity: matchIdentity(),
    listingIdentity: matchIdentity(),
    ...overrides,
  };
}

test("card matching is exact only when every required identity dimension is known and equal", () => {
  const exact = reviewCardMatch(matchCase());
  assert.equal(exact.decision, "exact_identity");
  assert.equal(exact.matchLevel, "exact");
  assert.equal(exact.identityComparable, true);

  const normalized = reviewCardMatch(matchCase({
    catalogIdentity: matchIdentity({ product: "SCC   SENSATION" }),
    listingIdentity: matchIdentity({ product: "scc sensation" }),
  }));
  assert.equal(normalized.decision, "exact_identity");

  const missingParallel = reviewCardMatch(matchCase({ listingIdentity: matchIdentity({ parallel: null }) }));
  assert.equal(missingParallel.decision, "needs_review");
  assert.equal(missingParallel.matchLevel, "candidate");
  assert.deepEqual(missingParallel.missingFields, ["parallel"]);

  const wrongNumber = reviewCardMatch(matchCase({ listingIdentity: matchIdentity({ cardNumber: "AU-OTHER" }) }));
  assert.equal(wrongNumber.decision, "conflict");
  assert.deepEqual(wrongNumber.conflicts, ["cardNumber"]);
  assert.equal(wrongNumber.identityComparable, false);
  assert.throws(() => reviewCardMatch(matchCase({ listingIdentity: matchIdentity({ serialNumber: 26 }) })), /cannot exceed serialLimit/);
});

test("card match review excludes lots and separates different serial copies or grades", () => {
  const lot = reviewCardMatch(matchCase({ itemType: "lot" }));
  assert.equal(lot.decision, "excluded_item_type");
  assert.equal(lot.matchLevel, "generic");

  const serialDifference = reviewCardMatch(matchCase({ listingIdentity: matchIdentity({ serialNumber: 8 }) }));
  assert.equal(serialDifference.decision, "exact_identity");
  assert.equal(serialDifference.identityComparable, false);
  assert.match(serialDifference.reasons.join(" "), /serial numbers differ/);

  const gradeDifference = reviewCardMatch(matchCase({ listingIdentity: matchIdentity({ gradingCompany: "PSA", grade: "10" }) }));
  assert.equal(gradeDifference.decision, "exact_identity");
  assert.equal(gradeDifference.identityComparable, false);
  assert.match(gradeDifference.reasons.join(" "), /Grading differs/);

  const conditionDifference = reviewCardMatch(matchCase({ listingIdentity: matchIdentity({ condition: "raw_light_wear" }) }));
  assert.equal(conditionDifference.decision, "exact_identity");
  assert.equal(conditionDifference.identityComparable, false);
  assert.match(conditionDifference.reasons.join(" "), /condition differs/);
});

test("match review schema rejects unsupported fields rather than consuming listing text", () => {
  assert.throws(() => reviewCardMatch(matchCase({ title: "seller phone 010-1234-5678" })), /unsupported field title/);
  assert.throws(() => reviewCardMatch(matchCase({ listingIdentity: matchIdentity({ sellerId: "private" }) })), /unsupported field sellerId/);
  const template = buildMatchReviewTemplate("synthetic-review-001");
  assert.equal(reviewCardMatch(template).decision, "needs_review");
  assert.throws(() => buildMatchReviewTemplate("../unsafe"), /invalid format/);
});

test("correction retraction removes one listing and its price history while keeping an audit reference", () => {
  const db = emptyDatabase(testTime.toISOString());
  db.observations = [
    { listingKey: "bunjang:101", sourceId: "bunjang" },
    { listingKey: "bunjang:other-listing", sourceId: "bunjang" },
  ];
  db.priceEvents = [
    { listingKey: "bunjang:101", type: "first_seen" },
    { listingKey: "bunjang:other-listing", type: "first_seen" },
  ];
  db.sourceStatus.bunjang.state = "snapshot_imported";
  db.sourceStatus.bunjang.recordCount = 2;
  db.privateObservations.push({ noteId: "private-note-1" });

  const result = retractObservation(db, "bunjang", "101", "incorrect_card_match", "correction-evidence-001", testTime);
  assert.deepEqual(result, { retracted: true, observationsRemoved: 1, priceEventsRemoved: 1 });
  assert.deepEqual(db.observations.map((row) => row.listingKey), ["bunjang:other-listing"]);
  assert.deepEqual(db.priceEvents.map((row) => row.listingKey), ["bunjang:other-listing"]);
  assert.equal(db.sourceStatus.bunjang.recordCount, 1);
  assert.equal(db.privateObservations.length, 1);
  assert.equal(db.correctionEvents[0].evidenceRef, "correction-evidence-001");
  assert.equal(Object.hasOwn(db.correctionEvents[0], "price"), false);
  assert.deepEqual(retractObservation(db, "bunjang", "101", "incorrect_card_match", "correction-evidence-001", testTime), {
    retracted: false, observationsRemoved: 0, priceEventsRemoved: 0,
  });
  assert.equal(db.correctionEvents.length, 1);
  assert.throws(() => retractObservation(db, "bunjang", "101", "free_text", "correction-evidence-001"), /reason code is not allowed/);
  assert.throws(() => retractObservation(db, "bunjang", "101", "incorrect_card_match", "010-1234-5678"), /contact information/);
});

test("local store initializes the correction ledger for an existing schema 1 database", async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "scc-market-correction-migration-"));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));
  const legacy = emptyDatabase(testTime.toISOString());
  delete legacy.correctionEvents;
  await writeFile(path.join(tempRoot, "market-ops.json"), JSON.stringify(legacy), "utf8");
  await withDatabase(tempRoot, async (db) => {
    assert.deepEqual(db.correctionEvents, []);
    assert.equal(db.sourceStatus.bunjang.collectorConnected, false);
    assert.equal(db.sourceStatus.bunjang.lastCollectorSuccessAt, null);
  });
  const saved = JSON.parse(await readFile(path.join(tempRoot, "market-ops.json"), "utf8"));
  assert.deepEqual(saved.correctionEvents, []);
});

test("private templates scaffold all six source URLs but cannot pass the review gate as generated", () => {
  for (const sourceId of ["bunjang", "break", "wyyyes", "community", "kream", "daewon"]) {
    const template = buildSnapshotTemplate(sourceId, testTime);
    assert.equal(template.sourceId, sourceId);
    assert.equal(template.observations.length, 0);
    assert.equal(template.review.historyStorageAllowed, false);
    assert.throws(() => validateSnapshot(template, testTime.getTime()), /real private permission record/);
  }
});

test("private screenshot notes keep user data separate and require a stable listing URL before calling a price change", async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "scc-market-private-note-"));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));
  const evidencePath = path.join(tempRoot, "evidence.png");
  const inputPath = path.join(tempRoot, "observation.json");
  const raw = {
    schemaVersion: 1,
    noteId: "wyyyes-card-candidate-001",
    sourceId: "wyyyes",
    sourceUrl: null,
    subject: "2026 SCC SENSATION candidate: player autograph card; exact set and serial unknown",
    matchLevel: "unresolved",
    matchNote: "Screenshot shows a displayed asking price; product page URL and exact parallel are unavailable.",
    priceType: "asking",
    price: 174000,
    shippingPrice: 5000,
    observedAt: null,
    evidenceFile: "evidence.png",
    privateAuthorization: {
      basis: "user_instruction",
      grantedAt: testTime.toISOString(),
      privateStorageAllowed: true,
      publicationAllowed: false,
      apiAccessAllowed: false,
      retentionPolicy: "local_until_operator_deletes",
    },
  };
  await writeFile(evidencePath, Buffer.from("synthetic screenshot evidence"));
  await writeFile(inputPath, JSON.stringify(raw), "utf8");
  const observation = await readPrivateObservation(inputPath, { workspaceRoot: tempRoot, now: testTime.getTime() });
  const db = { privateObservations: [], privatePriceEvents: [] };
  assert.deepEqual(applyPrivateObservation(db, observation, testTime), { imported: true, duplicate: false, eventsAdded: 1 });
  assert.equal(db.privateObservations[0].sourceUrl, null);
  assert.equal(db.privateObservations[0].currentStatus, "unknown_current_status");
  assert.equal(db.privatePriceEvents[0].timeBasis, "recorded_at_observation_time_unknown");
  assert.equal(db.observations, undefined);
  assert.deepEqual(applyPrivateObservation(db, observation, testTime), { imported: false, duplicate: true, eventsAdded: 0 });

  await writeFile(evidencePath, Buffer.from("synthetic next screenshot"));
  raw.price = 160000;
  raw.observedAt = "2026-10-19T00:00:00.000Z";
  await writeFile(inputPath, JSON.stringify(raw), "utf8");
  const next = await readPrivateObservation(inputPath, { workspaceRoot: tempRoot, now: new Date("2026-10-19T00:01:00.000Z").getTime() });
  assert.deepEqual(applyPrivateObservation(db, next, new Date("2026-10-19T00:01:00.000Z")), { imported: true, duplicate: false, eventsAdded: 1 });
  assert.equal(db.privatePriceEvents.at(-1).type, "candidate_observation_added");
  assert.equal(db.privatePriceEvents.at(-1).before.price, 174000);
  assert.equal(db.privatePriceEvents.at(-1).after.price, 160000);
  assert.equal(db.privateObservations.at(-1).privateAuthorization.publicationAllowed, false);

  raw.sourceUrl = "https://wyyyes.com/products/12345";
  raw.observedAt = "2026-10-19T00:02:00.000Z";
  await writeFile(evidencePath, Buffer.from("synthetic linked listing screenshot"));
  await writeFile(inputPath, JSON.stringify(raw), "utf8");
  const linked = await readPrivateObservation(inputPath, { workspaceRoot: tempRoot, now: new Date("2026-10-19T00:02:30.000Z").getTime() });
  assert.deepEqual(applyPrivateObservation(db, linked, new Date("2026-10-19T00:02:30.000Z")), { imported: true, duplicate: false, eventsAdded: 1 });
  assert.equal(db.privatePriceEvents.at(-1).type, "candidate_observation_added");

  raw.price = 150000;
  raw.observedAt = "2026-10-19T00:03:00.000Z";
  await writeFile(evidencePath, Buffer.from("synthetic repeated listing screenshot"));
  await writeFile(inputPath, JSON.stringify(raw), "utf8");
  const recheck = await readPrivateObservation(inputPath, { workspaceRoot: tempRoot, now: new Date("2026-10-19T00:04:00.000Z").getTime() });
  assert.deepEqual(applyPrivateObservation(db, recheck, new Date("2026-10-19T00:04:00.000Z")), { imported: true, duplicate: false, eventsAdded: 1 });
  assert.equal(db.privatePriceEvents.at(-1).type, "asking_price_changed");
  assert.equal(db.privatePriceEvents.at(-1).priceDelta, -10000);
  assert.equal(db.privatePriceEvents.at(-1).priceChangePercent, -6.25);

  raw.privateAuthorization.publicationAllowed = true;
  await writeFile(inputPath, JSON.stringify(raw), "utf8");
  await assert.rejects(readPrivateObservation(inputPath, { workspaceRoot: tempRoot, now: new Date("2026-10-19T00:04:00.000Z").getTime() }), /publication and provider API access must remain false/);
});

test("Bunjang partner adapter paginates, refreshes short-lived tokens, and stores only safe fields", async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "scc-market-ops-bunjang-adapter-"));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));
  const payloads = [
    {
      data: [
        { pid: 101, price: 114000, shippingFee: 5000, saleStatus: "SELLING", name: "Card with seller 010-1234-5678", uid: 909, imageUrlTemplate: "secret image" },
        { pid: 999, price: 10, shippingFee: 0, saleStatus: "DELETED", name: "Deleted listing" },
      ],
      nextCursor: "opaque-cursor-two",
      hasNext: true,
    },
    {
      data: [
        { pid: 101, price: 114000, shippingFee: 5000, saleStatus: "SELLING", name: "Changed title is never persisted", uid: 808 },
        { pid: 102, price: 174000, shippingFee: null, saleStatus: "SELLING", description: "private seller text" },
      ],
      nextCursor: null,
      hasNext: false,
    },
  ];
  const requests = [];
  let tokenCalls = 0;
  const collector = createBunjangSearchCollector({
    permissionConfirmed: true,
    permissionEvidenceRef: "permission-record-local-001",
    termsReviewedAt: testTime.toISOString(),
    historyStorageAllowed: true,
    publicationAllowed: true,
    retentionDays: 30,
    queryPlans: [{ query: "2026 SCC Sensation", scopeLabel: "SCC 2026 Sensation" }],
    requestIntervalMs: 0,
    getBearerToken: async () => `short-lived-token-${++tokenCalls}`,
    fetchImpl: async (input, init) => {
      const url = new URL(input);
      requests.push({ url, init });
      assert.equal(url.origin, "https://openapi.bunjang.co.kr");
      assert.equal(url.pathname, "/api/v1/products");
      assert.equal(url.searchParams.get("q"), "2026 SCC Sensation");
      assert.match(init.headers.Authorization, /^Bearer short-lived-token-/);
      return new Response(JSON.stringify(payloads[requests.length - 1]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  const result = await runRefresh({
    dataDir: path.join(tempRoot, "private"),
    collectors: { bunjang: collector },
    now: testTime,
    collectorTimeoutMs: 1000,
  });
  const db = JSON.parse(await readFile(path.join(tempRoot, "private", "market-ops.json"), "utf8"));
  const normalized = db.observations;
  assert.equal(requests.length, 2);
  assert.equal(tokenCalls, 2);
  assert.equal(result.run.sources.find((source) => source.sourceId === "bunjang").state, "collector_updated");
  assert.equal(result.run.sources.find((source) => source.sourceId === "bunjang").coverage.level, "complete_scope");
  assert.equal(result.run.sources.find((source) => source.sourceId === "bunjang").coverage.pagesVisited, 2);
  assert.equal(normalized.length, 2);
  assert.equal(normalized[0].externalId, "101");
  assert.equal(normalized[0].price, 114000);
  assert.equal(normalized[0].shippingPrice, 5000);
  assert.equal(normalized[0].itemType, "general_reference");
  assert.equal(normalized[0].matchLevel, "generic");
  assert.equal(Object.hasOwn(normalized[0], "name"), false);
  assert.equal(Object.hasOwn(normalized[0], "uid"), false);
  assert.equal(JSON.stringify(db).includes("010-1234-5678"), false);
});

test("Bunjang partner adapter retries transient GET failures with a fresh token and bounded attempts", async () => {
  const responses = [
    new Response(null, { status: 503 }),
    new Response(null, { status: 429, headers: { "Retry-After": "0" } }),
    new Response(JSON.stringify({ data: [], hasNext: false }), { status: 200 }),
  ];
  let requestCount = 0;
  let tokenCount = 0;
  const collector = createBunjangSearchCollector({
    permissionConfirmed: true,
    permissionEvidenceRef: "permission-record-local-001",
    termsReviewedAt: testTime.toISOString(),
    historyStorageAllowed: true,
    publicationAllowed: true,
    retentionDays: 30,
    queryPlans: [{ query: "2026 SCC Sensation", scopeLabel: "SCC 2026 Sensation" }],
    requestIntervalMs: 0,
    maxRetries: 2,
    getBearerToken: async () => `short-lived-token-${++tokenCount}`,
    fetchImpl: async (_url, init) => {
      requestCount += 1;
      assert.equal(init.headers.Authorization, `Bearer short-lived-token-${requestCount}`);
      return responses.shift();
    },
  });
  const result = await collector({ source: { id: "bunjang" }, signal: new AbortController().signal, now: testTime });
  assert.equal(requestCount, 3);
  assert.equal(tokenCount, 3);
  assert.equal(result.coverage.level, "complete_scope");
  assert.equal(result.coverage.pagesVisited, 1);

  let permanentFailureRequests = 0;
  const permanentFailureCollector = createBunjangSearchCollector({
    permissionConfirmed: true,
    permissionEvidenceRef: "permission-record-local-001",
    termsReviewedAt: testTime.toISOString(),
    historyStorageAllowed: true,
    publicationAllowed: true,
    retentionDays: 30,
    queryPlans: [{ query: "2026 SCC Sensation", scopeLabel: "SCC 2026 Sensation" }],
    requestIntervalMs: 0,
    maxRetries: 3,
    getBearerToken: async () => "short-lived-token",
    fetchImpl: async () => {
      permanentFailureRequests += 1;
      return new Response(null, { status: 400 });
    },
  });
  await assert.rejects(
    permanentFailureCollector({ source: { id: "bunjang" }, signal: new AbortController().signal, now: testTime }),
    (error) => error.code === "HTTP_400",
  );
  assert.equal(permanentFailureRequests, 1);
});

test("Bunjang catalog parser reads authorized gzip CSV, filters query matches, and discards seller text", async () => {
  const csv = [
    "pid,name,description,quantity,price,shippingFee,condition,saleStatus,keywords,images,categoryId,brandId,options,uid,updatedAt,createdAt",
    '101,"2026 SCC SENSATION single","seller 010-1234-5678, comma and newline\nsecond line",1,114000,5000,USED,SELLING,"SCC, SENSATION","https://media.invalid/a.jpg",1,1,,9001,2026-10-18T23:00:00.123456Z,2026-10-18T22:00:00Z',
    '102,"SCC Korean card","private seller text",1,174000,5000,USED,DELETED,"SCC","https://media.invalid/b.jpg",1,1,,9002,2026-10-18T23:01:00Z,2026-10-18T22:01:00Z',
    '103,"baseball single","not a target card",1,80000,3000,USED,SELLING,"KBO","https://media.invalid/c.jpg",1,1,,9003,2026-10-18T23:02:00Z,2026-10-18T22:02:00Z',
  ].join("\r\n");
  const gzip = gzipSync(Buffer.from(csv, "utf8"));
  const catalogConfig = {
    permissionConfirmed: true,
    permissionEvidenceRef: "partner-contract-record-001",
    publicationBasis: "partner_contract",
    termsReviewedAt: testTime.toISOString(),
    historyStorageAllowed: true,
    publicationAllowed: true,
    retentionDays: 30,
    mode: "full",
    catalogFileName: "full-20261019.csv.gz",
    queryTerms: ["SCC", "sensation"],
    scopeLabel: "SCC KBO card candidates",
    catalogGeneratedAt: testTime.toISOString(),
    now: testTime,
  };
  const result = await buildBunjangCatalogSnapshot(Readable.from([gzip]), catalogConfig);
  const normalized = validateSnapshot(result.snapshot, testTime.getTime());
  assert.equal(result.catalogMetadata.parsedRecords, 3);
  assert.equal(result.catalogMetadata.matchedRecords, 2);
  assert.equal(normalized.coverage.level, "complete_scope");
  assert.equal(normalized.coverage.scope.includes("full-20261019.csv.gz"), true);
  assert.equal(normalized.observations.length, 2);
  assert.equal(normalized.observations[0].price, 114000);
  assert.equal(normalized.observations[0].shippingPrice, 5000);
  assert.equal(normalized.observations[0].observedAt, "2026-10-18T23:00:00.123Z");
  assert.equal(normalized.observations[0].matchLevel, "generic");
  assert.equal(normalized.observations[1].state, "unavailable_on_recheck");
  assert.equal(JSON.stringify(normalized).includes("010-1234-5678"), false);
  assert.equal(JSON.stringify(normalized).includes("private seller text"), false);
  assert.equal(Object.hasOwn(normalized.observations[0], "name"), false);
  assert.throws(() => validateSnapshot({ ...result.snapshot, catalogMetadata: result.catalogMetadata }, testTime.getTime()), /unsupported fields/);
  const misspelledShippingCsv = "pid,name,price,shipppingFee,saleStatus\n104,SCC single,100000,2500,SELLING\n";
  const typoResult = await buildBunjangCatalogSnapshot(Readable.from([gzipSync(Buffer.from(misspelledShippingCsv))]), { ...catalogConfig, mode: "segment", catalogFileName: "segment-20261019_05.csv.gz" });
  assert.equal(typoResult.snapshot.observations[0].shippingPrice, 2500);
  assert.equal(typoResult.snapshot.coverage.level, "partial_scan");
  assert.equal(typoResult.snapshot.coverage.stopReason, "unknown");
  assert.equal(typoResult.snapshot.coverage.scope.includes("segment-20261019_05.csv.gz"), true);
  assert.equal(validateSnapshot(typoResult.snapshot, testTime.getTime()).coverage.level, "partial_scan");
  const malformedCsv = 'pid,name,price,shippingFee,saleStatus\n105,"SCC single"extra,100000,0,SELLING\n';
  await assert.rejects(buildBunjangCatalogSnapshot(Readable.from([gzipSync(Buffer.from(malformedCsv))]), catalogConfig), /MALFORMED_CSV_QUOTE/);
  await assert.rejects(buildBunjangCatalogSnapshot(Readable.from([gzip]), {
    permissionConfirmed: false,
  }), /disabled until the partner contract/);
  assert.equal(bunjangCatalogGeneratedAt("full", "full-20261019.csv.gz"), "2026-10-18T18:30:00.000Z");
  assert.equal(bunjangCatalogGeneratedAt("segment", "segment-20261019_05.csv.gz"), "2026-10-18T20:10:00.000Z");
  assert.throws(() => bunjangCatalogGeneratedAt("segment", "segment-20261019_25.csv.gz"), /invalid date or hour/);
});

test("Bunjang API collector refuses to initialize without the permission gate", () => {
  assert.throws(() => createBunjangSearchCollector({ permissionConfirmed: false }), /disabled until the partner contract/);
});

test("Bunjang adapter excludes a listing whose status conflicts across query pages", async () => {
  const pages = [
    { data: [{ pid: 101, price: 114000, shippingFee: 5000, saleStatus: "SELLING" }], hasNext: false },
    { data: [{ pid: 101, price: 114000, shippingFee: 5000, saleStatus: "DELETED" }], hasNext: false },
  ];
  let requestIndex = 0;
  const collector = createBunjangSearchCollector({
    permissionConfirmed: true,
    permissionEvidenceRef: "permission-record-local-001",
    termsReviewedAt: testTime.toISOString(),
    historyStorageAllowed: true,
    publicationAllowed: true,
    retentionDays: 30,
    queryPlans: [
      { query: "SCC card A", scopeLabel: "SCC query A" },
      { query: "SCC card B", scopeLabel: "SCC query B" },
    ],
    requestIntervalMs: 0,
    getBearerToken: async () => "short-lived-token",
    fetchImpl: async () => new Response(JSON.stringify(pages[requestIndex++]), { status: 200 }),
  });
  const result = await collector({ source: { id: "bunjang" }, signal: new AbortController().signal, now: testTime });
  assert.equal(result.observations.length, 0);
  assert.equal(result.coverage.level, "partial_scan");
  assert.equal(result.coverage.stopReason, "unknown");
});

test("legacy schema 1 snapshots remain importable without claiming unrecorded coverage", () => {
  const legacy = snapshot();
  legacy.schemaVersion = 1;
  delete legacy.coverage;
  const normalized = validateSnapshot(legacy, testTime.getTime());
  assert.equal(normalized.coverage.recorded, false);
  assert.equal(normalized.coverage.level, "point_check");
  assert.match(normalized.coverage.scope, /not recorded/);
});

test("a sold badge never becomes a verified settlement price", () => {
  const record = {
    ...snapshot().observations[0],
    kind: "sold_verified",
    state: "sold_verified",
  };
  assert.throws(() => validateSnapshot(snapshot({ observations: [record] }), testTime.getTime()), /manual public-page snapshots cannot assert verified settlement/);
  assert.throws(() => validateSnapshot(snapshot({ observations: [{ ...record, kind: "asking", state: "sold_verified" }] }), testTime.getTime()), /incompatible with kind asking/);
  assert.throws(() => validateSnapshot(snapshot({ observations: [{ ...snapshot().observations[0], state: "sold_badge_sale_price_unverified" }] }), testTime.getTime()), /incompatible with kind asking/);
  assert.throws(() => validateSnapshot(snapshot({ observations: [{ ...snapshot().observations[0], state: "active_at_check" }] }), testTime.getTime()), /incompatible with kind asking/);
  assert.throws(() => validateSnapshot(snapshot({ review: { ...snapshot().review, publicationEvidenceRef: "REPLACE_WITH_PERMISSION" } }), testTime.getTime()), /not a placeholder/);
});

test("coverage records the checked scope and cannot call a partial scan complete", () => {
  const normalized = validateSnapshot(snapshot(), testTime.getTime());
  assert.equal(normalized.coverage.level, "point_check");
  assert.throws(() => validateSnapshot(snapshot({ coverage: {
    ...snapshot().coverage,
    level: "complete_scope",
    stopReason: "time_budget",
  } }), testTime.getTime()), /complete_scope requires/);
  assert.throws(() => validateSnapshot(snapshot({ coverage: {
    scope: "manual UI query",
    level: "complete_scope",
    pagesVisited: 1,
    stopReason: "end_of_results",
  } }), testTime.getTime()), /complete_scope requires an authorized API or full-catalog capture/);
  assert.throws(() => validateSnapshot(snapshot({ coverage: {
    ...snapshot().coverage,
    scope: "Seller contact 010-1234-5678",
  } }), testTime.getTime()), /without personal data/);
});

test("refresh imports reviewed snapshots, records price changes, and never marks a missing listing sold", async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "scc-market-ops-"));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));
  const input = path.join(tempRoot, "reviewed.json");
  const dataDir = path.join(tempRoot, "private");
  const original = snapshot();
  await writeFile(input, JSON.stringify(original), "utf8");
  const first = await runRefresh({ dataDir, snapshotFiles: [input], now: testTime });
  assert.equal(first.run.state, "partial_success", JSON.stringify(first.run));
  assert.equal(first.run.sources.filter((source) => source.state === "snapshot_imported").length, 1);
  assert.equal(first.run.sources.filter((source) => source.state === "blocked").length, 5);
  await runRefresh({ dataDir, snapshotFiles: [input], now: testTime });

  const changed = snapshot();
  changed.observations[0].price = 110000;
  changed.observations[0].shippingPrice = 5000;
  changed.observations[0].observedAt = "2026-10-18T23:05:00.000Z";
  await writeFile(input, JSON.stringify(changed), "utf8");
  await runRefresh({ dataDir, snapshotFiles: [input], now: new Date("2026-10-18T23:05:00.000Z") });

  const gone = snapshot();
  gone.observations = [];
  gone.review.reviewedAt = "2026-10-18T23:10:00.000Z";
  gone.review.termsReviewedAt = gone.review.reviewedAt;
  await writeFile(input, JSON.stringify(gone), "utf8");
  await runRefresh({ dataDir, snapshotFiles: [input], now: new Date(gone.review.reviewedAt) });

  const db = JSON.parse(await readFile(path.join(dataDir, "market-ops.json"), "utf8"));
  assert.equal(db.observations.length, 1);
  assert.equal(db.observations[0].price, 110000);
  assert.equal(db.observations[0].state, "active_asking");
  assert.deepEqual(db.priceEvents.map((event) => event.type), ["first_seen", "price_changed", "shipping_changed"]);
  assert.equal(db.sourceStatus.bunjang.state, "snapshot_imported");
  assert.equal(db.sourceStatus.bunjang.coverage.level, "point_check");
});

test("refresh prevents overlapping collector runs and releases its lock after completion", async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "scc-market-refresh-lock-"));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));
  const dataDir = path.join(tempRoot, "private");
  const lockPath = path.join(dataDir, "market-ops.refresh.lock");
  let signalStarted;
  let releaseCollector;
  const collectorStarted = new Promise((resolve) => { signalStarted = resolve; });
  const collectorGate = new Promise((resolve) => { releaseCollector = resolve; });
  const firstRun = runRefresh({
    dataDir,
    collectors: {
      bunjang: async () => {
        signalStarted();
        await collectorGate;
        return snapshot();
      },
    },
    now: testTime,
  });

  await collectorStarted;
  await assert.rejects(runRefresh({ dataDir, now: testTime }), /another refresh is already running/);
  releaseCollector();
  const result = await firstRun;
  assert.equal(result.run.sources.find((source) => source.sourceId === "bunjang").state, "collector_updated");
  await assert.rejects(readFile(lockPath, "utf8"), { code: "ENOENT" });

  const afterRelease = await runRefresh({ dataDir, now: testTime });
  assert.equal(afterRelease.run.state, "blocked");
});

test("refresh processes multiple Bunjang hourly segment catalogs in feed order as one atomic batch", async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "scc-market-ops-segment-batch-"));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));
  const makeSegment = (feedName, price, observedAt) => snapshot({
    captureMethod: "authorized_api",
    review: {
      ...snapshot().review,
      publicationBasis: "partner_contract",
      publicationAllowed: true,
    },
    coverage: {
      scope: `Bunjang segment catalog ${feedName} candidate scan: SCC test query`,
      level: "partial_scan",
      pagesVisited: 1,
      stopReason: "unknown",
    },
    observations: [{
      ...snapshot().observations[0],
      price,
      observedAt,
    }],
  });
  const early = makeSegment("segment-20261019_05.csv.gz", 120000, "2026-10-18T20:11:00.000Z");
  const late = makeSegment("segment-20261019_07.csv.gz", 110000, "2026-10-18T22:11:00.000Z");
  const earlyPath = path.join(tempRoot, "early.json");
  const latePath = path.join(tempRoot, "late.json");
  const dataDir = path.join(tempRoot, "private");
  await writeFile(earlyPath, JSON.stringify(early), "utf8");
  await writeFile(latePath, JSON.stringify(late), "utf8");

  const result = await runRefresh({ dataDir, snapshotFiles: [latePath, earlyPath], now: testTime });
  const source = result.run.sources.find((item) => item.sourceId === "bunjang");
  assert.equal(source.state, "snapshot_imported");
  assert.deepEqual(source.snapshotBatch, {
    count: 2,
    kind: "segments_only",
    firstSegment: "segment-20261019_05.csv.gz",
    lastSegment: "segment-20261019_07.csv.gz",
    missingIntervals: 1,
  });
  assert.equal(source.imported, 2);
  const db = JSON.parse(await readFile(path.join(dataDir, "market-ops.json"), "utf8"));
  assert.equal(db.observations[0].price, 110000);
  assert.deepEqual(db.priceEvents.map((event) => event.type), ["first_seen", "price_changed"]);
  assert.equal(db.reviewLedger.length, 2);
  assert.equal(new Set(db.reviewLedger.map((row) => row.id)).size, 2);

  const unchanged = await runRefresh({ dataDir, snapshotFiles: [earlyPath, latePath], now: testTime });
  assert.equal(unchanged.run.sources.find((item) => item.sourceId === "bunjang").state, "snapshot_unchanged");
  const nextPath = path.join(tempRoot, "next.json");
  await writeFile(nextPath, JSON.stringify(makeSegment("segment-20261019_09.csv.gz", 100000, "2026-10-19T00:11:00.000Z")), "utf8");
  const nextRun = await runRefresh({
    dataDir,
    snapshotFiles: [earlyPath, latePath, nextPath],
    now: new Date("2026-10-19T01:00:00.000Z"),
  });
  const nextSource = nextRun.run.sources.find((item) => item.sourceId === "bunjang");
  assert.equal(nextSource.state, "snapshot_imported");
  assert.deepEqual(nextSource.snapshotBatch, {
    count: 1,
    kind: "segments_only",
    previousFeed: "segment-20261019_07.csv.gz",
    firstSegment: "segment-20261019_09.csv.gz",
    lastSegment: "segment-20261019_09.csv.gz",
    missingIntervals: 1,
  });
  const afterNext = JSON.parse(await readFile(path.join(dataDir, "market-ops.json"), "utf8"));
  assert.equal(afterNext.observations[0].price, 100000);
  assert.equal(afterNext.reviewLedger.length, 3);
  assert.equal(afterNext.sourceStatus.bunjang.lastCatalogFeed.fileName, "segment-20261019_09.csv.gz");
});

test("refresh applies a Bunjang Full baseline before the later hourly segments", async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "scc-market-ops-full-segments-"));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));
  const commonReview = {
    ...snapshot().review,
    publicationBasis: "partner_contract",
    publicationAllowed: true,
  };
  const makeFeed = (mode, feedName, price, observedAt) => snapshot({
    captureMethod: "authorized_api",
    review: commonReview,
    coverage: {
      scope: `Bunjang ${mode} catalog ${feedName} candidate scan: SCC test query`,
      level: mode === "full" ? "complete_scope" : "partial_scan",
      pagesVisited: 1,
      stopReason: mode === "full" ? "end_of_results" : "unknown",
    },
    observations: [{ ...snapshot().observations[0], price, observedAt }],
  });
  const fullPath = path.join(tempRoot, "full.json");
  const segmentPath = path.join(tempRoot, "segment.json");
  const dataDir = path.join(tempRoot, "private");
  await writeFile(fullPath, JSON.stringify(makeFeed("full", "full-20261019.csv.gz", 120000, "2026-10-18T18:31:00.000Z")), "utf8");
  await writeFile(segmentPath, JSON.stringify(makeFeed("segment", "segment-20261019_04.csv.gz", 110000, "2026-10-18T19:11:00.000Z")), "utf8");

  const result = await runRefresh({ dataDir, snapshotFiles: [segmentPath, fullPath], now: testTime });
  const source = result.run.sources.find((item) => item.sourceId === "bunjang");
  assert.equal(source.state, "snapshot_imported");
  assert.deepEqual(source.snapshotBatch, {
    count: 2,
    kind: "full_plus_segments",
    fullFeed: "full-20261019.csv.gz",
    firstSegment: "segment-20261019_04.csv.gz",
    lastSegment: "segment-20261019_04.csv.gz",
    missingIntervals: 0,
  });
  const db = JSON.parse(await readFile(path.join(dataDir, "market-ops.json"), "utf8"));
  assert.equal(db.observations[0].price, 110000);
  assert.deepEqual(db.priceEvents.map((event) => event.type), ["first_seen", "price_changed"]);
  assert.equal(db.reviewLedger[0].coverage.level, "complete_scope");
  assert.equal(db.reviewLedger[1].coverage.level, "partial_scan");
});

test("a failed later Bunjang segment leaves the entire batch unapplied", async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "scc-market-ops-segment-batch-atomic-"));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));
  const makeSegment = (feedName, observedAt) => snapshot({
    captureMethod: "authorized_api",
    review: {
      ...snapshot().review,
      publicationBasis: "partner_contract",
      publicationAllowed: true,
    },
    coverage: {
      scope: `Bunjang segment catalog ${feedName} candidate scan: SCC test query`,
      level: "partial_scan",
      pagesVisited: 1,
      stopReason: "unknown",
    },
    observations: [{ ...snapshot().observations[0], observedAt }],
  });
  const earlyPath = path.join(tempRoot, "early.json");
  const latePath = path.join(tempRoot, "late.json");
  const dataDir = path.join(tempRoot, "private");
  await writeFile(earlyPath, JSON.stringify(makeSegment("segment-20261019_05.csv.gz", "2026-10-18T20:11:00.000Z")), "utf8");
  await writeFile(latePath, JSON.stringify(makeSegment("segment-20261019_06.csv.gz", "2026-10-18T20:10:00.000Z")), "utf8");

  const result = await runRefresh({ dataDir, snapshotFiles: [earlyPath, latePath], now: testTime });
  assert.equal(result.run.sources.find((item) => item.sourceId === "bunjang").state, "failed");
  assert.match(result.run.sources.find((item) => item.sourceId === "bunjang").error, /out-of-order/);
  const db = JSON.parse(await readFile(path.join(dataDir, "market-ops.json"), "utf8"));
  assert.equal(db.observations.length, 0);
  assert.equal(db.priceEvents.length, 0);
  assert.equal(db.reviewLedger.length, 0);
});

test("refresh still rejects repeated same-source snapshots outside the Bunjang catalog feed batch path", async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "scc-market-ops-duplicate-source-"));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));
  const inputA = path.join(tempRoot, "a.json");
  const inputB = path.join(tempRoot, "b.json");
  const dataDir = path.join(tempRoot, "private");
  await writeFile(inputA, JSON.stringify(snapshot()), "utf8");
  await writeFile(inputB, JSON.stringify(snapshot()), "utf8");

  const result = await runRefresh({ dataDir, snapshotFiles: [inputA, inputB], now: testTime });
  const source = result.run.sources.find((item) => item.sourceId === "bunjang");
  assert.equal(source.state, "failed");
  assert.match(source.error, /only Bunjang catalog feeds may be batched/);
  const db = JSON.parse(await readFile(path.join(dataDir, "market-ops.json"), "utf8"));
  assert.equal(db.observations.length, 0);
  assert.equal(db.reviewLedger.length, 0);
});

test("refresh requires a new Full baseline when the Segment feed gap exceeds 24 hours", async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "scc-market-ops-segment-gap-"));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));
  const makeSegment = (feedName, observedAt) => snapshot({
    captureMethod: "authorized_api",
    review: {
      ...snapshot().review,
      publicationBasis: "partner_contract",
      publicationAllowed: true,
    },
    coverage: {
      scope: `Bunjang segment catalog ${feedName} candidate scan: SCC test query`,
      level: "partial_scan",
      pagesVisited: 1,
      stopReason: "unknown",
    },
    observations: [{ ...snapshot().observations[0], observedAt }],
  });
  const olderPath = path.join(tempRoot, "older.json");
  const newerPath = path.join(tempRoot, "newer.json");
  const dataDir = path.join(tempRoot, "private");
  await writeFile(olderPath, JSON.stringify(makeSegment("segment-20261018_05.csv.gz", "2026-10-17T20:11:00.000Z")), "utf8");
  await writeFile(newerPath, JSON.stringify(makeSegment("segment-20261019_06.csv.gz", "2026-10-18T21:11:00.000Z")), "utf8");

  const result = await runRefresh({ dataDir, snapshotFiles: [olderPath, newerPath], now: testTime });
  const source = result.run.sources.find((item) => item.sourceId === "bunjang");
  assert.equal(source.state, "failed");
  assert.match(source.error, /gap over 24 hours/);
  const db = JSON.parse(await readFile(path.join(dataDir, "market-ops.json"), "utf8"));
  assert.equal(db.observations.length, 0);
  assert.equal(db.reviewLedger.length, 0);
});

test("replaying the same reviewed snapshot is a no-op and does not extend observation retention", async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "scc-market-ops-replay-"));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));
  const input = path.join(tempRoot, "reviewed.json");
  const dataDir = path.join(tempRoot, "private");
  const original = snapshot();
  original.review.retentionDays = 2;
  await writeFile(input, JSON.stringify(original), "utf8");
  await runRefresh({ dataDir, snapshotFiles: [input], now: testTime });

  const dbPath = path.join(dataDir, "market-ops.json");
  const before = JSON.parse(await readFile(dbPath, "utf8"));
  const initialObservation = before.observations[0];
  const initialLastSuccess = before.sourceStatus.bunjang.lastSuccessAt;
  const initialEventCount = before.priceEvents.length;
  const initialLedgerCount = before.reviewLedger.length;

  // JSON formatting and key order change the input-file hash but not its reviewed content.
  const reverseKeyOrder = (value) => Array.isArray(value)
    ? value.map(reverseKeyOrder)
    : value && typeof value === "object"
      ? Object.fromEntries(Object.entries(value).reverse().map(([key, nested]) => [key, reverseKeyOrder(nested)]))
      : value;
  await writeFile(input, `${JSON.stringify(reverseKeyOrder(original), null, 2)}\n`, "utf8");
  const replay = await runRefresh({
    dataDir,
    snapshotFiles: [input],
    now: new Date(testTime.getTime() + 86_400_000),
  });
  const replaySource = replay.run.sources.find((source) => source.sourceId === "bunjang");
  assert.equal(replaySource.state, "snapshot_unchanged");
  assert.equal(replaySource.imported, 0);
  assert.equal(replaySource.eventsAdded, 0);
  assert.equal(replay.run.state, "partial_success");

  const after = JSON.parse(await readFile(dbPath, "utf8"));
  assert.equal(after.reviewLedger.length, initialLedgerCount);
  assert.equal(after.priceEvents.length, initialEventCount);
  assert.equal(after.observations[0].expiresAt, initialObservation.expiresAt);
  assert.equal(after.observations[0].ingestedAt, initialObservation.ingestedAt);
  assert.equal(after.sourceStatus.bunjang.lastSuccessAt, initialLastSuccess);
  assert.equal(after.sourceStatus.bunjang.state, "snapshot_unchanged");
});

test("retention cleanup removes an observation and its price history at the approved deadline", async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "scc-market-ops-retention-"));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));
  const input = path.join(tempRoot, "reviewed.json");
  const dataDir = path.join(tempRoot, "private");
  const record = snapshot();
  record.review.retentionDays = 1;
  await writeFile(input, JSON.stringify(record), "utf8");
  await runRefresh({ dataDir, snapshotFiles: [input], now: testTime });
  const result = await runRefresh({ dataDir, now: new Date(testTime.getTime() + 86_400_001) });
  assert.equal(result.pruned.observations, 1);
  const db = JSON.parse(await readFile(path.join(dataDir, "market-ops.json"), "utf8"));
  assert.equal(db.observations.length, 0);
  assert.equal(db.priceEvents.length, 0);
  assert.equal(db.reviewLedger.length, 0);
  assert.equal(db.retentionEvents[0].deleted.observations, 1);
  assert.equal(db.retentionEvents[0].reason, "approved_retention_expired");
  assert.equal(db.sourceStatus.bunjang.state, "blocked");
});

test("an invalid source input is isolated to that source and is not stored", async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "scc-market-ops-bad-"));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));
  const input = path.join(tempRoot, "bad.json");
  const invalid = snapshot();
  invalid.sourceUrl = "https://example.com/";
  await writeFile(input, JSON.stringify(invalid), "utf8");
  const result = await runRefresh({ dataDir: path.join(tempRoot, "private"), snapshotFiles: [input], now: testTime });
  assert.equal(result.run.state, "partial_failure");
  assert.equal(result.run.sources.find((source) => source.sourceId === "bunjang").state, "failed");
  assert.equal(result.run.sources.filter((source) => source.state === "blocked").length, 5);
});

test("a stale snapshot cannot overwrite newer prices and only its source fails", async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "scc-market-ops-stale-"));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));
  const input = path.join(tempRoot, "reviewed.json");
  const dataDir = path.join(tempRoot, "private");
  const newer = snapshot();
  newer.observations[0].observedAt = "2026-10-18T23:05:00.000Z";
  newer.observations[0].price = 110000;
  await writeFile(input, JSON.stringify(newer), "utf8");
  await runRefresh({ dataDir, snapshotFiles: [input], now: new Date("2026-10-18T23:05:00.000Z") });

  const stale = snapshot();
  stale.observations[0].price = 120000;
  await writeFile(input, JSON.stringify(stale), "utf8");
  const result = await runRefresh({ dataDir, snapshotFiles: [input], now: new Date("2026-10-18T23:06:00.000Z") });
  assert.equal(result.run.sources.find((source) => source.sourceId === "bunjang").state, "failed");
  assert.equal(result.run.sources.filter((source) => source.state === "blocked").length, 5);
  const db = JSON.parse(await readFile(path.join(dataDir, "market-ops.json"), "utf8"));
  assert.equal(db.observations[0].price, 110000);
  assert.equal(db.priceEvents.length, 1);
});

test("collector adapters run concurrently through the same review gate and isolate failures", async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "scc-market-ops-adapters-"));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));
  let seenSince = "unset";
  const result = await runRefresh({
    dataDir: path.join(tempRoot, "private"),
    now: testTime,
    collectors: {
      bunjang: async ({ since, signal }) => {
        assert.equal(since, null);
        assert.equal(signal instanceof AbortSignal, true);
        seenSince = since;
        return { snapshot: snapshot() };
      },
      break: async () => {
        throw new Error("synthetic isolated adapter error");
      },
    },
  });
  assert.equal(seenSince, null);
  assert.equal(result.run.trigger, "approved_collectors");
  assert.equal(result.run.sources.find((source) => source.sourceId === "bunjang").state, "collector_updated");
  assert.match(result.run.sources.find((source) => source.sourceId === "break").error, /collector failed/);
  assert.equal(result.run.sources.filter((source) => source.state === "blocked").length, 4);
  assert.equal(result.run.state, "partial_failure");
});

test("scheduled collector runs preserve origin and count successful unchanged checks", async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "scc-market-ops-scheduled-"));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));
  const dataDir = path.join(tempRoot, "private");
  const collectors = { bunjang: async () => snapshot() };
  const first = await runRefresh({ dataDir, collectors, runOrigin: "scheduled", now: testTime });
  assert.equal(first.run.trigger, "scheduled_approved_collectors");
  assert.equal(first.run.sources.find((source) => source.sourceId === "bunjang").state, "collector_updated");

  const checkedAgainAt = new Date(testTime.getTime() + 60_000);
  const second = await runRefresh({ dataDir, collectors, runOrigin: "scheduled", now: checkedAgainAt });
  assert.equal(second.run.trigger, "scheduled_approved_collectors");
  assert.equal(second.run.sources.find((source) => source.sourceId === "bunjang").state, "collector_unchanged");

  await runRefresh({ dataDir, now: new Date(checkedAgainAt.getTime() + 60_000) });
  const db = JSON.parse(await readFile(path.join(dataDir, "market-ops.json"), "utf8"));
  assert.equal(db.sourceStatus.bunjang.state, "blocked");
  assert.equal(db.sourceStatus.bunjang.collectorConnected, true);
  assert.equal(db.sourceStatus.bunjang.lastCollectorSuccessAt, checkedAgainAt.toISOString());
  assert.equal(db.sourceStatus.bunjang.recordCount, 1);
  assert.equal(db.runs.filter((run) => run.trigger.startsWith("scheduled")).length, 2);
});

test("one successful collector with five blocked sources is reported as partial success", async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "scc-market-ops-partial-"));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));
  const result = await runRefresh({
    dataDir: path.join(tempRoot, "private"),
    now: testTime,
    collectors: { bunjang: async () => ({ snapshot: snapshot() }) },
  });
  assert.equal(result.run.state, "partial_success");
  assert.equal(result.run.sources.filter((source) => source.state === "blocked").length, 5);
});

test("collector timeouts abort the adapter and isolate that source", async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "scc-market-ops-timeout-"));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));
  let aborted = false;
  const result = await runRefresh({
    dataDir: path.join(tempRoot, "private"),
    collectorTimeoutMs: 5,
    now: testTime,
    collectors: {
      bunjang: ({ signal }) => new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => {
          aborted = true;
          reject(new DOMException("Aborted", "AbortError"));
        }, { once: true });
      }),
    },
  });
  assert.equal(aborted, true);
  assert.match(result.run.sources.find((source) => source.sourceId === "bunjang").error, /timed out after 5 ms/);
  assert.equal(result.run.sources.filter((source) => source.state === "blocked").length, 5);
});

test("a refresh with all six successful collectors is reported as success", async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "scc-market-ops-six-"));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));
  const sourceUrls = {
    bunjang: "https://m.bunjang.co.kr/",
    break: "https://break.co.kr/",
    wyyyes: "https://wyyyes.com/",
    community: "https://cafe.naver.com/",
    kream: "https://kream.co.kr/",
    daewon: "https://www.daewonshop.com/",
  };
  const collectors = Object.fromEntries(Object.entries(sourceUrls).map(([sourceId, sourceUrl]) => [sourceId, async () => ({
    snapshot: snapshot({ sourceId, sourceUrl, observations: [] }),
  })]));
  const result = await runRefresh({ dataDir: path.join(tempRoot, "private"), collectors, now: testTime });
  assert.equal(result.run.state, "success");
  assert.equal(result.run.sources.filter((source) => source.state === "collector_updated").length, 6);
});
