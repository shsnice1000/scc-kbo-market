import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { editorialTitleFor } from "./editorial-title.mjs";
import { validateMarket } from "./validate-market.mjs";
import { validateStaticDist } from "./validate-static-dist.mjs";
import { publicationComparison } from "./publication-identity.mjs";

const ENVELOPE = new Set(["review", "observations"]);
const REVIEW = new Set(["reviewer", "reviewedAt", "publicationBasis", "publicationEvidenceRef", "noPersonalData"]);
const AUDIT = ["captureMethod", "termsReviewedAt", "observedAt", "sourcePublishedAt", "settlementEvidenceRef", "settlementEvidenceType", "inventoryOrigin", "identityReview", "identityEvidenceRef", "comparisonGroupId"];
const RECORD = new Set(["id", "cardId", "kind", "state", "matchLevel", "sourceId", "price", "shippingPrice", "checkedAt", "url", "matchNote", "postedTimeAtCheck", ...AUDIT]);
const PUBLIC_FILES = ["data/market.json", "dist/data/market.json", "worker/index.js", "dist/server/index.js"];
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
import { publicRowSha256 } from "./review-policy.mjs";

function objectFields(value, allowed, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(label + " must be an object");
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(label + " contains unsupported field " + key);
}

export function prepareReviewedSnapshot(input, market, { siteRoot, inputSha256 = hash(JSON.stringify(input)), now = Date.now() } = {}) {
  objectFields(input, ENVELOPE, "snapshot");
  objectFields(input.review, REVIEW, "review");
  if (!Array.isArray(input.observations) || input.observations.length < 1 || input.observations.length > 100) throw new Error("observations must contain 1–100 records");
  const prospective = structuredClone(market);
  const ids = new Set(prospective.observations.map((row) => row.id));
  const cards = new Map([...(prospective.officialCatalog?.cards ?? []), ...prospective.candidates].map((card) => [card.id, card]));
  const auditRows = [];
  for (const row of input.observations) {
    objectFields(row, RECORD, "observation");
    if (ids.has(row.id)) throw new Error("observation needs a new unique ID");
    ids.add(row.id);
    const publicRow = { ...row, title: editorialTitleFor(row, cards) };
    for (const key of AUDIT) delete publicRow[key];
    const comparisonKey = publicationComparison(publicRow, cards.get(row.cardId), row);
    if (comparisonKey) publicRow.comparisonKey = comparisonKey;
    prospective.observations.push(publicRow);
    auditRows.push({ observationId: row.id, sourceId: row.sourceId, publicRowSha256: publicRowSha256(publicRow), publicCardSha256: cards.has(row.cardId) ? publicRowSha256(cards.get(row.cardId)) : null, ...Object.fromEntries(AUDIT.filter((key) => row[key] !== undefined).map((key) => [key, row[key]])) });
  }
  const reviewRecord = { ...input.review, formatVersion: 2, snapshotSha256: inputSha256, records: auditRows };
  const result = validateMarket(prospective, "reviewed snapshot result", { siteRoot, now, pendingRecords: [reviewRecord] });
  if (result.errors.length) throw new Error(result.errors.join("\n"));
  const output = JSON.stringify(prospective, null, 2) + "\n";
  if (Buffer.byteLength(output) > 5 * 1024 * 1024) throw new Error("result exceeds 5 MiB safety limit");
  return { market: prospective, reviewRecord, output, warnings: result.warnings };
}

function locations(siteRoot) {
  const privateRoot = path.join(siteRoot, ".ops-private");
  return { privateRoot, lock: path.join(privateRoot, "review-import.lock"), transaction: path.join(privateRoot, "review-import-transaction") };
}

function regular(file, limit = 6 * 1024 * 1024) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) throw new Error("expected a regular bounded file: " + path.basename(file));
  return fs.readFileSync(file);
}

