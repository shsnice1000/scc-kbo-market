import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const routes = [
  ["/", "index.html", "text/html; charset=utf-8"],
  ["/index.html", "index.html", "text/html; charset=utf-8"],
  ["/assets/favicon.svg", "assets/favicon.svg", "image/svg+xml; charset=utf-8"],
  ["/assets/market.js", "assets/market.js", "text/javascript; charset=utf-8"],
  ["/assets/og-preview.png", "assets/og-preview.png", "image/png"],
  ["/assets/record-flow.svg", "assets/record-flow.svg", "image/svg+xml; charset=utf-8"],
  ["/assets/site.css", "assets/site.css", "text/css; charset=utf-8"],
  ["/data/market.json", "data/market.json", "application/json; charset=utf-8"],
  ["/robots.txt", "robots.txt", "text/plain; charset=utf-8"],
  ["/sitemap.xml", "sitemap.xml", "application/xml; charset=utf-8"],
];
const requiredHeaders = {
  "content-security-policy": /frame-ancestors 'none'/,
  "referrer-policy": /^strict-origin-when-cross-origin$/,
  "x-content-type-options": /^nosniff$/,
  "x-frame-options": /^DENY$/,
  "permissions-policy": /camera=().*microphone=().*geolocation=()/,
  "strict-transport-security": /^max-age=31536000$/,
};

export async function validateWorkerArtifact(siteRoot = root) {
  const errors = [];
  const fail = (message) => errors.push(message);
  const sourceManifestPath = path.join(siteRoot, ".openai", "hosting.json");
  const distManifestPath = path.join(siteRoot, "dist", ".openai", "hosting.json");
  const workerSourcePath = path.join(siteRoot, "worker", "index.js");
  const workerDistPath = path.join(siteRoot, "dist", "server", "index.js");
  let moduleWorker;

  try {
    const sourceManifest = JSON.parse(fs.readFileSync(sourceManifestPath, "utf8"));
    const distManifest = JSON.parse(fs.readFileSync(distManifestPath, "utf8"));
    if (sourceManifest.static != null) fail("source hosting manifest still declares static output");
    if (distManifest.static != null) fail("dist hosting manifest still declares static output");
    if (sourceManifest.project_id !== distManifest.project_id) fail("source/dist project IDs differ");
    const sourceBytes = fs.readFileSync(workerSourcePath);
    const distBytes = fs.readFileSync(workerDistPath);
    if (!sourceBytes.equals(distBytes)) fail("worker/index.js and dist/server/index.js are not byte-identical");
    const dataUrl = "data:text/javascript;base64," + sourceBytes.toString("base64");
    moduleWorker = await import(dataUrl + "#" + encodeURIComponent(workerSourcePath));
    if (typeof moduleWorker.default?.fetch !== "function") fail("Worker must export default.fetch");
  } catch (error) {
    return { errors: ["Worker artifact cannot be loaded: " + error.message], checkedAssets: 0 };
  }

  const headerCheck = (headers, context) => {
    for (const [name, pattern] of Object.entries(requiredHeaders)) {
      const value = headers.get(name);
      if (!value || !pattern.test(value)) fail(context + ": missing or invalid " + name);
    }
  };

  for (const [route, relativePath, contentType] of routes) {
    try {
      const expected = fs.readFileSync(path.join(siteRoot, relativePath));
      const response = await moduleWorker.default.fetch(new Request("https://scc-market.test" + route));
      const actual = Buffer.from(await response.arrayBuffer());
      if (response.status !== 200) fail(route + ": expected GET status 200, got " + response.status);
      if (response.headers.get("content-type") !== contentType) fail(route + ": unexpected Content-Type");
      if (!actual.equals(expected)) fail(route + ": Worker response differs from canonical source");
      if (!/^"sha256-[a-f0-9]{64}"$/.test(response.headers.get("etag") ?? "")) fail(route + ": missing SHA-256 ETag");
      if (response.headers.get("etag") !== '"sha256-' + createHash("sha256").update(expected).digest("hex") + '"') fail(route + ": ETag does not match the canonical bytes");
      if (response.headers.get("cache-control") !== "public, max-age=0, must-revalidate") fail(route + ": unexpected Cache-Control");
      headerCheck(response.headers, route);

      const head = await moduleWorker.default.fetch(new Request("https://scc-market.test" + route, { method: "HEAD" }));
      if (head.status !== 200 || (await head.text()) !== "") fail(route + ": HEAD must return an empty body with status 200");
      if (head.headers.get("etag") !== response.headers.get("etag")) fail(route + ": HEAD ETag differs from GET");
      headerCheck(head.headers, route + " HEAD");

      const notModified = await moduleWorker.default.fetch(new Request("https://scc-market.test" + route, {
        headers: { "If-None-Match": response.headers.get("etag") },
      }));
      if (notModified.status !== 304 || (await notModified.text()) !== "") fail(route + ": matching ETag must return 304");
      headerCheck(notModified.headers, route + " 304");
    } catch (error) {
      fail(route + ": request validation failed: " + error.message);
    }
  }

  try {
    const missing = await moduleWorker.default.fetch(new Request("https://scc-market.test/not-found"));
    if (missing.status !== 404) fail("missing route must return 404");
    headerCheck(missing.headers, "404");

    const rejected = await moduleWorker.default.fetch(new Request("https://scc-market.test/", { method: "POST" }));
    if (rejected.status !== 405 || rejected.headers.get("allow") !== "GET, HEAD") fail("unsupported methods must return 405 with Allow");
    headerCheck(rejected.headers, "405");
  } catch (error) {
    fail("error response validation failed: " + error.message);
  }

  return { errors, checkedAssets: routes.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await validateWorkerArtifact();
  if (result.errors.length) {
    for (const error of result.errors) console.error("FAIL " + error);
    process.exitCode = 1;
  } else {
    console.log("PASS Worker serves " + result.checkedAssets + " canonical assets with security headers, ETags, HEAD, and 304 handling");
  }
}
