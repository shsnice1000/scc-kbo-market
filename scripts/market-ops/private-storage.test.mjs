import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensurePrivateDirectory, privateDirectory, resolvePrivateFile } from "./private-storage.mjs";
import { readDatabase, withDatabase } from "./store.mjs";

function temporary(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "scc-private-storage-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function symlinkDirectory(target, location) {
  fs.symlinkSync(target, location, "junction");
}

test("private storage creation and input resolution stay under real .ops-private directories", async (t) => {
  const root = temporary(t);
  const directory = await ensurePrivateDirectory(root, ["inbox", "reviewed"]);
  const file = path.join(directory, "snapshot.json");
  fs.writeFileSync(file, "{}", "utf8");
  assert.equal(await privateDirectory(root, ["inbox", "reviewed"]), directory);
  assert.equal((await resolvePrivateFile(root, path.relative(root, file), "snapshot")).resolved, file);
  await assert.rejects(ensurePrivateDirectory(root, ["..", "public"]), /invalid segment/);
  await assert.rejects(resolvePrivateFile(root, "README.md", "snapshot"), /inside .ops-private/);
});

test("private directory aliases are rejected before database reads or writes", async (t) => {
  const root = temporary(t);
  const outside = path.join(root, "outside");
  fs.mkdirSync(outside);
  symlinkDirectory(outside, path.join(root, ".ops-private"));
  const dataDir = path.join(root, ".ops-private", "market-ops");
  await assert.rejects(ensurePrivateDirectory(root, ["market-ops"]), /real directories/);
  await assert.rejects(withDatabase(dataDir, async () => {}), /real directories/);
  await assert.rejects(readDatabase(dataDir), /real directories/);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test("a symlinked private child directory is rejected by CLI path helpers and database storage", async (t) => {
  const root = temporary(t);
  const privateRoot = path.join(root, ".ops-private");
  const outside = path.join(root, "outside");
  fs.mkdirSync(privateRoot);
  fs.mkdirSync(outside);
  symlinkDirectory(outside, path.join(privateRoot, "market-ops"));
  const dataDir = path.join(privateRoot, "market-ops");
  await assert.rejects(privateDirectory(root, ["market-ops"]), /real directories/);
  await assert.rejects(resolvePrivateFile(root, path.join(".ops-private", "market-ops", "database.json"), "input"), /real directories/);
  await assert.rejects(withDatabase(dataDir, async () => {}), /real directories/);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test("a database file symlink is rejected without reading or replacing its target", async (t) => {
  const root = temporary(t);
  const dataDir = await ensurePrivateDirectory(root, ["market-ops"]);
  const outsideFile = path.join(root, "outside.json");
  fs.writeFileSync(outsideFile, "private target", "utf8");
  const databaseFile = path.join(dataDir, "market-ops.json");
  try {
    fs.symlinkSync(outsideFile, databaseFile, "file");
  } catch (error) {
    if (["EPERM", "EACCES", "UNKNOWN"].includes(error.code)) return t.skip("file symlinks are unavailable in this environment");
    throw error;
  }
  await assert.rejects(withDatabase(dataDir, async () => {}), /regular local database/);
  await assert.rejects(readDatabase(dataDir), /regular local database/);
  assert.equal(fs.readFileSync(outsideFile, "utf8"), "private target");
});
