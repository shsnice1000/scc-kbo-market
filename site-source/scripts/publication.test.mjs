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

test("source coverage requires an explicit state, truthful date, and checked scope", () => {
  assert.deepEqual(validate(fixture()).errors, []);
  for (const coverage of [
    undefined,
    { state: "unknown", checkedAt: null, scope: null },
    { state: "not_checked", checkedAt: "2026-10-20", scope: null },
    { state: "not_checked", checkedAt: null, scope: "synthetic scope" },
    { state: "partial_scan", checkedAt: null, scope: "synthetic scope" },
    { state: "access_blocked", checkedAt: "2099-01-01", scope: "synthetic scope" },
    { state: "complete_scope_scan", checkedAt: "2026-10-20T21:00:00Z", scope: "synthetic@example.test" },
    { state: "complete_scope_scan", checkedAt: "2026-10-20T21:00:00Z", scope: " " },
  ]) {
    const data = fixture();
    if (coverage === undefined) delete data.sources[0].coverage;
    else data.sources[0].coverage = coverage;
    assert.ok(validate(data).errors.some((message) => message.includes("source bunjang")), JSON.stringify(coverage));
  }
  for (const state of ["access_blocked", "partial_scan", "complete_scope_scan"]) {
    const data = fixture();
    data.sources[0].coverage = { state, checkedAt: "2026-10-20T21:00:00Z", scope: "synthetic result page" };
    assert.deepEqual(validate(data).errors, [], state);
  }
});

test("source cards distinguish unchecked, blocked, partial, and complete empty coverage", async () => {
  const source = (await readFile(path.join(root, "assets/market.js"), "utf8")).replace(/\bstart\(\);\s*$/, "");
  const elements = new Map([["#source-grid", { innerHTML: "" }], ["#observation-list", { innerHTML: "" }]]);
  const context = vm.createContext({
    document: { querySelector: (selector) => elements.get(selector) || { innerHTML: "" } },
    localStorage: { getItem: () => null },
    window: { location: { href: "https://scc-market.test/" } },
    URL,
  });
  vm.runInContext(source, context);
  context.syntheticData = fixture();
  context.syntheticData.sources[0].coverage = { state: "complete_scope_scan", checkedAt: "2026-10-20T21:00:00Z", scope: "synthetic result page" };
  context.syntheticData.sources[1].coverage = { state: "access_blocked", checkedAt: "2026-10-20T21:00:00Z", scope: "synthetic login page" };
  context.syntheticData.sources[2].coverage = { state: "partial_scan", checkedAt: "2026-10-20T21:00:00Z", scope: "synthetic first page" };
  context.syntheticData.sources[4].coverage = { state: "complete_scope_scan", checkedAt: "2026-09-01", scope: "synthetic older scan" };
  context.syntheticData.sources[5].coverage = { state: "partial_scan", checkedAt: "2026-10-20T21:00:00Z", scope: "<script>synthetic()</script>" };
  vm.runInContext("marketData = syntheticData; renderSources()", context);
  const html = elements.get("#source-grid").innerHTML;
  assert.match(html, /data-coverage-state="complete_scope_scan"/);
  assert.match(html, /확인 당시 범위에서 새로 공개할 가격 근거가 확인되지 않았습니다\./);
  assert.match(html, /synthetic result page/);
  assert.match(html, /접근 차단 ·/);
  assert.match(html, /매물 유무를 확인하지 못했습니다\./);
  assert.match(html, /일부 확인 ·/);
  assert.match(html, /일부 범위만 확인했으며 전체 출처 자료를 뜻하지 않습니다\./);
  assert.match(html, /확인 전/);
  assert.match(html, /공개 기록 0건은 매물 부재를 뜻하지 않습니다\./);
  assert.match(html, /data-coverage-stale="true"/);
  assert.match(html, /갱신 지연 · 범위 확인 완료 ·/);
  assert.match(html, /&lt;script&gt;synthetic\(\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>synthetic\(\)<\/script>/);
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

test("UI sorts offset timestamps by instant and keeps bid, auction result, settlement, and retail filters separate", async () => {
  const source = (await readFile(path.join(root, "assets/market.js"), "utf8")).replace(/\bstart\(\);\s*$/, "");
  const element = { scrollTop: 0, innerHTML: "", querySelectorAll: () => [], querySelector: () => ({ addEventListener() {} }) };
  const context = vm.createContext({ document: { querySelector: () => element }, localStorage: { getItem: () => null }, window: { location: { href: "http://localhost/" } }, URL });
  vm.runInContext(source, context);
  context.records = [row({ id: "older-offset", checkedAt: "2026-10-21T03:00:00+09:00" }), row({ id: "newer-utc", checkedAt: "2026-10-20T21:00:00Z" }), row({ id: "invalid", checkedAt: "invalid" })];
  assert.equal(vm.runInContext("sortRecordsNewestFirst(records)[0].id", context), "newer-utc");
  assert.equal(vm.runInContext("latestObservedDate(records)", context), "2026-10-20T21:00:00Z");
  context.syntheticData = fixture();
  context.syntheticData.observations = ["asking", "auction_current_bid", "auction_final_bid", "sold_verified", "official_retail", "auction", "sold"].map((kind, index) => row({ id: "kind-" + index, kind, sourceId: index === 0 ? "bunjang" : "break", price: (index + 1) * 1000 }));
  vm.runInContext("marketData = syntheticData", context);
  assert.equal(vm.runInContext("countByKind(allRecords(), 'auction_current_bid')", context), 1);
  assert.equal(vm.runInContext("countByKind(allRecords(), 'auction_final_bid')", context), 2);
  assert.equal(vm.runInContext("countByKind(allRecords(), 'sold_verified')", context), 2);
  vm.runInContext("renderDialog(findCard('synthetic-test-card'), 'auction_current_bid', 'break')", context);
  assert.match(element.innerHTML, /at-\d+ lane-0/);
  assert.match(element.innerHTML, /확인 당시 경매 진행 호가/);
  assert.match(element.innerHTML, /진행 중 확인한 입찰가/);
  assert.equal((element.innerHTML.match(/class="price-plot-row"/g) ?? []).length, 1);
  assert.match(element.innerHTML, /배송비 확인 전/);
  assert.doesNotMatch(element.innerHTML, /각 점은 확인 당시 판매 희망가/);
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
