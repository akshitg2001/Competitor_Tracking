import { createReadStream } from "node:fs";
import { access, stat } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const buildRoot = path.join(projectRoot, "local-dist");
const dataRoot = path.join(projectRoot, "public", "data");
const port = Number(process.env.MARKET_PULSE_WEB_PORT || 5173);
const contentTypes = new Map([
  [".html", "text/html; charset=utf-8"], [".js", "text/javascript; charset=utf-8"], [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"], [".svg", "image/svg+xml"], [".png", "image/png"], [".ico", "image/x-icon"],
]);

function safePath(root, pathname) {
  const resolved = path.resolve(root, `.${pathname}`);
  return resolved === root || resolved.startsWith(`${root}${path.sep}`) ? resolved : null;
}

async function sendFile(response, filePath, cacheControl) {
  try {
    await access(filePath);
    const details = await stat(filePath);
    if (!details.isFile()) throw new Error("Not a file");
    response.writeHead(200, {
      "content-type": contentTypes.get(path.extname(filePath).toLowerCase()) || "application/octet-stream",
      "content-length": details.size,
      "cache-control": cacheControl,
      "x-content-type-options": "nosniff",
    });
    createReadStream(filePath).pipe(response);
  } catch {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
  }
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url || "/", `http://${request.headers.host || "127.0.0.1"}`);
  if (url.pathname === "/health") {
    response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    response.end(JSON.stringify({ status: "ok", service: "dashboard", uptimeSeconds: Math.round(process.uptime()) }));
    return;
  }
  if (url.pathname.startsWith("/data/")) {
    const filePath = safePath(dataRoot, url.pathname.slice("/data".length));
    if (!filePath) { response.writeHead(400); response.end("Invalid path"); return; }
    await sendFile(response, filePath, "no-store");
    return;
  }
  const requested = url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = safePath(buildRoot, requested);
  if (filePath) {
    try {
      if ((await stat(filePath)).isFile()) { await sendFile(response, filePath, requested === "/index.html" ? "no-store" : "public, max-age=31536000, immutable"); return; }
    } catch { /* SPA fallback below */ }
  }
  await sendFile(response, path.join(buildRoot, "index.html"), "no-store");
});

server.listen(port, "127.0.0.1", () => console.log(`Market Pulse dashboard listening at http://localhost:${port}`));
server.on("error", (error) => { console.error(error); process.exitCode = 1; });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.close(() => process.exit(0)));
