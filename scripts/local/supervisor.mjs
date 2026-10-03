import { appendFileSync, closeSync, existsSync, openSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const dataDir = path.join(projectRoot, "data");
const runtimeDir = path.join(dataDir, "runtime");
const logDir = path.join(dataDir, "logs");
const statePath = path.join(runtimeDir, "supervisor.json");
const lockPath = path.join(runtimeDir, "supervisor.lock");
const heartbeatPath = path.join(runtimeDir, "supervisor-heartbeat.json");
const services = [
  { id: "dashboard", script: path.join(projectRoot, "scripts", "local", "serve-dashboard.mjs") },
  { id: "data", script: path.join(projectRoot, "collector", "server.mjs") },
];

await Promise.all([mkdir(runtimeDir, { recursive: true }), mkdir(logDir, { recursive: true })]);

function pidIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

if (existsSync(lockPath)) {
  try {
    const existing = JSON.parse(readFileSync(lockPath, "utf8"));
    if (pidIsAlive(existing.pid)) {
      console.log(`Market Pulse supervisor is already running as PID ${existing.pid}.`);
      process.exit(0);
    }
  } catch { /* stale or malformed lock */ }
  await rm(lockPath, { force: true });
}

const lockHandle = openSync(lockPath, "wx");
writeFileSync(lockHandle, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
closeSync(lockHandle);

const children = new Map();
let stopping = false;

function log(message) {
  const line = `${new Date().toISOString()} ${message}`;
  console.log(line);
  appendFileSync(path.join(logDir, `supervisor-${new Date().toISOString().slice(0, 7)}.log`), `${line}\n`);
}

function rotateLog(filePath, maximumBytes = 5 * 1024 * 1024) {
  try {
    if (statSync(filePath).size < maximumBytes) return;
    const archive = `${filePath}.${new Date().toISOString().replace(/[:.]/g, "-")}.old`;
    renameSync(filePath, archive);
  } catch { /* missing log needs no rotation */ }
}

async function writeState() {
  const payload = {
    pid: process.pid,
    startedAt: supervisorStartedAt,
    updatedAt: new Date().toISOString(),
    services: Object.fromEntries([...children].map(([id, value]) => [id, { pid: value.child.pid, startedAt: value.startedAt, restartCount: value.restartCount }])),
  };
  await writeFile(statePath, JSON.stringify(payload, null, 2));
}

function startService(service, restartCount = 0) {
  if (stopping) return;
  const stdoutPath = path.join(logDir, `${service.id}.log`);
  const stderrPath = path.join(logDir, `${service.id}-error.log`);
  rotateLog(stdoutPath); rotateLog(stderrPath);
  const stdout = openSync(stdoutPath, "a"); const stderr = openSync(stderrPath, "a");
  const child = spawn(process.execPath, [service.script], { cwd: projectRoot, windowsHide: true, stdio: ["ignore", stdout, stderr] });
  closeSync(stdout); closeSync(stderr);
  children.set(service.id, { child, startedAt: new Date().toISOString(), restartCount });
  log(`Started ${service.id} service as PID ${child.pid}.`);
  void writeState();
  child.on("exit", (code, signal) => {
    children.delete(service.id);
    if (stopping) return;
    log(`${service.id} service exited (code=${code ?? "none"}, signal=${signal || "none"}); restarting in 5 seconds.`);
    setTimeout(() => startService(service, restartCount + 1), 5_000);
  });
}

async function stop() {
  if (stopping) return;
  stopping = true;
  log("Stopping Market Pulse services.");
  for (const { child } of children.values()) {
    try { child.kill("SIGTERM"); } catch { /* child already ended */ }
  }
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  for (const { child } of children.values()) if (pidIsAlive(child.pid)) try { child.kill("SIGKILL"); } catch { /* child already ended */ }
  await Promise.all([rm(lockPath, { force: true }), rm(statePath, { force: true }), rm(heartbeatPath, { force: true })]);
  process.exit(0);
}

const supervisorStartedAt = new Date().toISOString();
for (const service of services) startService(service);
setInterval(async () => {
  await writeFile(heartbeatPath, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
  await writeState();
}, 30_000).unref();

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => { void stop(); });
process.on("uncaughtException", (error) => { log(`Supervisor failure: ${error.stack || error.message}`); void stop(); });
process.on("unhandledRejection", (error) => { log(`Supervisor rejection: ${error instanceof Error ? error.stack : String(error)}`); void stop(); });
log(`Market Pulse supervisor started as PID ${process.pid}.`);
