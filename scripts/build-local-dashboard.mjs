import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
await build({ configFile: path.join(projectRoot, "vite.local.config.ts") });
console.log(`Local production dashboard built at ${path.join(projectRoot, "local-dist")}`);