function replace(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = file + ".tmp-" + randomUUID();
  try {
    const fd = fs.openSync(temporary, "wx");
    try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
}

function acquire(siteRoot, recover) {
  const loc = locations(siteRoot);
  fs.mkdirSync(loc.privateRoot, { recursive: true });
  if (recover && fs.existsSync(loc.lock)) {
    const owner = JSON.parse(regular(loc.lock, 4096));
    if (owner.host !== os.hostname() || !Number.isSafeInteger(owner.pid) || owner.pid < 1) throw new Error("cannot establish stale lock ownership");
    let alive = true;
    try { process.kill(owner.pid, 0); } catch (error) { if (error.code === "ESRCH") alive = false; else throw error; }
    if (alive) throw new Error("import lock is held by a live process");
    fs.unlinkSync(loc.lock);
  }
  const fd = fs.openSync(loc.lock, "wx");
  try { fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, host: os.hostname() })); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  return { ...loc, release: () => fs.unlinkSync(loc.lock) };
}

function cleanTransaction(transaction) {
  // Only known flat staging files are removed. Never follow a journal path for deletion.
  if (!fs.existsSync(transaction)) return;
  const stat = fs.lstatSync(transaction);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("invalid transaction directory");
  const names = fs.readdirSync(transaction);
  if (names.some((name) => !/^(?:journal\.json|backup-[0-3])$/.test(name))) throw new Error("unexpected transaction file; retain for inspection");
  for (const name of names.filter((name) => name !== "journal.json")) { regular(path.join(transaction, name)); fs.unlinkSync(path.join(transaction, name)); }
  fs.rmSync(path.join(transaction, "journal.json"), { force: true });
  fs.rmdirSync(transaction);
}

function restore(siteRoot, transaction) {
  const journalPath = path.join(transaction, "journal.json");
  if (!fs.existsSync(journalPath)) { cleanTransaction(transaction); return; }
  const journal = JSON.parse(regular(journalPath, 16 * 1024));
  if (journal.version !== 1 || !Array.isArray(journal.files) || journal.files.length !== PUBLIC_FILES.length || !/^snapshot-[a-f0-9]{64}\.json$/.test(journal.ledger ?? "")) throw new Error("invalid recovery journal");
  if (["committed", "restored"].includes(journal.phase)) {
    for (const [index, relative] of PUBLIC_FILES.entries()) {
      const expected = journal.phase === "committed" ? journal.committedHashes?.[index] : journal.files[index].sha256;
      if (journal.files[index].relative !== relative || hash(regular(path.join(siteRoot, relative))) !== expected) throw new Error("completed transaction files changed; retain for inspection");
    }
    const ledger = path.join(siteRoot, ".ops-private/review-ledger", journal.ledger);
    if (journal.phase === "committed" ? !fs.existsSync(ledger) || hash(regular(ledger)) !== journal.ledgerSha256 : fs.existsSync(ledger)) throw new Error("completed transaction ledger changed; retain for inspection");
    cleanTransaction(transaction);
    return;
  }
  if (journal.phase !== "prepared") throw new Error("unknown recovery phase");
  const backups = journal.files.map((entry, index) => {
    if (entry.relative !== PUBLIC_FILES[index] || entry.backup !== "backup-" + index) throw new Error("invalid recovery target");
    const bytes = regular(path.join(transaction, entry.backup));
    if (hash(bytes) !== entry.sha256) throw new Error("recovery backup hash mismatch");
    return bytes;
  });
  PUBLIC_FILES.forEach((relative, index) => replace(path.join(siteRoot, relative), backups[index]));
  const ledger = path.join(siteRoot, ".ops-private/review-ledger", journal.ledger);
  if (fs.existsSync(ledger)) {
    const bytes = regular(ledger, 256 * 1024);
    if (hash(bytes) !== journal.ledgerSha256) throw new Error("ledger changed since interrupted import; retain for inspection");
    fs.unlinkSync(ledger);
  }
  replace(journalPath, JSON.stringify({ ...journal, phase: "restored" }));
  cleanTransaction(transaction);
}

