import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateWorkerArtifact } from "./validate-worker.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOT_FILES = ["index.html", "robots.txt", "sitemap.xml"];
const CONTENT_DIRS = ["assets", "data"];

function filesUnder(base, relativeDir, errors) {
  const absoluteDir = path.join(base, relativeDir);
  let entries;
  try {
    entries = fs.readdirSync(absoluteDir, { withFileTypes: true });
  } catch (error) {
    errors.push(relativeDir + ": cannot read deployable directory (" + error.message + ")");
    return [];
  }
  const files = [];
  for (const entry of entries) {
    const relative = path.posix.join(relativeDir, entry.name);
    const absolute = path.join(base, relativeDir, entry.name);
    if (entry.isSymbolicLink()) errors.push(relative + ": symlinks are not allowed");
    else if (entry.isDirectory()) files.push(...filesUnder(base, relative, errors));
    else if (entry.isFile()) files.push(relative);
    else errors.push(relative + ": unsupported filesystem entry");
  }
  return files;
}

function collect(base, label, errors) {
  const files = new Set();
  for (const name of ROOT_FILES) {
    const absolute = path.join(base, name);
    try {
      const stat = fs.lstatSync(absolute);
      if (!stat.isFile() || stat.isSymbolicLink()) errors.push(label + "/" + name + ": expected a regular file");
      else files.add(name);
    } catch {
      errors.push(label + "/" + name + ": required file is missing");
    }
  }
  for (const dir of CONTENT_DIRS) {
    const absolute = path.join(base, dir);
    try {
      const stat = fs.lstatSync(absolute);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        errors.push(label + "/" + dir + ": expected a regular directory");
        continue;
      }
    } catch {
      errors.push(label + "/" + dir + ": required directory is missing");
      continue;
    }
    for (const file of filesUnder(base, dir, errors)) files.add(file);
  }
  return files;
}

export async function validateStaticDist(siteRoot = root) {
  const errors = [];
  const sourceFiles = collect(siteRoot, "source", errors);
  const distRoot = path.join(siteRoot, "dist");
  const distFiles = collect(distRoot, "dist", errors);
  for (const file of sourceFiles) {
    if (!distFiles.has(file)) {
      errors.push("dist/" + file + ": missing source file");
      continue;
    }
    try {
      if (!fs.readFileSync(path.join(siteRoot, file)).equals(fs.readFileSync(path.join(distRoot, file)))) {
        errors.push("dist/" + file + ": bytes differ from source");
      }
    } catch (error) {
      errors.push(file + ": cannot compare source/dist (" + error.message + ")");
    }
  }
  for (const file of distFiles) if (!sourceFiles.has(file)) errors.push("dist/" + file + ": extra file absent from source");
  const worker = await validateWorkerArtifact(siteRoot);
  errors.push(...worker.errors);
  return { errors, checkedFiles: sourceFiles.size, checkedWorkerAssets: worker.checkedAssets };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await validateStaticDist();
  if (result.errors.length) {
    for (const error of result.errors) console.error("FAIL " + error);
    process.exitCode = 1;
  } else {
    console.log("PASS " + result.checkedFiles + " source/dist files and " + result.checkedWorkerAssets + " Worker routes match exactly");
  }
}
