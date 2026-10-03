import path from "node:path"
import { fileURLToPath } from "node:url"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

const projectRoot = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  root: path.join(projectRoot, "live"),
  base: "/",
  plugins: [react()],
  resolve: { alias: { "@": projectRoot } },
  build: {
    outDir: path.join(projectRoot, "local-dist"),
    emptyOutDir: true,
    sourcemap: false,
  },
})
