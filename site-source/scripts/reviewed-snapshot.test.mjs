import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import { prepareReviewedSnapshot, importReviewedSnapshot, recoverReviewedImport } from "./reviewed-snapshot.mjs";
import { validateReviewLedger } from "./validate-review-ledger.mjs";
import { validateStaticDist } from "./validate-static-dist.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const now = Date.parse("2026-10-21T00:00:00Z");
const market = JSON.parse(fs.readFileSync(path.join(root, "data/market.json"), "utf8"));
market.observations = [];
market.officialCatalog = { status: "awaiting_official_checklist", sourceUrl: null, verifiedAt: null, cards: [] };
market.candidates = [{ id: "synthetic-card", player: "Synthetic Player", team: "Synthetic Team", type: "미분류", cardNumber: null, variant: "Synthetic fixture", serial: null, identityStatus: "Unconfirmed synthetic card", observations: [] }];

function snapshot() {
  return {
    review: { reviewer: "publication-reviewer", reviewedAt: "2026-10-20T22:00:00Z", publicationBasis: "written_permission", publicationEvidenceRef: "permission/basis-001", noPersonalData: true },
    observations: [{ id: "synthetic-ask-001", cardId: "synthetic-card", kind: "asking", state: "active_asking", matchLevel: "candidate", sourceId: "bunjang", price: 1000, shippingPrice: null, checkedAt: "2026-10-20T21:00:00Z", url: "https://m.bunjang.co.kr/products/101", matchNote: "Synthetic validation fixture", captureMethod: "manual_public_page", termsReviewedAt: "2026-10-20", observedAt: "2026-10-20T20:00:00Z" }],
  };
}

