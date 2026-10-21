#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { lstat, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { SOURCE_CATALOG } from "./market-ops/catalog.mjs";
import { runIngest, runRefresh } from "./market-ops/refresh.mjs";
import { validateSnapshot } from "./market-ops/snapshot.mjs";
import { buildSnapshotTemplate } from "./market-ops/snapshot-template.mjs";
import { applyPrivateObservation, pruneExpired, readDatabase, retractObservation, restoreSuppressedListing, withDatabase } from "./market-ops/store.mjs";
import { refreshExitCode } from "./market-ops/run-outcome.mjs";
import { databaseHealth } from "./market-ops/database-health.mjs";
import { readPrivateObservation } from "./market-ops/private-observation.mjs";
import { buildBunjangCatalogSnapshot, bunjangCatalogGeneratedAt } from "./market-ops/collectors/bunjang-catalog.mjs";
import { createBunjangSearchCollector } from "./market-ops/collectors/bunjang-search.mjs";
import { buildMatchReviewTemplate, reviewCardMatch } from "./market-ops/matching.mjs";
import { buildMatchReviewTemplateV2 } from "./market-ops/identity.mjs";
import { readReviewQueue, updateReviewQueue, upsertReviewCase, recordMatchDecision, summarizeReviewQueue } from "./market-ops/review-queue.mjs";
import { buildSampleReadiness, formatSampleReadiness } from "./market-ops/sample-readiness.mjs";
import { parseRefreshArgs } from "./market-ops/refresh-args.mjs";
import { createReadStream } from "node:fs";
import { buildPublicationDraft, createPublicationSelectionTemplate, readPublicationSelection, writePublicationDraft } from "./market-ops/publication-export.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = path.join(root, ".ops-private", "market-ops");

function help() {
  console.log(`SCC Market local operations MVP

Usage:
  node scripts/market-ops.mjs status
  node scripts/market-ops.mjs health
  node scripts/market-ops.mjs refresh [--snapshot <reviewed.json> ...] [--scheduled]
  node scripts/market-ops.mjs refresh --inbox [--scheduled]
  node scripts/market-ops.mjs refresh --bunjang-config .ops-private/bunjang/collector-config.json [--scheduled]
  node scripts/market-ops.mjs template [source-id]
  node scripts/market-ops.mjs bunjang-search-template
  node scripts/market-ops.mjs ingest <reviewed.json>
  node scripts/market-ops.mjs bunjang-catalog-template
  node scripts/market-ops.mjs bunjang-catalog-import <full|segment> <.csv.gz> <private-config.json>
  node scripts/market-ops.mjs match-template <case-id>
  node scripts/market-ops.mjs match-review <private-match-case.json>
  node scripts/market-ops.mjs match-queue-add <private-queue-input.json>
  node scripts/market-ops.mjs match-queue-list
  node scripts/market-ops.mjs match-queue-decide <case-id> <approve|defer|reject> <private-evidence-ref> [comparison-group-uuid]
  node scripts/market-ops.mjs publication-export-template
  node scripts/market-ops.mjs publication-export <.ops-private/publication-export/selection.json> [--dry-run]
  node scripts/market-ops.mjs history <source-id> <external-id>
  node scripts/market-ops.mjs private-note <private-observation.json>
  node scripts/market-ops.mjs private-template <note-id>
  node scripts/market-ops.mjs private-list
  node scripts/market-ops.mjs private-history <note-id>
  node scripts/market-ops.mjs sample-readiness
  node scripts/market-ops.mjs retract <source-id> <external-id> <reason-code> <private-evidence-ref>
  node scripts/market-ops.mjs restore <source-id> <external-id> <private-evidence-ref> <reviewer-role>
  node scripts/market-ops.mjs prune

Snapshot files must contain only reviewed metadata. See docs/6플랫폼-MVP-2-3단계.md.
Normalized operation data is stored under .ops-private/market-ops/; inputs and templates stay in other .ops-private folders. All are excluded from Git.
Platform templates deliberately fail review until real permission is recorded.
The Bunjang search collector runs only when the explicit --bunjang-config option points to a private config and token provider; it makes partner API requests.
Private notes from user-provided screenshots or manually checked public UI are stored separately from platform snapshots and are never eligible for public-site export.
Publication export requires a separately reviewed selection, current source permission, independent-market origin, and approved exact physical-copy identity. It writes only to .ops-private/publication-export/drafts; it never updates public site files.
No platform request is sent by default. A valid private Bunjang config and explicit --bunjang-config option enable the partner search collector for that run only.
Use --scheduled only in the configured operating-system scheduler action; ordinary manual runs are recorded separately. This flag records the invocation source and does not create or enable a schedule.
Multiple same-source snapshots are accepted only for a same-scope Bunjang Full/Segment catalog sequence. Processed feeds are skipped by a private watermark; a Segment gap over 24 hours requires a new Full baseline.
`);
}

