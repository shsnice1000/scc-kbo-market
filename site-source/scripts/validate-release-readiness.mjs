import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateReleaseEvidence, TARGET_SOURCES } from "./release-evidence.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const opsDbPath = path.join(root, "..", ".ops-private/market-ops/market-ops.json");
let validatorFailures = 0;
console.log("SCC Market release readiness (read-only; no network, commit, push, or deployment)\n");
for (const validator of ["validate-market.mjs", "validate-review-ledger.mjs", "validate-catalog-ledger.mjs", "validate-static-dist.mjs", "validate-worker.mjs"]) {
  try {
    const output = execFileSync(process.execPath, [path.join(root, "scripts", validator)], { cwd: root, encoding: "utf8", timeout: 30_000, windowsHide: true }).trim();
    console.log(`[PASS] ${validator}\n${output}`);
  } catch (error) {
    validatorFailures += 1;
    console.log(`[FAIL] ${validator}\n${[error.stdout, error.stderr, error.message].filter(Boolean).join("\n").trim()}`);
  }
}
try {
  const market = JSON.parse(await readFile(path.join(root, "data/market.json"), "utf8"));
  let ops = null;
  try { ops = JSON.parse(await readFile(opsDbPath, "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; }
  const pendingImport = ["review-import.lock", "review-import-transaction"].some((name) => existsSync(path.join(root, ".ops-private", name)));
  const result = evaluateReleaseEvidence(market, ops, { pendingImport });
  const blockers = [...result.blockers];
  if (validatorFailures) blockers.push(`${validatorFailures} static integrity validator(s) failed`);
  console.log(`\nData readiness: ${market.officialCatalog?.cards?.length ?? 0} official cards, ${market.observations.length} public observations, ${result.publicSourceCount}/${TARGET_SOURCES.length} target source cards, ${result.connected.length}/${TARGET_SOURCES.length} currently healthy collectors, ${result.comparableCards} exact two-platform card group(s) (${result.freshComparableCards} fresh).`);
  console.log(`Two distinct successful scheduled runs within seven days: ${result.scheduledTwice.length}/${TARGET_SOURCES.length} platforms.`);
  if (blockers.length) {
    console.log("\n[BLOCKED] Full six-platform comparison release is not ready:");
    blockers.forEach((reason) => console.log("  - " + reason));
    process.exitCode = validatorFailures ? 1 : 2;
  } else console.log("\n[READY] Static integrity and six-platform release evidence meet the current gate.");
} catch (error) { console.error("FAIL cannot evaluate release evidence: " + error.message); process.exitCode = 1; }
