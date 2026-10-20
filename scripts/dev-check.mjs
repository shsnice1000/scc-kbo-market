import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const commands = [
  "scripts/dev-setup.mjs",
  "site-source/scripts/build-worker.mjs",
  "site-source/scripts/validate-market.mjs",
  "site-source/scripts/validate-review-ledger.mjs",
  "site-source/scripts/validate-catalog-ledger.mjs",
  "site-source/scripts/validate-static-dist.mjs",
  "site-source/scripts/validate-worker.mjs",
];
for (const file of commands) {
  const result = spawnSync(process.execPath, [path.join(root, file)], { cwd: root, stdio: "inherit", windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
