import http from "node:http";
import { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getRefreshAllowance, runOnycCollection } from "./onyc-collector.mjs";
import { getStarkidzRefreshAllowance, runStarkidzCollection } from "./starkidz-collector.mjs";
import { getArettoRefreshAllowance, runArettoCollection } from "./aretto-collector.mjs";
import { getKatsRefreshAllowance, runKatsCollection } from "./kats-collector.mjs";

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicDataDir = path.join(projectDir, "public", "data");
const databasePath = path.join(projectDir, "data", "market-pulse.sqlite");
const port = Number(process.env.MARKET_PULSE_DATA_PORT || 8787);
const allowedOrigins = new Set(["http://localhost:5173", "http://127.0.0.1:5173"]);
const collectors = {
  onyc: { run: runOnycCollection, allowance: getRefreshAllowance },
  starkidz: { run: runStarkidzCollection, allowance: getStarkidzRefreshAllowance },
  kats: { run: runKatsCollection, allowance: getKatsRefreshAllowance },
  aretto: { run: runArettoCollection, allowance: getArettoRefreshAllowance },
};
const productSourceRules = {
  onyc: { databaseBrand: "ONYC", hosts: new Set(["onyc.in", "www.onyc.in"]) },
  starkidz: { databaseBrand: "Starkidz", hosts: new Set(["starkidz.co.in", "www.starkidz.co.in"]) },
  kats: { databaseBrand: "KATS", hosts: new Set(["katsstore.com", "www.katsstore.com"]) },
  aretto: { databaseBrand: "Aretto", hosts: new Set(["wearetto.com", "www.wearetto.com"]) },
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

async function readSchedulerStatus() {
  try {
    const status = JSON.parse(await readFile(path.join(projectDir, "data", "scheduler-status.json"), "utf8"));
    if (status?.backupPath) status.backupPath = path.basename(status.backupPath);
    return status;
  }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

function readProductChanges() {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const baselineRuns = new Map(db.prepare("SELECT source, MIN(id) AS run_id FROM scan_runs WHERE status='completed' GROUP BY source").all().map((row) => [row.source, row.run_id]));
    const latestRuns = new Map(db.prepare("SELECT r.source, r.id, r.completed_at FROM scan_runs r JOIN (SELECT source, MAX(id) AS id FROM scan_runs WHERE status='completed' GROUP BY source) latest ON latest.id=r.id").all().map((row) => [row.source, row]));
    const rows = db.prepare(`
      SELECT e.id, e.run_id, e.occurred_at, e.event_type, e.severity, e.product_id,
             e.title AS event_title, e.detail, r.source,
             p.brand AS product_brand, p.title AS product_title, p.canonical_url, p.product_type, p.gender,
             p.active, p.first_seen_at, p.last_seen_at
      FROM events e
      JOIN scan_runs r ON r.id = e.run_id
      LEFT JOIN products p ON p.product_id = e.product_id
      WHERE r.status = 'completed'
        AND e.event_type IN ('product_added', 'possibly_removed', 'confirmed_removed', 'product_restored')
      ORDER BY e.occurred_at DESC, e.id DESC
      LIMIT 2000
    `).all();
    let excludedInvalidMappings = 0;
    const changes = rows.filter((row) => baselineRuns.get(row.source) !== row.run_id).filter((row) => {
      const rule = productSourceRules[row.source];
      let validHost = false;
      try { validHost = Boolean(row.canonical_url && rule?.hosts.has(new URL(row.canonical_url).hostname.toLowerCase())); } catch { validHost = false; }
      const valid = Boolean(rule && row.product_brand === rule.databaseBrand && validHost);
      if (!valid) excludedInvalidMappings += 1;
      return valid;
    }).map((row) => {
      let changeType = row.event_type;
      let verification = "Detected";
      if (row.event_type === "possibly_removed") {
        const returnedLater = Boolean(row.active) && row.last_seen_at && row.last_seen_at > row.occurred_at;
        const laterSuccessfulScan = latestRuns.get(row.source)?.completed_at > row.occurred_at;
        if (returnedLater) { changeType = "restored"; verification = "Returned in a later scan"; }
        else if (!row.active && laterSuccessfulScan) { changeType = "confirmed_removed"; verification = "Confirmed by a subsequent scan"; }
        else verification = "Awaiting confirmation";
      } else if (row.event_type === "product_added") {
        verification = row.active ? "Active in the latest scan" : "No longer active";
      } else if (row.event_type === "product_restored") verification = "Active again";
      return {
        id: row.id,
        brandId: row.source,
        occurredAt: row.occurred_at,
        changeType,
        originalEventType: row.event_type,
        severity: row.severity,
        productId: row.product_id,
        productTitle: row.product_title || row.event_title.replace(/^New product:\s*/i, ""),
        productUrl: row.canonical_url || null,
        category: row.product_type || row.detail || "Unclassified",
        gender: row.gender || "Unspecified",
        verification,
        latestScan: latestRuns.get(row.source)?.id === row.run_id,
      };
    });
    return { changes, excludedInvalidMappings };
  } finally { db.close(); }
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
    if (request.method === "GET" && url.pathname === "/api/health") {
      const snapshots = Object.fromEntries(await Promise.all(Object.keys(collectors).map(async (id) => [id, await readSnapshot(id, "summary")])));
      const staleBefore = Date.now() - 4 * 24 * 60 * 60 * 1_000;
      const staleBrands = Object.entries(snapshots).filter(([, summary]) => !summary?.generatedAt || new Date(summary.generatedAt).getTime() < staleBefore).map(([id]) => id);
      sendJson(response, 200, { status: "ok", service: "data", uptimeSeconds: Math.round(process.uptime()), checkedAt: new Date().toISOString(), staleBrands, scheduler: await readSchedulerStatus() }, origin); return;
    }
    if (request.method === "GET" && url.pathname === "/api/brands") {
      const entries = await Promise.all(Object.keys(collectors).map(async (id) => [id, { summary: await readSnapshot(id, "summary"), allowance: collectors[id].allowance(), state: refreshStates[id] }]));
      sendJson(response, 200, Object.fromEntries(entries), origin); return;
    }
    if (request.method === "GET" && url.pathname === "/api/product-changes") {
      sendJson(response, 200, readProductChanges(), origin); return;
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
