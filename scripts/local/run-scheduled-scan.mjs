import { DatabaseSync } from "node:sqlite";
import { copyFile, mkdir, open, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runOnycCollection } from "../../collector/onyc-collector.mjs";
import { runStarkidzCollection } from "../../collector/starkidz-collector.mjs";
import { runKatsCollection } from "../../collector/kats-collector.mjs";
import { runArettoCollection } from "../../collector/aretto-collector.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const dataDir = path.join(projectRoot, "data");
const backupRoot = path.join(dataDir, "backups");
const logDir = path.join(dataDir, "logs");
const lockPath = path.join(dataDir, "scheduled-scan.lock");
const statusPath = path.join(dataDir, "scheduler-status.json");
const databasePath = path.join(dataDir, "market-pulse.sqlite");
const collectors = [
  ["onyc", runOnycCollection], ["starkidz", runStarkidzCollection], ["kats", runKatsCollection], ["aretto", runArettoCollection],
];

await Promise.all([mkdir(dataDir, { recursive: true }), mkdir(backupRoot, { recursive: true }), mkdir(logDir, { recursive: true })]);

function timestamp() { return new Date().toISOString().replace(/[:.]/g, "-"); }
async function log(message) {
  const line = `${new Date().toISOString()} ${message}`;
  console.log(line);
  const logPath = path.join(logDir, `scheduled-scans-${new Date().toISOString().slice(0, 7)}.log`);
  const handle = await open(logPath, "a"); try { await handle.write(`${line}\n`); } finally { await handle.close(); }
}
async function writeStatus(value) {
  const temporary = `${statusPath}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2));
  await rename(temporary, statusPath);
}
async function acquireLock() {
  try {
    const handle = await open(lockPath, "wx"); await handle.write(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })); await handle.close(); return;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const age = Date.now() - (await stat(lockPath)).mtimeMs;
    if (age < 6 * 60 * 60 * 1_000) throw new Error("Another Market Pulse scan is already running.");
    await rm(lockPath, { force: true });
    return acquireLock();
  }
}
async function createBackup() {
  const folder = path.join(backupRoot, timestamp());
  await mkdir(folder, { recursive: true });
  try {
    const db = new DatabaseSync(databasePath); db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); db.close();
    await copyFile(databasePath, path.join(folder, "market-pulse.sqlite"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const publicData = path.join(projectRoot, "public", "data");
  for (const name of await readdir(publicData)) if (name.endsWith(".json")) await copyFile(path.join(publicData, name), path.join(folder, name));
  const backups = (await readdir(backupRoot, { withFileTypes: true })).filter((item) => item.isDirectory()).map((item) => item.name).sort().reverse();
  for (const old of backups.slice(30)) await rm(path.join(backupRoot, old), { recursive: true, force: true });
  return path.basename(folder);
}

await acquireLock();
const startedAt = new Date().toISOString();
const status = { status: "running", startedAt, completedAt: null, backupPath: null, brands: {} };
let failures = 0;
try {
  await log("Scheduled Market Pulse scan started.");
  status.backupPath = await createBackup();
  await writeStatus(status);
  for (const [id, run] of collectors) {
    const brandStartedAt = new Date().toISOString();
    try {
      await log(`Starting ${id} scan.`);
      const summary = await run({
        onProgress: ({ phase, current = 0, total = 0, message }) => {
          const isMilestone = !total || current <= 1 || current === total || current % 20 === 0;
          if (message && (phase !== "reviews" || isMilestone)) void log(`[${id}] ${message}`);
        },
      });
      status.brands[id] = { status: "completed", startedAt: brandStartedAt, completedAt: new Date().toISOString(), products: summary.metrics.activeListings };
      await log(`Completed ${id}: ${summary.metrics.activeListings} products.`);
    } catch (error) {
      if (error.code === "DAILY_LIMIT") {
        status.brands[id] = { status: "skipped", reason: "Already refreshed today", startedAt: brandStartedAt, completedAt: new Date().toISOString() };
        await log(`Skipped ${id}: already refreshed today.`);
      } else {
        failures += 1;
        status.brands[id] = { status: "failed", error: String(error.message || error), startedAt: brandStartedAt, completedAt: new Date().toISOString() };
        await log(`Failed ${id}: ${error.message || error}`);
      }
    }
    await writeStatus(status);
  }
  status.status = failures ? "partial" : "completed";
  status.completedAt = new Date().toISOString();
  await writeStatus(status);
  await log(`Scheduled scan finished with status ${status.status}.`);
  if (failures) process.exitCode = 1;
} catch (error) {
  status.status = "failed"; status.completedAt = new Date().toISOString(); status.error = String(error.message || error);
  await writeStatus(status); await log(`Scheduled scan failed: ${error.message || error}`); process.exitCode = 1;
} finally {
  await rm(lockPath, { force: true });
}
