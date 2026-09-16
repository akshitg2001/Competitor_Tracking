import path from "node:path"
import { fileURLToPath } from "node:url"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

const projectRoot = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  root: projectRoot,
  base: "./",
  plugins: [react()],
  resolve: { alias: { "@": projectRoot } },
  build: {
    outDir: path.join(projectRoot, "review-dist"),
    emptyOutDir: true,
    cssCodeSplit: false,
    assetsInlineLimit: 100_000_000,
    rollupOptions: {
      input: path.join(projectRoot, "offline", "index.html"),
      output: {
        inlineDynamicImports: true,
        entryFileNames: "assets/dashboard.js",
        assetFileNames: "assets/dashboard.[ext]",
      },
    },
  },
})
