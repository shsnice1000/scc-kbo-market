import { spawnSync } from "node:child_process";
import { readFileSync, lstatSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const result = spawnSync("git", ["-c", `safe.directory=${root}`, "ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: root, encoding: "utf8", windowsHide: true });
if (result.status !== 0) throw new Error("Public preflight must run inside the collaboration Git repository");
const files = [...new Set(result.stdout.split("\0").filter(Boolean))];
if (files.length < 15) throw new Error("Public repository is unexpectedly empty");
const errors = [];
const forbidden = /(?:^|\/)(?:\.ops-private|\.env(?:\..*)?|\.git|node_modules|archive|reconcile-site[^/]*)(?:\/|$)|(?:^|\/)hosting\.json$|(?:^|\/)(?:원장|인계-|번개장터-업로드)|(?:^|\/)(?:dist|worker)\//;
const secret = /(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|appgprj_[a-f0-9]{16,}|appgdep_[a-f0-9]{16,})/;
for (const file of files) {
  if (forbidden.test(file)) errors.push(`Forbidden public path: ${file}`);
  const info = lstatSync(path.join(root, file));
  if (!info.isFile() || info.isSymbolicLink()) { errors.push(`Not a regular public file: ${file}`); continue; }
  if (file === "site-source/assets/og-preview.png") continue;
  if (/\.(?:png|jpe?g|heic|webp|zip|gz|db|sqlite)$/i.test(file)) errors.push(`Unexpected binary/operating file: ${file}`);
  const text = readFileSync(path.join(root, file), "utf8");
  if (secret.test(text)) errors.push(`Credential or deployment identifier marker: ${file}`);
  if (/C:[\\/]+Users[\\/]+/i.test(text)) errors.push(`Local account path: ${file}`);
}
const data = JSON.parse(readFileSync(path.join(root, "site-source/data/market.json"), "utf8"));
const manifest = JSON.parse(readFileSync(path.join(root, "export-manifest.json"), "utf8"));
if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.files)) errors.push("Invalid collaboration export manifest");
else {
  const listed = new Set();
  for (const entry of manifest.files) {
    if (typeof entry.path !== "string" || !files.includes(entry.path) || entry.path === "export-manifest.json" || listed.has(entry.path)) { errors.push("Unexpected or duplicate manifest path"); continue; }
    listed.add(entry.path);
    const bytes = readFileSync(path.join(root, entry.path));
    const canonical = entry.path === "site-source/assets/og-preview.png" ? bytes : Buffer.from(bytes.toString("utf8").replaceAll("\r\n", "\n"), "utf8");
    const digest = createHash("sha256").update(canonical).digest("hex");
    if (digest !== entry.sha256) errors.push(`Export manifest content changed without review: ${entry.path}`);
  }
  for (const file of files) if (file !== "export-manifest.json" && !listed.has(file)) errors.push(`Public file missing from export manifest: ${file}`);
}
if (data.observations.length || data.officialCatalog.cards.length || data.candidates.length !== 1 || data.candidates[0].player !== "합성 테스트 선수" || data.candidates[0].serial !== null || data.candidates[0].observations.length) errors.push("Public development data must retain the synthetic fixture");
if (errors.length) { for (const error of errors) console.error(error); process.exitCode = 1; }
else console.log(`PASS public collaboration preflight: ${files.length} files; synthetic data; no operating directories or known credential markers`);
