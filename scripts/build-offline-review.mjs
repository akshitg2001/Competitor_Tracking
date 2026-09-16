import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { build } from "vite"

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const buildDir = path.join(projectRoot, "review-dist")
const builtHtmlDir = path.join(buildDir, "offline")
const deliverableDir = path.join(projectRoot, "deliverables")
const deliverable = path.join(deliverableDir, "Market-Pulse-Review.html")
const packageDir = path.join(deliverableDir, "Market-Pulse-Review")

await build({ configFile: path.join(projectRoot, "vite.offline.config.ts") })

let html = await readFile(path.join(builtHtmlDir, "index.html"), "utf8")

for (const match of [...html.matchAll(/<link\b[^>]*rel=["']stylesheet["'][^>]*href=["']([^"']+)["'][^>]*>/gi)]) {
  const assetPath = path.resolve(builtHtmlDir, match[1])
  const css = await readFile(assetPath, "utf8")
  html = html.replace(match[0], () => `<style>${css}</style>`)
}

for (const match of [...html.matchAll(/<script\b([^>]*)src=["']([^"']+)["']([^>]*)><\/script>/gi)]) {
  const assetPath = path.resolve(builtHtmlDir, match[2])
  const javascript = (await readFile(assetPath, "utf8")).replaceAll("</script>", "<\\/script>")
  html = html.replace(match[0], () => `<script type="module">${javascript}</script>`)
}

if (!html.includes("<style>") || !html.includes('<script type="module">')) {
  throw new Error("The offline review did not inline its required script and stylesheet.")
}

await mkdir(deliverableDir, { recursive: true })
await writeFile(deliverable, html, "utf8")
await mkdir(packageDir, { recursive: true })
await writeFile(path.join(packageDir, "dashboard.html"), html, "utf8")
await copyFile(process.execPath, path.join(packageDir, "node.exe"))
console.log(deliverable)
