import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

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

const hostingPath = path.join(root, ".openai", "hosting.json");
const hosting = JSON.parse(fs.readFileSync(hostingPath, "utf8"));
if (hosting.static != null) throw new Error("Worker build requires static configuration to be removed from .openai/hosting.json");

const distRoot = path.join(root, "dist");
const mirroredFiles = [...new Set(routes.map(([, relativePath]) => relativePath))];
for (const relativePath of mirroredFiles) {
  const sourcePath = path.join(root, relativePath);
  const distPath = path.join(distRoot, relativePath);
  fs.mkdirSync(path.dirname(distPath), { recursive: true });
  fs.copyFileSync(sourcePath, distPath);
}

const records = routes.map(([route, relativePath, contentType]) => {
  const bytes = fs.readFileSync(path.join(root, relativePath));
  const encoding = contentType === "image/png" ? "base64" : "utf8";
  const body = bytes.toString(encoding);
  const digest = createHash("sha256").update(bytes).digest("hex");
  return { route, body, encoding, contentType, etag: '"sha256-' + digest + '"' };
});

const lines = [
  "const ASSETS = new Map([",
  ...records.map((asset) =>
    "  [" + JSON.stringify(asset.route) + ", { body: " + JSON.stringify(asset.body) +
    ", encoding: " + JSON.stringify(asset.encoding) +
    ", contentType: " + JSON.stringify(asset.contentType) +
    ", etag: " + JSON.stringify(asset.etag) + " }],"
  ),
  "]);",
  "const SECURITY_HEADERS = Object.freeze({",
  '  "Content-Security-Policy": "default-src \'self\'; base-uri \'self\'; object-src \'none\'; script-src \'self\'; style-src \'self\'; img-src \'self\'; font-src \'self\'; connect-src \'self\'; form-action \'self\'; frame-ancestors \'none\'",',
  '  "Referrer-Policy": "strict-origin-when-cross-origin",',
  '  "X-Content-Type-Options": "nosniff",',
  '  "X-Frame-Options": "DENY",',
  '  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",',
  '  "Strict-Transport-Security": "max-age=31536000"',
  "});",
  "function headersFor(status, contentType, etag) {",
  "  const headers = new Headers(SECURITY_HEADERS);",
  '  headers.set("Cache-Control", status === 200 || status === 304 ? "public, max-age=0, must-revalidate" : "no-store");',
  "  if (contentType) headers.set('Content-Type', contentType);",
  "  if (etag) headers.set('ETag', etag);",
  "  return headers;",
  "}",
  "function matchesEtag(value, etag) {",
  "  if (!value) return false;",
  "  return value.split(',').map((item) => item.trim()).some((item) => item === '*' || item === etag || item === 'W/' + etag);",
  "}",
  "export default {",
  "  async fetch(request) {",
  "    const method = request.method.toUpperCase();",
  "    if (method !== 'GET' && method !== 'HEAD') {",
  "      const headers = headersFor(405, 'text/plain; charset=utf-8');",
  "      headers.set('Allow', 'GET, HEAD');",
  "      return new Response('Method not allowed', { status: 405, headers });",
  "    }",
  "    const asset = ASSETS.get(new URL(request.url).pathname);",
  "    if (!asset) return new Response('Not found', { status: 404, headers: headersFor(404, 'text/plain; charset=utf-8') });",
  "    const headers = headersFor(200, asset.contentType, asset.etag);",
  "    if (matchesEtag(request.headers.get('If-None-Match'), asset.etag)) return new Response(null, { status: 304, headers });",
  "    const body = method === 'HEAD' ? null : asset.encoding === 'base64' ? Uint8Array.from(atob(asset.body), (char) => char.charCodeAt(0)) : asset.body;",
  "    return new Response(body, { status: 200, headers });",
  "  }",
  "};",
].join('\n') + '\n';

const workerPath = path.join(root, "worker", "index.js");

const distWorkerPath = path.join(distRoot, "server", "index.js");
const distHostingPath = path.join(distRoot, ".openai", "hosting.json");
fs.mkdirSync(path.dirname(workerPath), { recursive: true });
fs.mkdirSync(path.dirname(distWorkerPath), { recursive: true });
fs.mkdirSync(path.dirname(distHostingPath), { recursive: true });
fs.writeFileSync(workerPath, lines, "utf8");
fs.writeFileSync(distWorkerPath, lines, "utf8");
fs.writeFileSync(distHostingPath, JSON.stringify(hosting, null, 2) + "\n", "utf8");
console.log("PASS built Worker entry with " + records.length + " routes and security headers");
