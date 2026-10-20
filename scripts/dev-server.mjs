import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../site-source");
const port = Number(process.env.PORT ?? 4173);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("PORT must be an integer from 1024 to 65535");
const routes = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/assets/market.js", ["assets/market.js", "text/javascript; charset=utf-8"]],
  ["/assets/site.css", ["assets/site.css", "text/css; charset=utf-8"]],
  ["/assets/favicon.svg", ["assets/favicon.svg", "image/svg+xml"]],
  ["/assets/record-flow.svg", ["assets/record-flow.svg", "image/svg+xml"]],
  ["/assets/og-preview.png", ["assets/og-preview.png", "image/png"]],
  ["/data/market.json", ["data/market.json", "application/json; charset=utf-8"]],
  ["/robots.txt", ["robots.txt", "text/plain; charset=utf-8"]],
  ["/sitemap.xml", ["sitemap.xml", "application/xml; charset=utf-8"]],
]);
const server = http.createServer(async (request, response) => {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Cache-Control", "no-store");
  if (!["GET", "HEAD"].includes(request.method)) {
    response.writeHead(405, { Allow: "GET, HEAD" }).end();
    return;
  }
  const entry = routes.get(new URL(request.url, "http://localhost").pathname);
  if (!entry) { response.writeHead(404).end(); return; }
  try {
    const bytes = await readFile(path.join(root, entry[0]));
    response.writeHead(200, { "Content-Type": entry[1], "Content-Length": bytes.length });
    response.end(request.method === "HEAD" ? undefined : bytes);
  } catch { response.writeHead(500).end("Local development asset unavailable"); }
});
server.listen(port, "127.0.0.1", () => console.log(`Local development: http://127.0.0.1:${port}`));
server.on("error", (error) => { console.error(error.message); process.exitCode = 1; });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.close());
