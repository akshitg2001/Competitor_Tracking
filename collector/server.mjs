import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getRefreshAllowance, runOnycCollection } from "./onyc-collector.mjs";
import { getStarkidzRefreshAllowance, runStarkidzCollection } from "./starkidz-collector.mjs";
import { getArettoRefreshAllowance, runArettoCollection } from "./aretto-collector.mjs";
import { getKatsRefreshAllowance, runKatsCollection } from "./kats-collector.mjs";

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicDataDir = path.join(projectDir, "public", "data");
const port = Number(process.env.MARKET_PULSE_DATA_PORT || 8787);
const allowedOrigins = new Set(["http://localhost:5173", "http://127.0.0.1:5173"]);
const collectors = {
  onyc: { run: runOnycCollection, allowance: getRefreshAllowance },
  starkidz: { run: runStarkidzCollection, allowance: getStarkidzRefreshAllowance },
  kats: { run: runKatsCollection, allowance: getKatsRefreshAllowance },
  aretto: { run: runArettoCollection, allowance: getArettoRefreshAllowance },
};
const refreshStates = {
  onyc: { running: false, progress: null, lastError: null },
  starkidz: { running: false, progress: null, lastError: null },
  kats: { running: false, progress: null, lastError: null },
  aretto: { running: false, progress: null, lastError: null },
};

function sendJson(response, status, value, origin) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...(allowedOrigins.has(origin) ? { "access-control-allow-origin": origin } : {}) });
  response.end(JSON.stringify(value));
}

async function readSnapshot(brand, kind) {
  try { return JSON.parse(await readFile(path.join(publicDataDir, `${brand}-${kind}.json`), "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

function resolveBrand(url) { const requested = url.searchParams.get("brand") || "onyc"; return Object.hasOwn(collectors, requested) ? requested : null; }

const server = http.createServer(async (request, response) => {
  const origin = request.headers.origin || "";
  if (request.method === "OPTIONS") {
    response.writeHead(204, { ...(allowedOrigins.has(origin) ? { "access-control-allow-origin": origin } : {}), "access-control-allow-methods": "GET,POST,OPTIONS", "access-control-allow-headers": "content-type" }); response.end(); return;
  }
  const url = new URL(request.url || "/", `http://${request.headers.host || "127.0.0.1"}`);
  const brand = resolveBrand(url);
  try {
    if (request.method === "GET" && url.pathname === "/api/brands") {
      const entries = await Promise.all(Object.keys(collectors).map(async (id) => [id, { summary: await readSnapshot(id, "summary"), allowance: collectors[id].allowance(), state: refreshStates[id] }]));
      sendJson(response, 200, Object.fromEntries(entries), origin); return;
    }
    if (!brand) { sendJson(response, 400, { error: "Unsupported brand." }, origin); return; }
    if (request.method === "GET" && url.pathname === "/api/status") {
      const summary = await readSnapshot(brand, "summary"); sendJson(response, 200, { ...refreshStates[brand], allowance: collectors[brand].allowance(), hasSnapshot: Boolean(summary), summary }, origin); return;
    }
    if (request.method === "GET" && url.pathname === "/api/summary") {
      const summary = await readSnapshot(brand, "summary"); sendJson(response, summary ? 200 : 404, summary || { error: `No ${brand} snapshot exists yet.` }, origin); return;
    }
    if (request.method === "GET" && url.pathname === "/api/products") {
      const products = await readSnapshot(brand, "products"); sendJson(response, products ? 200 : 404, products || { error: `No ${brand} product snapshot exists yet.` }, origin); return;
    }
    if (request.method === "POST" && url.pathname === "/api/refresh") {
      if (refreshStates[brand].running) { sendJson(response, 409, { error: "A refresh is already running.", state: refreshStates[brand] }, origin); return; }
      const allowance = collectors[brand].allowance();
      if (!allowance.allowed) { sendJson(response, 429, { error: "The one-full-refresh-per-day limit has already been used for this brand.", allowance }, origin); return; }
      refreshStates[brand] = { running: true, progress: { phase: "starting", current: 0, total: 0, message: `Starting ${brand} refresh` }, lastError: null };
      collectors[brand].run({ onProgress: (progress) => { refreshStates[brand] = { ...refreshStates[brand], progress }; } })
        .then(() => { refreshStates[brand] = { running: false, progress: { phase: "complete", message: `${brand} refresh completed` }, lastError: null }; })
        .catch((error) => { refreshStates[brand] = { running: false, progress: null, lastError: String(error.message || error) }; });
      sendJson(response, 202, { message: `${brand} refresh started.`, state: refreshStates[brand] }, origin); return;
    }
    sendJson(response, 404, { error: "Not found" }, origin);
  } catch (error) { sendJson(response, 500, { error: String(error.message || error) }, origin); }
});

server.listen(port, "127.0.0.1", () => console.log(`Market Pulse data service listening at http://127.0.0.1:${port}`));
