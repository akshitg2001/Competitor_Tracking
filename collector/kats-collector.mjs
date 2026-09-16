import path from "node:path";
import { fileURLToPath } from "node:url";
import { createShopifyBrandCollector } from "./shopify-brand-collector.mjs";

const config = {
  id: "kats", brandName: "KATS", baseUrl: "https://katsstore.com", defaultGender: "Unspecified",
  typeDefinitions: [
    { key: "light-shoes", label: "Light Shoes", handles: ["light-shoes"], pattern: /\bled\b|light\s+shoe/i },
    { key: "sandals", label: "Sandals", handles: ["sandals"], pattern: /sandal/i },
    { key: "flip-flops", label: "Flip-Flops", handles: ["flip-flops"], pattern: /flip\s*-?\s*flop/i },
    { key: "clogs", label: "Clogs & Slip-ons", handles: ["kroks"], pattern: /kroks?|crocs?|clog|slip[ -]?on/i },
    { key: "shoes", label: "Shoes", handles: ["shoes"], pattern: /shoe|sneaker|boot/i },
  ],
  fallbackType: { key: "other", label: "Other" },
  excludeProduct: (product) => /socks?|insole|shoe\s*care/i.test(`${product.title} ${(product.tags || []).join(" ")}`),
};

const collector = createShopifyBrandCollector(config);
export const runKatsCollection = collector.run;
export const getKatsRefreshAllowance = collector.getAllowance;

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runKatsCollection({ force: process.argv.includes("--force"), onProgress: ({ phase, current, total, message }) => { if (phase !== "reviews" || current === 1 || current % 20 === 0 || current === total) console.log(message); } })
    .then((summary) => console.log(`Saved ${summary.metrics.activeListings} KATS products and ${summary.metrics.variantCount} variants.`))
    .catch((error) => { console.error(error.message); process.exitCode = 1; });
}