function temporary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scc-reviewed-import-"));
  t.after(() => {
    assert.equal(path.dirname(dir), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith("scc-reviewed-import-"));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function site(t) {
  const dir = temporary(t);
  for (const relative of ["scripts", "assets", "data", ".openai"]) fs.mkdirSync(path.join(dir, relative));
  fs.copyFileSync(path.join(root, "scripts/build-worker.mjs"), path.join(dir, "scripts/build-worker.mjs"));
  for (const file of fs.readdirSync(path.join(root, "assets"))) fs.copyFileSync(path.join(root, "assets", file), path.join(dir, "assets", file));
  for (const file of ["index.html", "robots.txt", "sitemap.xml"]) fs.copyFileSync(path.join(root, file), path.join(dir, file));
  fs.writeFileSync(path.join(dir, "data/market.json"), JSON.stringify(market, null, 2) + "\n");
  fs.writeFileSync(path.join(dir, ".openai/hosting.json"), JSON.stringify({ project_id: "synthetic-local-test" }));
  execFileSync(process.execPath, [path.join(dir, "scripts/build-worker.mjs")], { cwd: dir, windowsHide: true });
  return dir;
}

test("prospective review accepts a fresh snapshot without weakening on-disk provenance", (t) => {
  const dir = temporary(t), input = snapshot();
  const prepared = prepareReviewedSnapshot(input, market, { siteRoot: dir, now });
  assert.equal(prepared.market.observations.length, 1);
  assert.equal(prepared.reviewRecord.formatVersion, 2);
  assert.equal(prepared.market.observations[0].captureMethod, undefined);
  assert.equal(validateReviewLedger(prepared.market, dir, { now }).missingCount, 1);
  const opts = { now, pendingRecords: [prepared.reviewRecord] };
  assert.deepEqual(validateReviewLedger(prepared.market, dir, opts).errors, []);
  for (const changes of [{ price: 2000 }, { sourceId: "break" }, { cardId: "different-card" }, { url: "https://m.bunjang.co.kr/products/102" }, { state: "sold_badge_only" }, { shippingPrice: 500 }]) {
    const changed = structuredClone(prepared.market); Object.assign(changed.observations[0], changes);
    assert.ok(validateReviewLedger(changed, dir, opts).errors.some((error) => error.includes("approved public row changed")));
  }
  assert.deepEqual(input, snapshot(), "preparation never mutates the input");
  const changedCard = structuredClone(prepared.market); changedCard.candidates[0].variant = "Different parallel";
  assert.ok(validateReviewLedger(changedCard, dir, opts).errors.some((error) => error.includes("public card metadata changed")));
});

test("review rejects legacy approvals, future dates, placeholder references, and unsupported settled prices", (t) => {
  const dir = temporary(t);
  for (const alter of [
    (input) => { input.review.publicationEvidenceRef = "permission/TODO"; },
    (input) => { input.review.reviewedAt = "2099-01-01T00:00:00Z"; },
    (input) => { input.observations[0].observedAt = "2026-02-31"; },
    (input) => { input.observations[0].sourcePublishedAt = "2026-10-21T01:00:00Z"; },
    (input) => { Object.assign(input.observations[0], { kind: "sold_verified", state: "sold_verified" }); },
    (input) => { input.observations[0].captureMethod = "authorized_api"; },
  ]) {
    const input = snapshot(); alter(input);
    assert.throws(() => prepareReviewedSnapshot(input, market, { siteRoot: dir, now }));
  }
  const prepared = prepareReviewedSnapshot(snapshot(), market, { siteRoot: dir, now });
  prepared.reviewRecord.formatVersion = 1;
  assert.ok(validateReviewLedger(prepared.market, dir, { now, pendingRecords: [prepared.reviewRecord] }).errors.some((error) => error.includes("version 2 required")));
  const sale = snapshot();
  Object.assign(sale.review, { publicationBasis: "seller_consent" });
  Object.assign(sale.observations[0], { kind: "sold_verified", state: "sold_verified", captureMethod: "seller_submitted", settlementEvidenceRef: "settlement/order-001", settlementEvidenceType: "completed_order" });
  const accepted = prepareReviewedSnapshot(sale, market, { siteRoot: dir, now });
  assert.equal(accepted.market.observations[0].settlementEvidenceRef, undefined);
});

test("dry-run creates no files; successful import synchronizes public artifacts and private approval", async (t) => {
  const dir = site(t), original = fs.readFileSync(path.join(dir, "data/market.json"));
  await importReviewedSnapshot(dir, snapshot(), { now, dryRun: true });
  assert.equal(fs.existsSync(path.join(dir, ".ops-private")), false);
  assert.ok(original.equals(fs.readFileSync(path.join(dir, "data/market.json"))));
  const result = await importReviewedSnapshot(dir, snapshot(), { now });
  assert.deepEqual((await validateStaticDist(dir)).errors, []);
  assert.equal(validateReviewLedger(result.market, dir, { now }).missingCount, 0);
  assert.equal(fs.existsSync(path.join(dir, ".ops-private/review-import.lock")), false);
  assert.equal(fs.existsSync(path.join(dir, ".ops-private/review-import-transaction")), false);
});

test("failure at every transaction boundary restores exact original bytes and removes new approval", async (t) => {
  const dir = site(t);
  const files = ["data/market.json", "dist/data/market.json", "worker/index.js", "dist/server/index.js"];
  const previous = files.map((file) => fs.readFileSync(path.join(dir, file)));
  for (const boundary of ["staged", "ledger", "source", "dist", "worker", "validated"]) {
    await assert.rejects(importReviewedSnapshot(dir, snapshot(), { now, checkpoint: (stage) => { if (stage === boundary) throw new Error("injected failure at " + boundary); } }), /previous public files restored/);
    files.forEach((file, index) => assert.ok(previous[index].equals(fs.readFileSync(path.join(dir, file))), boundary + " " + file));
    const ledgerDir = path.join(dir, ".ops-private/review-ledger");
    assert.deepEqual(fs.existsSync(ledgerDir) ? fs.readdirSync(ledgerDir) : [], []);
    assert.equal(fs.existsSync(path.join(dir, ".ops-private/review-import.lock")), false);
    assert.deepEqual((await validateStaticDist(dir)).errors, []);
  }
});

test("recovery restores an interrupted process and rejects a live import lock", async (t) => {
  const dir = site(t), original = fs.readFileSync(path.join(dir, "data/market.json"));
  const code = `import { importReviewedSnapshot } from ${JSON.stringify(new URL("./reviewed-snapshot.mjs", import.meta.url).href)}; await importReviewedSnapshot(${JSON.stringify(dir)}, ${JSON.stringify(snapshot())}, { now: ${now}, checkpoint: (stage) => { if (stage === 'source') process.exit(77); } });`;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8", windowsHide: true, timeout: 30_000 });
  assert.equal(child.status, 77, child.stderr);
  await assert.rejects(importReviewedSnapshot(dir, snapshot(), { now }), /interrupted import/);
  recoverReviewedImport(dir);
  assert.ok(original.equals(fs.readFileSync(path.join(dir, "data/market.json"))));
  assert.deepEqual((await validateStaticDist(dir)).errors, []);
  const lock = path.join(dir, ".ops-private/review-import.lock");
  fs.writeFileSync(lock, JSON.stringify({ host: os.hostname(), pid: process.pid }));
  assert.throws(() => recoverReviewedImport(dir), /live process/);
});