export function recoverReviewedImport(siteRoot) {
  const loc = acquire(siteRoot, true);
  try { restore(siteRoot, loc.transaction); } finally { loc.release(); }
}

export async function importReviewedSnapshot(siteRoot, input, { inputSha256, now = Date.now(), dryRun = false, checkpoint = () => {} } = {}) {
  const loc = locations(siteRoot);
  if (fs.existsSync(loc.transaction) || fs.existsSync(loc.lock)) throw new Error("another or interrupted import exists; inspect and run --recover before importing");
  const initial = await validateStaticDist(siteRoot);
  if (initial.errors.length) throw new Error("static preflight failed: " + initial.errors.join("; "));
  const source = path.join(siteRoot, PUBLIC_FILES[0]);
  const before = regular(source);
  const prepared = prepareReviewedSnapshot(input, JSON.parse(before), { siteRoot, inputSha256, now });
  if (dryRun) return { ...prepared, dryRun: true };
  const held = acquire(siteRoot, false);
  try {
    if (fs.existsSync(loc.transaction)) throw new Error("interrupted import must be recovered");
    // Recheck inside the lock: a competing writer may have completed during preflight.
    if (!before.equals(regular(source))) throw new Error("market changed during preflight; retry against the current version");
    const current = await validateStaticDist(siteRoot);
    if (current.errors.length) throw new Error("static data changed during preflight");
    const ledgerName = "snapshot-" + prepared.reviewRecord.snapshotSha256 + ".json";
    const ledgerPath = path.join(siteRoot, ".ops-private/review-ledger", ledgerName);
    if (fs.existsSync(ledgerPath)) throw new Error("private review record already exists");
    fs.mkdirSync(loc.transaction);
    const files = PUBLIC_FILES.map((relative, index) => {
      const bytes = regular(path.join(siteRoot, relative)), backup = "backup-" + index;
      replace(path.join(loc.transaction, backup), bytes);
      return { relative, backup, sha256: hash(bytes) };
    });
    const ledgerBytes = JSON.stringify(prepared.reviewRecord, null, 2) + "\n";
    const journal = { version: 1, phase: "prepared", ledger: ledgerName, ledgerSha256: hash(ledgerBytes), files };
    replace(path.join(loc.transaction, "journal.json"), JSON.stringify(journal));
    try {
      checkpoint("staged");
      replace(ledgerPath, ledgerBytes); checkpoint("ledger");
      replace(source, prepared.output); checkpoint("source");
      replace(path.join(siteRoot, PUBLIC_FILES[1]), prepared.output); checkpoint("dist");
      const build = spawnSync(process.execPath, [path.join(siteRoot, "scripts/build-worker.mjs")], { cwd: siteRoot, encoding: "utf8", timeout: 30_000, windowsHide: true });
      if (build.status !== 0) throw new Error("Worker build failed: " + String(build.stderr ?? build.error ?? "").slice(0, 1000));
      checkpoint("worker");
      const result = validateMarket(prepared.market, "imported market", { siteRoot, now });
      const staticResult = await validateStaticDist(siteRoot);
      if (result.errors.length || staticResult.errors.length) throw new Error([...result.errors, ...staticResult.errors].join("; "));
      checkpoint("validated");
      replace(path.join(loc.transaction, "journal.json"), JSON.stringify({ ...journal, phase: "committed", committedHashes: PUBLIC_FILES.map((relative) => hash(regular(path.join(siteRoot, relative)))) }));
    } catch (error) {
      try { restore(siteRoot, loc.transaction); } catch (recovery) { throw new Error(error.message + "; recovery incomplete: " + recovery.message + "; retain journal and run --recover"); }
      throw new Error("import failed; previous public files restored: " + error.message);
    }
    cleanTransaction(loc.transaction);
    return { ...prepared, dryRun: false };
  } finally { held.release(); }
}
