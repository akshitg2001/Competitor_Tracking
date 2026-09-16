import path from "node:path";
import { fileURLToPath } from "node:url";
import { createShopifyBrandCollector } from "./shopify-brand-collector.mjs";

const config = {
  id: "aretto", brandName: "Aretto", baseUrl: "https://wearetto.com", defaultGender: "Unisex",
  boysCollections: ["boys-shoes", "boys-casual-shoes", "boys-running-shoes", "boys-sneakers"],
  girlsCollections: ["girls-shoes", "girls-casual-shoes", "girls-running-shoes", "girls-sneakers"],
  typeDefinitions: [
    { key: "school-shoes", label: "School Shoes", handles: ["kids-school-shoes"], pattern: /school/i },
    { key: "sneakers", label: "Sneakers", handles: ["boys-sneakers", "girls-sneakers"], pattern: /sneaker/i },
    { key: "sports-shoes", label: "Sports Shoes", handles: ["kids-sports-shoes", "boys-running-shoes", "girls-running-shoes"], pattern: /sport|running/i },
    { key: "casual-shoes", label: "Casual Shoes", handles: ["boys-casual-shoes", "girls-casual-shoes"], pattern: /casual/i },
    { key: "barefoot-shoes", label: "Barefoot Shoes", handles: ["kids-barefoot-shoes"], pattern: /barefoot/i },
    { key: "baby-toddler-shoes", label: "Baby & Toddler Shoes", handles: ["newborn-baby-shoes", "infant-shoes", "baby-shoes", "toddler-shoes"], pattern: /baby|newborn|infant|toddler|tyny/i },
  ],
  fallbackType: { key: "shoes", label: "Shoes" },
  sizeCodeAges: { S0: [0, 12], S1: [12, 24], S2: [24, 36], S3: [36, 48], S4: [48, 72], S5: [72, 96], S6: [96, 192] },
  excludeProduct: (product) => /\bgift\s*card\b/i.test(product.title),
};

const collector = createShopifyBrandCollector(config);
export const runArettoCollection = collector.run;
export const getArettoRefreshAllowance = collector.getAllowance;

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runArettoCollection({ force: process.argv.includes("--force"), onProgress: ({ phase, current, total, message }) => { if (phase !== "reviews" || current === 1 || current % 15 === 0 || current === total) console.log(message); } })
    .then((summary) => console.log(`Saved ${summary.metrics.activeListings} Aretto products and ${summary.metrics.variantCount} variants.`))
    .catch((error) => { console.error(error.message); process.exitCode = 1; });
}
