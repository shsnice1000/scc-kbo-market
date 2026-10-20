import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import vm from "node:vm";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateMarket } from "./validate-market.mjs";
import { validateWorkerArtifact } from "./validate-worker.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const now = Date.parse("2026-10-20T22:00:00Z");
const emptyPrivateRoot = await mkdtemp(path.join(os.tmpdir(), "scc-publication-ledger-"));
after(async () => {
  assert.equal(path.dirname(emptyPrivateRoot), path.resolve(os.tmpdir()));
  assert.ok(path.basename(emptyPrivateRoot).startsWith("scc-publication-ledger-"));
  await rm(emptyPrivateRoot, { recursive: true, force: true });
});
const seed = JSON.parse(await readFile(path.join(root, "data/market.json"), "utf8"));
function fixture() {
  const data = structuredClone(seed);
  data.observations = [];
  data.officialCatalog = { status: "awaiting_official_checklist", sourceUrl: null, verifiedAt: null, cards: [] };
  data.candidates = [{ id: "synthetic-test-card", player: "Synthetic Player", team: "Synthetic Team", type: "미분류", cardNumber: null, variant: "Synthetic fixture", serial: null, identityStatus: "Unconfirmed synthetic card", observations: [] }];
  return data;
}
function validate(data) { return validateMarket(data, "synthetic fixture", { now, siteRoot: emptyPrivateRoot }); }
function row(overrides = {}) {
  return { id: "synthetic-ask-001", cardId: "synthetic-test-card", kind: "asking", state: "active_asking", matchLevel: "candidate", sourceId: "bunjang", title: "Synthetic Player · 후보 매물 · 카드 확인 전", price: 1000, shippingPrice: null, checkedAt: "2026-10-20T21:00:00Z", url: "https://m.bunjang.co.kr/products/101", matchNote: "Synthetic public observation for validation only", ...overrides };
}

test("public market rejects undeclared inventory fields and non-empty nested prices", () => {
  assert.deepEqual(validate(fixture()).errors, []);
  for (const modify of [
    (data) => { data.ownerHeldInventory = []; },
    (data) => { data.candidates[0].ownerOnlyNotes = "private inventory"; },
    (data) => { data.candidates[0].observations = [row()]; },
    (data) => { data.candidates[0].observations = {}; },
  ]) {
    const data = fixture(); modify(data);
    assert.ok(validate(data).errors.some((message) => /unsupported|nested observations/.test(message)));
  }
});

test("public card and photo labels reject contact data and malformed candidate rows", () => {
  for (const modify of [
    (data) => { data.candidates[0].identityStatus = "synthetic@example.test"; },
    (data) => { data.candidates[0].photoSources = [{ sourceId: "bunjang", url: "https://m.bunjang.co.kr/products/101", title: "synthetic@example.test", note: "Synthetic fixture" }]; },
    (data) => { data.sources[0].note = "synthetic@example.test"; },
    (data) => { data.candidates[0] = null; },
  ]) {
    const data = fixture(); modify(data);
    assert.ok(validate(data).errors.length);
  }
});

test("public dates reject future and impossible dates while Korean date-only records remain valid", () => {
  for (const checkedAt of ["2099-01-01", "2026-02-31", "2026-10-20T24:00:00Z", "2026-10-20T23:00:00Z"]) {
    const data = fixture(); data.observations = [row({ checkedAt })];
    assert.ok(validate(data).errors.some((message) => message.includes("future checkedAt")), checkedAt);
  }
  const data = fixture();
  data.observations = [row({ checkedAt: "2026-10-21" })];
  const errors = validate(data).errors;
  assert.equal(errors.some((message) => message.includes("checkedAt")), false);
  assert.ok(errors.some((message) => message.includes("source-review records")), "dates do not bypass review provenance");
});

test("UI consumes only the reviewed global price array even if nested prices reach the browser", async () => {
  const source = (await readFile(path.join(root, "assets/market.js"), "utf8")).replace(/\bstart\(\);\s*$/, "");
  const context = vm.createContext({ document: { querySelector: () => ({}) }, localStorage: { getItem: () => null } });
  vm.runInContext(source, context);
  const global = row();
  context.syntheticData = { observations: [global], candidates: [{ id: global.cardId, observations: [{ ...global, id: "unreviewed-nested", price: 999999 }] }] };
  vm.runInContext("marketData = syntheticData", context);
  assert.equal(vm.runInContext("allRecords().length", context), 1);
  assert.equal(vm.runInContext("recordsFor(marketData.candidates[0]).length", context), 1);
  assert.equal(vm.runInContext("recordsFor(marketData.candidates[0])[0].id", context), global.id);
});

test("Worker build preserves PNG bytes and validates all ten GET/HEAD/304 routes with byte-based ETags", async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "scc-worker-publication-"));
  t.after(async () => {
    assert.equal(path.dirname(tempRoot), path.resolve(os.tmpdir()));
    assert.ok(path.basename(tempRoot).startsWith("scc-worker-publication-"));
    await rm(tempRoot, { recursive: true, force: true });
  });
  for (const dir of ["scripts", ".openai", "assets", "data"]) await mkdir(path.join(tempRoot, dir));
  await copyFile(path.join(root, "scripts/build-worker.mjs"), path.join(tempRoot, "scripts/build-worker.mjs"));
  await copyFile(path.join(root, "assets/og-preview.png"), path.join(tempRoot, "assets/og-preview.png"));
  await writeFile(path.join(tempRoot, ".openai/hosting.json"), JSON.stringify({ project_id: "synthetic-local-test" }));
  for (const [file, value] of [
    ["index.html", "<!doctype html><title>Synthetic test</title>"], ["robots.txt", "User-agent: *"], ["sitemap.xml", "<urlset/>"],
    ["assets/favicon.svg", "<svg/>"], ["assets/record-flow.svg", "<svg/>"], ["assets/market.js", "// Synthetic test"], ["assets/site.css", "body{}"], ["data/market.json", "{}"],
  ]) await writeFile(path.join(tempRoot, file), value);
  execFileSync(process.execPath, [path.join(tempRoot, "scripts/build-worker.mjs")], { cwd: tempRoot, windowsHide: true });
  const result = await validateWorkerArtifact(tempRoot);
  assert.deepEqual(result.errors, []);
  assert.equal(result.checkedAssets, 10);
});
