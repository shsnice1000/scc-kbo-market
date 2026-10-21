import { lstat, mkdir, realpath } from "node:fs/promises";
import path from "node:path";

function normalizeSegments(segments) {
  if (!Array.isArray(segments)) throw new Error("private directory path must be a list of path segments");
  for (const segment of segments) {
    if (typeof segment !== "string" || !segment || segment === "." || segment === ".."
      || segment.includes("/") || segment.includes("\\") || path.basename(segment) !== segment) {
      throw new Error("private directory path contains an invalid segment");
    }
  }
  return segments;
}

async function realDirectory(directory, create) {
  let info;
  try { info = await lstat(directory); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (!info && create) {
    try { await mkdir(directory, { mode: 0o700 }); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
    info = await lstat(directory);
  }
  if (!info) return null;
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error("private storage must use real directories, not symlinks");
  }
  return directory;
}

export async function privateDirectory(workspaceRoot, rawSegments = [], { create = false } = {}) {
  const segments = normalizeSegments(rawSegments);
  const root = await realpath(workspaceRoot);
  let current = path.join(root, ".ops-private");
  if (!await realDirectory(current, create)) return null;
  for (const segment of segments) {
    current = path.join(current, segment);
    if (!await realDirectory(current, create)) return null;
  }
  return current;
}

export function ensurePrivateDirectory(workspaceRoot, segments = []) {
  return privateDirectory(workspaceRoot, segments, { create: true });
}

export async function resolvePrivateFile(workspaceRoot, inputPath, label = "private input") {
  const root = await realpath(workspaceRoot);
  const privateRoot = await privateDirectory(root);
  if (!privateRoot) throw new Error(`${label} requires a real .ops-private directory`);
  if (typeof inputPath !== "string" || !inputPath.trim()) throw new Error(`${label} path is invalid`);
  const candidate = path.resolve(root, inputPath);
  const relative = path.relative(privateRoot, candidate);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} must be inside .ops-private`);
  }
  const segments = relative.split(path.sep);
  let current = privateRoot;
  for (const segment of segments.slice(0, -1)) {
    current = path.join(current, segment);
    if (!await realDirectory(current, false)) throw new Error(`${label} cannot be accessed`);
  }
  current = path.join(current, segments.at(-1));
  let fileStat;
  try { fileStat = await lstat(current); }
  catch { throw new Error(`${label} cannot be accessed`); }
  if (!fileStat.isFile() || fileStat.isSymbolicLink()) throw new Error(`${label} must be a regular, non-symlink file`);
  return { resolved: current, fileStat };
}
