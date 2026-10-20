import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { importReviewedSnapshot, recoverReviewedImport } from "./reviewed-snapshot.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
try {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--recover") {
    recoverReviewedImport(root);
    console.log("PASS interrupted import recovered; no deployment performed");
  } else {
    if (args.some((arg) => arg.startsWith("--") && arg !== "--dry-run")) throw new Error("unknown option");
    const files = args.filter((arg) => !arg.startsWith("--"));
    if (files.length !== 1) throw new Error("usage: node scripts/import-reviewed-snapshot.mjs <reviewed-snapshot.json> [--dry-run] | --recover");
    const file = path.resolve(files[0]);
    const stat = fs.lstatSync(file);
    if (path.extname(file).toLowerCase() !== ".json" || !stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error("input must be a regular JSON file under 1 MiB");
    const bytes = fs.readFileSync(file);
    const result = await importReviewedSnapshot(root, JSON.parse(bytes.toString("utf8")), { inputSha256: createHash("sha256").update(bytes).digest("hex"), dryRun: args.includes("--dry-run") });
    for (const warning of result.warnings) console.warn("WARN " + warning);
    console.log("PASS " + (result.dryRun ? "dry run: no files changed; " : "imported and verified; ") + result.reviewRecord.records.length + " content-bound reviewed observations");
  }
} catch (error) { console.error("FAIL " + error.message); process.exitCode = 1; }
