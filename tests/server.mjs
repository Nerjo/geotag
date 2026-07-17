import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname.replace(/^\/(.:)/, "$1"));
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml", ".woff2": "font/woff2" };

// Serve tests under the deployed Content-Security-Policy so the suite catches
// anything the production headers would block (workers, tiles, eval, …).
async function productionCsp() {
  const headers = await readFile(resolve(root, "_headers"), "utf8");
  const line = headers.split("\n").find(entry => entry.includes("Content-Security-Policy:"));
  return line ? line.replace(/^\s*Content-Security-Policy:\s*/, "").trim() : "";
}

export async function startServer(port = 4173) {
  const csp = await productionCsp();
  const server = createServer(async (request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
    let file = resolve(root, pathname === "/" ? "index.html" : "." + pathname);
    if (!file.startsWith(root + sep) && file !== resolve(root, "index.html")) { response.writeHead(403).end(); return; }
    try {
      if ((await stat(file)).isDirectory()) file = resolve(file, "index.html");
      response.setHeader("Content-Type", types[extname(file)] || "application/octet-stream");
      response.setHeader("Cache-Control", "no-store");
      if (csp) response.setHeader("Content-Security-Policy", csp);
      createReadStream(file).pipe(response);
    } catch (_) { response.writeHead(404).end(); }
  });
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolveListen);
  });
  return server;
}