function isWithinDirectory(parent, target) {
  const relative = path.relative(parent, target);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function resolvePrivateBunjangFile(filePath, label) {
  const privateRoot = path.join(root, ".ops-private");
  const privateDir = path.join(root, ".ops-private", "bunjang");
  const inputPath = path.resolve(root, filePath);
  const privateRootStat = await lstat(privateRoot).catch(() => null);
  const privateDirStat = await lstat(privateDir).catch(() => null);
  if (!privateRootStat?.isDirectory() || privateRootStat.isSymbolicLink() || !privateDirStat?.isDirectory() || privateDirStat.isSymbolicLink()) {
    throw new Error("Bunjang private config path must use real .ops-private/bunjang directories");
  }
  const privateDirReal = await realpath(privateDir).catch(() => null);
  if (!privateDirReal) throw new Error("Bunjang collector config directory is missing; create .ops-private/bunjang after confirming partner approval");
  const inputStat = await lstat(inputPath).catch(() => null);
  if (!inputStat?.isFile() || inputStat.isSymbolicLink()) throw new Error(`${label} must be a regular, non-symlink file under .ops-private/bunjang`);
  const fileReal = await realpath(inputPath);
  if (!isWithinDirectory(privateDirReal, fileReal)) throw new Error(`${label} must resolve inside .ops-private/bunjang`);
  return fileReal;
}

async function loadBunjangCollector(configArgument) {
  const configPath = await resolvePrivateBunjangFile(configArgument, "Bunjang config");
  const raw = await readFile(configPath, "utf8");
  if (Buffer.byteLength(raw, "utf8") > 256 * 1024) throw new Error("Bunjang collector config exceeds 256 KiB");
  let config;
  try {
    config = JSON.parse(raw);
  } catch {
    throw new Error("Bunjang collector config must be valid JSON");
  }
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("Bunjang collector config must be a JSON object");
  const allowedKeys = new Set([
    "schemaVersion", "permissionConfirmed", "permissionEvidenceRef", "termsReviewedAt",
    "historyStorageAllowed", "publicationAllowed", "retentionDays", "queryPlans",
    "pageSize", "maxPagesPerQuery", "requestIntervalMs", "maxRetries", "tokenProviderModule",
  ]);
  for (const key of Object.keys(config)) {
    if (!allowedKeys.has(key)) throw new Error(`unsupported Bunjang config field: ${key}`);
  }
  if (config.schemaVersion !== 1) throw new Error("Bunjang collector config schemaVersion must be 1");
  if (typeof config.tokenProviderModule !== "string" || !config.tokenProviderModule.trim()) throw new Error("Bunjang config must name a separate private tokenProviderModule; token values are not accepted in JSON");
  if (config.permissionConfirmed !== true || config.historyStorageAllowed !== true || config.publicationAllowed !== true) {
    throw new Error("Bunjang collector remains disabled until partner, history-storage and display permission are explicitly confirmed");
  }
  if (!Array.isArray(config.queryPlans) || config.queryPlans.some((plan) => !plan || typeof plan !== "object" || Array.isArray(plan) || Object.keys(plan).some((key) => !["query", "scopeLabel", "categoryId"].includes(key)))) {
    throw new Error("Bunjang queryPlans must contain only query, scopeLabel and optional categoryId fields");
  }
  createBunjangSearchCollector({
    ...config,
    getBearerToken: async () => { throw new Error("Bunjang token provider is not called during config validation"); },
  });
  const providerPath = path.resolve(path.dirname(configPath), config.tokenProviderModule);
  const providerRealPath = await resolvePrivateBunjangFile(path.relative(root, providerPath), "Bunjang token provider");
  if (path.extname(providerRealPath).toLowerCase() !== ".mjs") throw new Error("Bunjang token provider must be an .mjs module");
  const provider = await import(pathToFileURL(providerRealPath).href);
  if (typeof provider.getBearerToken !== "function") throw new Error("Bunjang token provider must export async getBearerToken()");
  return createBunjangSearchCollector({
    ...config,
    getBearerToken: provider.getBearerToken,
  });
}

async function listInboxSnapshots() {
  const inboxDir = path.join(root, ".ops-private", "inbox");
  let entries;
  try {
    entries = await readdir(inboxDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") throw new Error("reviewed snapshot inbox does not exist; create .ops-private/inbox first");
    throw error;
  }
  const files = entries
    .filter((entry) => entry.isFile() && path.extname(entry.name).toLowerCase() === ".json")
    .map((entry) => path.join(inboxDir, entry.name))
    .sort();
  if (!files.length) throw new Error("reviewed snapshot inbox has no JSON files");
  return files;
}

async function createTemplates(sourceId) {
  const selected = sourceId ? SOURCE_CATALOG.filter((source) => source.id === sourceId) : SOURCE_CATALOG;
  if (!selected.length) throw new Error(`unknown source id: ${sourceId}`);
  const templateDir = path.join(root, ".ops-private", "templates");
  await mkdir(templateDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const created = [];
  for (const source of selected) {
    const filePath = path.join(templateDir, `${source.id}-${stamp}.json`);
    await writeFile(filePath, `${JSON.stringify(buildSnapshotTemplate(source.id), null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    created.push(path.relative(root, filePath));
  }
  console.log(`Created ${created.length} private snapshot template(s):`);
  for (const filePath of created) console.log(`  ${filePath}`);
  console.log("Replace the permission and coverage placeholders only after verifying the platform terms and actual permission. Templates are not importable as-is.");
}

async function createBunjangSearchTemplate() {
  const templateDir = path.join(root, ".ops-private", "bunjang");
  await mkdir(templateDir, { recursive: true });
  const files = [
    {
      path: path.join(templateDir, "collector-config.json"),
      content: `${JSON.stringify({
        schemaVersion: 1,
        permissionConfirmed: false,
        permissionEvidenceRef: "REPLACE_WITH_PRIVATE_PARTNER_PERMISSION_REF",
        termsReviewedAt: "REPLACE_WITH_VERIFIED_UTC_TIMESTAMP",
        historyStorageAllowed: false,
        publicationAllowed: false,
        retentionDays: 30,
        queryPlans: [{ query: "REPLACE_WITH_APPROVED_QUERY", scopeLabel: "REPLACE_WITH_APPROVED_SCOPE", categoryId: null }],
        pageSize: 100,
        maxPagesPerQuery: 10,
        requestIntervalMs: 1000,
        maxRetries: 2,
        tokenProviderModule: "token-provider.mjs",
      }, null, 2)}\n`,
    },
    {
      path: path.join(templateDir, "token-provider.mjs"),
      content: `export async function getBearerToken() {\n  throw new Error("No token provider configured. Confirm Bunjang's official signing format and connect an approved OS credential store.");\n}\n`,
    },
  ];
  for (const file of files) {
    if (await lstat(file.path).catch(() => null)) throw new Error(`refusing to overwrite existing Bunjang private file: ${path.relative(root, file.path)}`);
  }
  const created = [];
  try {
    for (const file of files) {
      await writeFile(file.path, file.content, { encoding: "utf8", flag: "wx", mode: 0o600 });
      created.push(file.path);
    }
  } catch (error) {
    await Promise.all(created.map((filePath) => rm(filePath, { force: true })));
    throw new Error(`could not create inactive Bunjang search template: ${error.message}`);
  }
  console.log("Created inactive private Bunjang collector files:");
  for (const file of files) console.log(`  ${path.relative(root, file.path)}`);
  console.log("Partner permission, search scope, secure token provider, and publication/history rights remain unset. No API request was sent.");
}

async function privateInputPath(inputPath, label) {
  const privateRoot = await realpath(path.join(root, ".ops-private"));
  let resolved;
  try {
    resolved = await realpath(path.resolve(inputPath));
  } catch {
    throw new Error(`${label} cannot be accessed`);
  }
  if (!resolved.startsWith(`${privateRoot}${path.sep}`)) throw new Error(`${label} must be stored under .ops-private`);
  const fileStat = await stat(resolved);
  if (!fileStat.isFile()) throw new Error(`${label} must be a regular file`);
  return { resolved, fileStat };
}

async function reviewMatchCase(inputPath) {
  const { resolved, fileStat } = await privateInputPath(inputPath, "Match review case");
  if (fileStat.size > 100 * 1024) throw new Error("match review case exceeds 100 KiB");
  const input = JSON.parse(await readFile(resolved, "utf8"));
  const result = reviewCardMatch(input);
  console.log(JSON.stringify({ scope: "local_match_review_only", ...result }, null, 2));
  console.log("This is a deterministic identity check, not a public approval. Do not publish a match without human review and source permission.");
}

async function createMatchReviewTemplate(caseId) {
  const template = buildMatchReviewTemplateV2(caseId);
  const templateDir = path.join(root, ".ops-private", "match-cases");
  await mkdir(templateDir, { recursive: true });
  const filePath = path.join(templateDir, `${caseId}.json`);
  await writeFile(filePath, `${JSON.stringify(template, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  console.log(`Created private card-match review template: ${path.relative(root, filePath)}`);
  console.log("Fill only confirmed identity values. Leave unknowns null; seller titles, accounts, contacts, photos and descriptions are not accepted fields.");
}

async function addMatchReviewQueue(inputPath) {
  const { resolved, fileStat } = await privateInputPath(inputPath, "Match queue input");
  if (fileStat.size > 100 * 1024) throw new Error("match queue input exceeds 100 KiB");
  const input = JSON.parse(await readFile(resolved, "utf8"));
  const result = await updateReviewQueue(root, (queue) => upsertReviewCase(queue, input));
  console.log(JSON.stringify({ changed: result.changed, caseId: result.entry.caseId, status: result.entry.status, revision: result.entry.revision, proposal: result.entry.proposal, publicPublicationAllowed: false }, null, 2));
}

async function decideMatchReviewQueue(caseId, decision, evidenceRef, comparisonGroupId) {
  const result = await updateReviewQueue(root, (queue) => recordMatchDecision(queue, caseId, decision, evidenceRef, new Date(), comparisonGroupId ?? null));
  console.log(JSON.stringify({ changed: result.changed, caseId: result.entry.caseId, status: result.entry.status, identityComparable: result.entry.proposal.identityComparable, comparisonGroupId: result.entry.review?.comparisonGroupId ?? null, publicPublicationAllowed: false }, null, 2));
}

async function createBunjangCatalogTemplate() {
  const templateDir = path.join(root, ".ops-private", "templates");
  await mkdir(templateDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:.]/g, "");
  const filePath = path.join(templateDir, `bunjang-catalog-${stamp}.json`);
  const template = {
    permissionConfirmed: false,
    permissionEvidenceRef: "REPLACE_WITH_REAL_PRIVATE_PERMISSION_REF",
    publicationBasis: "partner_contract",
    termsReviewedAt: new Date().toISOString(),
    historyStorageAllowed: false,
    publicationAllowed: false,
    retentionDays: 30,
    queryTerms: ["2026 SCC", "SENSATION", "센세이션", "김민석", "최형우"],
    scopeLabel: "2026 SCC SENSATION KBO card candidates",
  };
  await writeFile(filePath, `${JSON.stringify(template, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  console.log(`Created private Bunjang Catalog config template: ${path.relative(root, filePath)}`);
  console.log("It is intentionally disabled. A user approval does not replace the provider partner contract or its data rights.");
}

async function importBunjangCatalog(mode, catalogPath, configPath) {
  if (!new Set(["full", "segment"]).has(mode)) throw new Error("catalog mode must be full or segment");
  const { resolved: catalogFile, fileStat } = await privateInputPath(catalogPath, "Catalog file");
  const { resolved: configFile, fileStat: configStat } = await privateInputPath(configPath, "Catalog permission config");
  const filePattern = mode === "full" ? /^full-\d{8}\.csv\.gz$/i : /^segment-\d{8}_\d{2}\.csv\.gz$/i;
  if (!filePattern.test(path.basename(catalogFile))) throw new Error(`file name does not match the official ${mode} Catalog naming pattern`);
  const catalogGeneratedAt = bunjangCatalogGeneratedAt(mode, path.basename(catalogFile));
  if (configStat.size > 1024 * 1024) throw new Error("Catalog permission config exceeds 1 MiB");
  let config;
  try {
    config = JSON.parse(await readFile(configFile, "utf8"));
  } catch {
    throw new Error("Catalog permission config is not valid JSON");
  }
  const allowedConfigFields = new Set([
    "permissionConfirmed", "permissionEvidenceRef", "publicationBasis", "termsReviewedAt", "historyStorageAllowed",
    "publicationAllowed", "retentionDays", "queryTerms", "scopeLabel", "maxUncompressedBytes",
  ]);
  if (!config || typeof config !== "object" || Array.isArray(config) || Object.keys(config).some((key) => !allowedConfigFields.has(key))) {
    throw new Error("Catalog permission config contains unsupported fields");
  }
  if (fileStat.size > 2 * 1024 * 1024 * 1024) throw new Error("Catalog gzip exceeds 2 GiB");
  const catalogStream = createReadStream(catalogFile);
  let result;
  try {
    result = await buildBunjangCatalogSnapshot(catalogStream, { ...config, mode, catalogFileName: path.basename(catalogFile), catalogGeneratedAt });
  } catch (error) {
    catalogStream.destroy();
    throw error;
  }
  validateSnapshot(result.snapshot);
  const inboxDir = path.join(root, ".ops-private", "inbox");
  await mkdir(inboxDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:.]/g, "");
  const outputPath = path.join(inboxDir, `bunjang-${mode}-${stamp}.json`);
  await writeFile(outputPath, `${JSON.stringify(result.snapshot, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  console.log(`Created Bunjang ${mode} Catalog candidate snapshot: ${path.relative(root, outputPath)}`);
  console.log(`Parsed ${result.catalogMetadata.parsedRecords} product records; retained ${result.catalogMetadata.matchedRecords} query matches.`);
  console.log("The source file stayed local and was not sent to a platform. Review the private snapshot, then use refresh --snapshot or refresh --inbox.");
}

function printRun(run) {
  console.log(`Run ${run.id} — ${run.state} — ${run.startedAt}`);
  for (const result of run.sources) {
    const source = SOURCE_CATALOG.find((item) => item.id === result.sourceId);
    const tail = ["snapshot_unchanged", "collector_unchanged"].includes(result.state)
      ? "duplicate input; existing observations and retention unchanged"
      : ["snapshot_imported", "collector_updated"].includes(result.state)
      ? `${result.imported} observations, ${result.eventsAdded} events added`
      : result.error;
    console.log(`  ${source.name.padEnd(12)} ${result.state.padEnd(18)} ${tail}`);
    if (result.snapshotBatch?.kind === "full_plus_segments") {
      console.log(`    Bunjang baseline: ${result.snapshotBatch.fullFeed} + ${result.snapshotBatch.count - 1} ordered segments (${result.snapshotBatch.firstSegment} through ${result.snapshotBatch.lastSegment}); missing hourly intervals=${result.snapshotBatch.missingIntervals}`);
    } else if (result.snapshotBatch) {
      const previous = result.snapshotBatch.previousFeed ? ` from ${result.snapshotBatch.previousFeed}` : "";
      const feedLabel = result.snapshotBatch.count === 1 ? "feed" : "feeds";
      console.log(`    Ordered Bunjang segment batch: ${result.snapshotBatch.count} ${feedLabel}${previous} through ${result.snapshotBatch.lastSegment}; missing hourly intervals=${result.snapshotBatch.missingIntervals}`);
    }
  }
  const refreshed = run.sources.filter((item) => ["snapshot_imported", "collector_updated"].includes(item.state)).length;
  console.log(`Sources updated in this run: ${refreshed}/6. Collector requests, if any, were explicitly configured for this run.`);
  for (const item of run.sources.filter((row) => row.coverage)) {
    if (item.coverage.recorded === false) console.log(`  Coverage ${item.sourceId}: not recorded (legacy snapshot)`);
    else console.log(`  Coverage ${item.sourceId}: ${item.coverage.level}, ${item.coverage.pagesVisited} page(s), stopped=${item.coverage.stopReason}; ${item.coverage.scope}`);
  }
  for (const error of run.inputErrors ?? []) console.log(`  Input error: ${error}`);
  if (run.pruned?.observations || run.pruned?.priceEvents) {
    console.log(`Retention cleanup: ${run.pruned.observations} observations, ${run.pruned.priceEvents} price events removed.`);
  }
}

async function showStatus() {
  const refreshLockPath = path.join(dataDir, "market-ops.refresh.lock");
  try {
    const refreshLockStat = await lstat(refreshLockPath);
    if (!refreshLockStat.isFile() || refreshLockStat.isSymbolicLink()) {
      console.log("Refresh lock: present but not a regular file; inspect before running another refresh.");
    } else {
      let refreshLock = null;
      try {
        refreshLock = JSON.parse(await readFile(refreshLockPath, "utf8"));
      } catch {
        // A partial or unreadable lock remains operator-owned; status must not change it.
      }
      const pid = Number.isInteger(refreshLock?.pid) ? `pid=${refreshLock.pid}` : "pid=unknown";
      const startedAt = typeof refreshLock?.startedAt === "string" ? ` started=${refreshLock.startedAt}` : "";
      console.log(`Refresh lock: present (${pid}${startedAt}); confirm the process is stopped before manual recovery.`);
    }
  } catch (error) {
    if (error.code !== "ENOENT") console.log("Refresh lock: could not be inspected; do not start another refresh until checked.");
  }
  await withDatabase(dataDir, async (db) => {
    const pruned = pruneExpired(db);
    console.log(`SCC Market local operations — schema ${db.schemaVersion}`);
    console.log(`Database last saved ${db.updatedAt}; local observations ${db.observations.length}; price events ${db.priceEvents.length}`);
    console.log(`Reviewed local correction records ${db.correctionEvents?.length ?? 0}`);
    const privateObservations = db.privateObservations ?? [];
    const privateUiCount = privateObservations.filter((row) => row.captureMethod === "manual-browser-ui").length;
    const privateScreenshotCount = privateObservations.length - privateUiCount;
    console.log(`Private-only observations ${privateObservations.length} (screenshots ${privateScreenshotCount}, direct UI ${privateUiCount}); confirmed listing price/shipping changes ${db.privatePriceEvents?.filter((event) => ["asking_price_changed", "shipping_price_changed"].includes(event.type)).length ?? 0}`);
    console.log("Persistent automated collectors: 0/6. The private Bunjang template is inactive; API requests require a valid per-run config and token provider.");
    for (const source of SOURCE_CATALOG) {
      const status = db.sourceStatus[source.id];
      const latest = db.observations.filter((row) => row.sourceId === source.id).sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt))[0];
      const last = status.lastSuccessAt ?? "no snapshot";
      const freshness = latest ? (Date.now() - Date.parse(latest.lastSeenAt) >= 7 * 86_400_000 ? "stale>=7d" : "observed<7d") : "no records";
      const coverage = !status.coverage || status.coverage.recorded === false
        ? " coverage=not-recorded"
        : ` coverage=${status.coverage.level}/${status.coverage.pagesVisited}p/${status.coverage.stopReason}`;
      const collector = status.collectorConnected === true ? ` collector=connected last-collector-success=${status.lastCollectorSuccessAt ?? "unknown"}` : " collector=not-connected";
      console.log(`  ${source.id.padEnd(12)} ${String(status.state).padEnd(19)} records=${status.recordCount} last=${last}${collector}${latest ? ` newest=${latest.lastSeenAt} ${freshness}` : ` ${freshness}`}${coverage}`);
    }
    const latestRun = db.runs.at(-1);
    if (latestRun) console.log(`Latest refresh ${latestRun.id}: ${latestRun.state}`);
    if (pruned.observations || pruned.priceEvents) console.log(`Retention cleanup: ${pruned.observations} observations, ${pruned.priceEvents} price events removed.`);
  });
}

async function showHistory(sourceId, externalId) {
  const source = SOURCE_CATALOG.find((item) => item.id === sourceId);
  if (!source) throw new Error(`unknown source id: ${sourceId}`);
  await withDatabase(dataDir, async (db) => {
    pruneExpired(db);
    const listingKey = `${sourceId}:${externalId}`;
    const observation = db.observations.find((row) => row.listingKey === listingKey);
    const correctionEvents = (db.correctionEvents ?? []).filter((event) => event.listingKey === listingKey);
    if (!observation && !correctionEvents.length) throw new Error(`no stored observation or correction record: ${listingKey}`);
    console.log(JSON.stringify({
      observation: observation ?? null,
      priceEvents: observation ? db.priceEvents.filter((event) => event.listingKey === listingKey) : [],
      correctionEvents,
    }, null, 2));
  });
}

async function ingestPrivateNote(inputFile) {
  const observation = await readPrivateObservation(path.resolve(inputFile), { workspaceRoot: root });
  const result = await withDatabase(dataDir, async (db) => applyPrivateObservation(db, observation));
  if (result.duplicate) {
    console.log(`Private-only note already recorded: ${observation.noteId} (same evidence content)`);
    return;
  }
  console.log(`Private-only observation recorded: ${observation.noteId}`);
  console.log(`  ${observation.sourceName}; ${observation.priceType} ${observation.price.toLocaleString("en-US")} KRW + ${observation.shippingPrice === null ? "shipping unknown" : `${observation.shippingPrice.toLocaleString("en-US")} KRW shipping`}`);
  console.log(`  Checked time: ${observation.observedAt ?? "unknown from screenshot"}; current listing status: unknown`);
  console.log(`  Capture: ${observation.captureMethod}; local storage only; public display and provider API access are disabled.`);
  if (result.eventsAdded) console.log(`  Private history event added: ${result.eventsAdded}`);
}

async function createPrivateFollowUpTemplate(noteId) {
  if (typeof noteId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(noteId)) throw new Error("note-id has an invalid format");
  await withDatabase(dataDir, async (db) => {
    const previous = [...(db.privateObservations ?? [])].reverse().find((row) => row.noteId === noteId);
    if (!previous) throw new Error(`no private-only observation to follow: ${noteId}`);
    const template = {
      schemaVersion: 1,
      noteId: previous.noteId,
      sourceId: previous.sourceId,
      sourceUrl: previous.sourceUrl,
      subject: previous.subject,
      matchLevel: previous.matchLevel,
      matchNote: previous.matchNote,
      priceType: "asking",
      price: 0,
      shippingPrice: null,
      observedAt: null,
      captureMethod: previous.captureMethod ?? "user-provided-screenshot",
      evidenceFile: previous.captureMethod === "manual-browser-ui" ? null : "REPLACE_WITH_WORKSPACE_RELATIVE_IMAGE_PATH",
      privateAuthorization: previous.privateAuthorization,
    };
    const templateDir = path.join(root, ".ops-private", "private-observations");
    await mkdir(templateDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:.]/g, "").replace(/Z$/, "Z");
    const filePath = path.join(templateDir, `${noteId}-followup-${stamp}.json`);
    await writeFile(filePath, `${JSON.stringify(template, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    console.log(`Created private follow-up template: ${path.relative(root, filePath)}`);
    console.log("Set the ask, shipping and observedAt. For manual-browser-ui, keep the canonical sourceUrl and set observedAt; for a screenshot, provide evidenceFile. Keep the same noteId only for repeat observations of the same listing.");
  });
}

async function listPrivateNotes() {
  await withDatabase(dataDir, async (db) => {
    const latestById = new Map();
    for (const row of db.privateObservations ?? []) latestById.set(row.noteId, row);
    if (!latestById.size) {
      console.log("No private-only observations.");
      return;
    }
    console.log("Private-only observations (not current listing status):");
    for (const row of [...latestById.values()].sort((a, b) => a.noteId.localeCompare(b.noteId))) {
      const shipping = row.shippingPrice === null ? "shipping ?" : `shipping ${row.shippingPrice.toLocaleString("en-US")} KRW`;
      const when = row.observedAt ?? "observation time unknown";
      console.log(`  ${row.noteId} | ${row.price.toLocaleString("en-US")} KRW + ${shipping} | ${when} | ${row.captureMethod ?? "user-provided-screenshot"} | current status unknown`);
    }
  });
}

async function showPrivateHistory(noteId) {
  if (typeof noteId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(noteId)) throw new Error("note-id has an invalid format");
  await withDatabase(dataDir, async (db) => {
    const observations = (db.privateObservations ?? []).filter((row) => row.noteId === noteId);
    if (!observations.length) throw new Error(`no private-only observation: ${noteId}`);
    console.log(JSON.stringify({
      scope: "private_only",
      observations,
      priceEvents: (db.privatePriceEvents ?? []).filter((event) => event.noteId === noteId),
    }, null, 2));
  });
}

async function exportPublicationDraft(selectionArgument, dryRun) {
  const selection = await readPublicationSelection(root, selectionArgument);
  const [db, queue] = await Promise.all([readDatabase(dataDir), readReviewQueue(root)]);
  if (!db) throw new Error("operations database has no imported public observations");
  const siteRoot = path.join(root, "site-source");
  const market = JSON.parse(await readFile(path.join(siteRoot, "data", "market.json"), "utf8"));
  const draft = buildPublicationDraft({ db, queue, selection, market, siteRoot, now: Date.now() });
  const result = await writePublicationDraft(root, draft, { dryRun });
  if (dryRun) console.log(`DRY RUN: ${result.observationCount} eligible observation(s); private draft would be ${result.path}; sha256 ${result.sha256}`);
  else console.log(`${result.alreadyExists ? "Existing" : "Created"} private publication draft: ${result.path} (${result.observationCount} observation(s), sha256 ${result.sha256})`);
}

async function retractPublicObservation(sourceId, externalId, reasonCode, evidenceRef) {
  const result = await withDatabase(dataDir, async (db) => retractObservation(db, sourceId, externalId, reasonCode, evidenceRef));
  if (!result.retracted) {
    console.log(`Already suppressed ${sourceId}:${externalId}; no observations or history restored.`);
    return;
  }
  console.log(`Retracted ${sourceId}:${externalId} from the local public snapshot store.`);
  console.log(`  Removed observations: ${result.observationsRemoved}; price-history events: ${result.priceEventsRemoved}`);
  console.log(`  Correction reason: ${reasonCode}; private evidence reference: ${evidenceRef}`);
  console.log("Future imports for this listing are suppressed. Restore with reviewed evidence, then collect a newer observation before re-importing. The public site must be corrected separately.");
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === "help" || command === "--help" || command === "-h") return help();
  if (command === "status" && !args.length) return showStatus();
  if (command === "health" && !args.length) {
    const health = await databaseHealth(dataDir);
    console.log(JSON.stringify(health, null, 2));
    process.exitCode = health.exitCode;
    return;
  }
  if (command === "refresh") {
    const options = parseRefreshArgs(args);
    if (options.inbox) options.snapshotFiles = await listInboxSnapshots();
    const collectors = options.bunjangConfigPath
      ? { bunjang: await loadBunjangCollector(options.bunjangConfigPath) }
      : {};
    const result = await runRefresh({ dataDir, snapshotFiles: options.snapshotFiles, collectors, runOrigin: options.runOrigin });
    printRun(result.run);
    process.exitCode = refreshExitCode(result.run);
    return;
  }
  if (command === "template" && args.length <= 1) return createTemplates(args[0]);
  if (command === "bunjang-search-template" && !args.length) return createBunjangSearchTemplate();
  if (command === "bunjang-catalog-template" && !args.length) return createBunjangCatalogTemplate();
  if (command === "bunjang-catalog-import" && args.length === 3) return importBunjangCatalog(args[0], args[1], args[2]);
  if (command === "match-template" && args.length === 1) return createMatchReviewTemplate(args[0]);
  if (command === "match-review" && args.length === 1) return reviewMatchCase(args[0]);
  if (command === "match-queue-add" && args.length === 1) return addMatchReviewQueue(args[0]);
  if (command === "match-queue-list" && !args.length) {
    console.log(JSON.stringify(summarizeReviewQueue(await readReviewQueue(root)), null, 2));
    return;
  }
  if (command === "match-queue-decide" && (args.length === 3 || args.length === 4)) return decideMatchReviewQueue(...args);
  if (command === "publication-export-template" && !args.length) {
    const result = await createPublicationSelectionTemplate(root);
    console.log(`${result.created ? "Created" : "Preserved existing"} private publication selection template: ${result.path}`);
    return;
  }
  if (command === "publication-export") {
    const dryRun = args.includes("--dry-run");
    const files = args.filter((argument) => argument !== "--dry-run");
    if (files.length !== 1) throw new Error("publication-export needs one selection JSON path and optional --dry-run");
    return exportPublicationDraft(files[0], dryRun);
  }
  if (command === "ingest" && args.length === 1) {
    const result = await runIngest({ dataDir, snapshotFile: path.resolve(args[0]) });
    printRun(result.run);
    const imported = result.run.sources.find((source) => source.state === "snapshot_imported");
    if (!imported) process.exitCode = 1;
    return;
  }
  if (command === "history" && args.length === 2) return showHistory(args[0], args[1]);
  if (command === "private-note" && args.length === 1) return ingestPrivateNote(args[0]);
  if (command === "private-template" && args.length === 1) return createPrivateFollowUpTemplate(args[0]);
  if (command === "private-list" && !args.length) return listPrivateNotes();
  if (command === "private-history" && args.length === 1) return showPrivateHistory(args[0]);
  if (command === "sample-readiness" && !args.length) {
    const report = await buildSampleReadiness({
      sampleDir: path.join(root, ".ops-private", "sample-prep", "2026-sensation"),
    });
    console.log(formatSampleReadiness(report));
    return;
  }
  if (command === "retract" && args.length === 4) return retractPublicObservation(args[0], args[1], args[2], args[3]);
  if (command === "restore" && args.length === 4) {
    const result = await withDatabase(dataDir, async (db) => restoreSuppressedListing(db, ...args));
    console.log(JSON.stringify(result));
    return;
  }
  if (command === "prune" && !args.length) {
    const pruned = await withDatabase(dataDir, async (db) => pruneExpired(db));
    console.log(`Removed ${pruned.observations} observations, ${pruned.priceEvents} price events, ${pruned.reviewLedger} review records.`);
    return;
  }
  throw new Error(`unknown command or invalid arguments: ${command}`);
}

main().catch((error) => {
  console.error(`ERROR ${error.message}`);
  process.exitCode = 1;
});
