import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = path.join(projectDir, "data");
const publicDataDir = path.join(projectDir, "public", "data");
const databasePath = path.join(dataDir, "market-pulse.sqlite");
const USER_AGENT = "Starkidz Competitor Intelligence/1.0 (internal catalogue monitor; low-frequency)";
const AGE_BANDS = [
  { key: "0-3-years", label: "0–3 years", min: 0, max: 36 },
  { key: "3-6-years", label: "3–6 years", min: 36, max: 72 },
  { key: "6-9-years", label: "6–9 years", min: 72, max: 108 },
  { key: "9-16-years", label: "9–16 years", min: 108, max: 192 },
];

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const round = (value, digits = 1) => Number(Number(value || 0).toFixed(digits));
const average = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
const decodeEntities = (value = "") => value.replace(/&nbsp;|&#160;/gi, " ").replace(/&amp;/gi, "&").replace(/&quot;/gi, "\"").replace(/&#39;/gi, "'");
const stripHtml = (value = "") => decodeEntities(value.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
const visibleText = (html = "") => stripHtml(html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<svg[\s\S]*?<\/svg>/gi, " "));

async function fetchText(url, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { "user-agent": USER_AGENT, accept: "text/html,application/json" }, signal: AbortSignal.timeout(35_000) });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      return await response.text();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await wait(attempt * 1_000);
    }
  }
  throw lastError;
}

function initialiseDatabase() {
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(databasePath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS scan_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, started_at TEXT NOT NULL, completed_at TEXT, status TEXT NOT NULL, product_count INTEGER DEFAULT 0, page_success_count INTEGER DEFAULT 0, page_failure_count INTEGER DEFAULT 0, error_message TEXT);
    CREATE TABLE IF NOT EXISTS products (product_id TEXT PRIMARY KEY, brand TEXT NOT NULL, title TEXT NOT NULL, handle TEXT NOT NULL, canonical_url TEXT NOT NULL, product_type TEXT, gender TEXT, age_band_keys TEXT, tags TEXT, image_url TEXT, published_at TEXT, first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE IF NOT EXISTS variants (variant_id TEXT PRIMARY KEY, product_id TEXT NOT NULL, sku TEXT, title TEXT, size TEXT, selling_price REAL, mrp REAL, available INTEGER NOT NULL, last_seen_at TEXT NOT NULL, FOREIGN KEY(product_id) REFERENCES products(product_id));
    CREATE TABLE IF NOT EXISTS product_observations (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER NOT NULL, product_id TEXT NOT NULL, observed_at TEXT NOT NULL, selling_price REAL, mrp REAL, discount_percent REAL, available_variants INTEGER, total_variants INTEGER, rating REAL, review_count INTEGER, FOREIGN KEY(run_id) REFERENCES scan_runs(id), FOREIGN KEY(product_id) REFERENCES products(product_id));
    CREATE TABLE IF NOT EXISTS variant_observations (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER NOT NULL, variant_id TEXT NOT NULL, product_id TEXT NOT NULL, observed_at TEXT NOT NULL, selling_price REAL, mrp REAL, available INTEGER NOT NULL, FOREIGN KEY(run_id) REFERENCES scan_runs(id));
    CREATE TABLE IF NOT EXISTS campaigns (campaign_key TEXT PRIMARY KEY, title TEXT NOT NULL, detail TEXT, discount_text TEXT, first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER NOT NULL, occurred_at TEXT NOT NULL, event_type TEXT NOT NULL, severity TEXT NOT NULL, product_id TEXT, variant_id TEXT, title TEXT NOT NULL, detail TEXT, previous_value REAL, current_value REAL, FOREIGN KEY(run_id) REFERENCES scan_runs(id));
    CREATE INDEX IF NOT EXISTS idx_product_observations_product ON product_observations(product_id, observed_at);
    CREATE INDEX IF NOT EXISTS idx_variant_observations_variant ON variant_observations(variant_id, observed_at);
    CREATE INDEX IF NOT EXISTS idx_scan_runs_source_status ON scan_runs(source, status, completed_at);
  `);
  return db;
}

function todayBounds() {
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const end = new Date(start); end.setDate(end.getDate() + 1);
  return { start: start.toISOString(), end: end.toISOString() };
}

function refreshAllowance(source) {
  const db = initialiseDatabase();
  const { start, end } = todayBounds();
  const row = db.prepare("SELECT COUNT(*) AS count FROM scan_runs WHERE source=? AND status='completed' AND completed_at>=? AND completed_at<?").get(source, start, end);
  db.close();
  return { allowed: Number(row.count) < 1, scansToday: Number(row.count), limitPerDay: 1, nextAvailableAt: end };
}

function classifyGender(product, memberships, config) {
  const source = `${product.title} ${(product.tags || []).join(" ")}`;
  if (/boys?\s*(?:&|and)\s*(?:baby\s*)?girls?|girls?\s*(?:&|and)\s*(?:baby\s*)?boys?|\bunisex\b/i.test(source)) return "Unisex";
  const inBoys = config.boysCollections?.some((handle) => memberships.has(handle));
  const inGirls = config.girlsCollections?.some((handle) => memberships.has(handle));
  if (inBoys && inGirls) return "Unisex";
  if (inGirls || /\bgirls?\b/i.test(source)) return "Girls";
  if (inBoys || /\bboys?\b/i.test(source)) return "Boys";
  return config.defaultGender || "Unspecified";
}

function ageValuesInMonths(product, config) {
  const sizeOption = product.options.find((option) => option.name.toLowerCase() === "size");
  const source = [...(sizeOption?.values || []), product.title].join(" | ");
  const ranges = [];
  if (config.sizeCodeAges) {
    for (const [code, range] of Object.entries(config.sizeCodeAges)) if (new RegExp(`\\b${code}\\b`, "i").test(source)) ranges.push(range);
  }
  for (const match of source.matchAll(/(\d+(?:\.\d+)?)\s*(years?|yrs?|months?|mos?)?\s*(?:-|to)\s*(\d+(?:\.\d+)?)\s*(years?|yrs?|months?|mos?)/gi)) {
    const unit = (match[4] || match[2] || "years").toLowerCase();
    const factor = unit.startsWith("y") ? 12 : 1;
    ranges.push([Number(match[1]) * factor, Number(match[3]) * factor]);
  }
  for (const match of source.matchAll(/(\d+(?:\.\d+)?)\s*\+\s*(years?|yrs?|months?|mos?)/gi)) {
    const minimum = Number(match[1]) * (match[2].toLowerCase().startsWith("y") ? 12 : 1);
    ranges.push([minimum, 192]);
  }
  if (!ranges.length) return [];
  return [Math.min(...ranges.map((range) => range[0])), Math.max(...ranges.map((range) => range[1]))];
}

function classifyAgeBands(product, config) {
  const values = ageValuesInMonths(product, config);
  if (!values.length) return [];
  const [minimum, maximum] = values;
  return AGE_BANDS.filter((band) => maximum >= band.min && minimum <= band.max).map((band) => band.key);
}

function primaryType(product, memberships, config) {
  return config.typeDefinitions.find((definition) => definition.handles?.some((handle) => memberships.has(handle)))
    || config.typeDefinitions.find((definition) => definition.pattern?.test(`${product.product_type || ""} ${product.title} ${(product.tags || []).join(" ")}`))
    || config.fallbackType;
}

function normaliseProduct(product, membership, config) {
  const memberships = membership.get(String(product.id)) || new Set();
  const sizePosition = product.options.find((option) => option.name.toLowerCase() === "size")?.position || 1;
  const variants = product.variants.map((variant) => ({
    id: String(variant.id), sku: variant.sku || "", title: variant.title || "", size: variant[`option${sizePosition}`] || "",
    sellingPrice: Number(variant.price || 0), mrp: Number(variant.compare_at_price || variant.price || 0), available: Boolean(variant.available),
  }));
  const available = variants.filter((variant) => variant.available && variant.sellingPrice > 0);
  const representative = [...(available.length ? available : variants)].filter((variant) => variant.sellingPrice > 0).sort((a, b) => a.sellingPrice - b.sellingPrice)[0];
  const sellingPrice = representative?.sellingPrice || 0; const mrp = representative?.mrp || sellingPrice;
  const type = primaryType(product, memberships, config);
  return {
    id: String(product.id), title: product.title, handle: product.handle, url: `${config.baseUrl}/products/${product.handle}`,
    productType: type.label, productTypeKey: type.key, gender: classifyGender(product, memberships, config), ageBandKeys: classifyAgeBands(product, config),
    tags: (product.tags || []).map(String), description: stripHtml(product.body_html), imageUrl: product.images?.[0]?.src || "", publishedAt: product.published_at,
    variants, sellingPrice, mrp, discountPercent: mrp > sellingPrice ? round(((mrp - sellingPrice) / mrp) * 100) : 0,
    availableVariants: variants.filter((variant) => variant.available).length, totalVariants: variants.length,
    rating: 0, reviewCount: 0, displayedRating: 0, displayedReviewCount: 0, reviewPoolProductCount: 1, detailPageChecked: false, status: "existing",
  };
}

function extractReviewWidget(html) {
  const candidates = [
    ...[...html.matchAll(/data-average-rating=['"]([\d.]+)['"][^>]*data-number-of-reviews=['"](\d+)['"]/gi)].map((match) => ({ displayedRating: Number(match[1]), displayedReviewCount: Number(match[2]) })),
    ...[...html.matchAll(/data-number-of-reviews=['"](\d+)['"][^>]*data-average-rating=['"]([\d.]+)['"]/gi)].map((match) => ({ displayedRating: Number(match[2]), displayedReviewCount: Number(match[1]) })),
  ];
  const aggregate = candidates.sort((a, b) => b.displayedReviewCount - a.displayedReviewCount)[0] || { displayedRating: 0, displayedReviewCount: 0 };
  const reviewFingerprints = html.split(/(?=<div class=['"]jdgm-rev jdgm-divider-top['"])/gi).slice(1).map((block) => {
    const score = block.match(/class=['"]jdgm-rev__rating['"][^>]*data-score=['"]?([\d.]+)/i)?.[1] || "";
    const date = block.match(/class=['"]jdgm-rev__timestamp[^'"]*['"][^>]*datetime=['"]([^'"]+)/i)?.[1] || "";
    const author = stripHtml(block.match(/class=['"]jdgm-rev__author['"]>([\s\S]*?)<\/span>/i)?.[1] || "").toLowerCase();
    const title = stripHtml(block.match(/class=['"]jdgm-rev__title['"]>([\s\S]*?)<\/b>/i)?.[1] || "").toLowerCase();
    const body = stripHtml(block.match(/class=['"]jdgm-rev__body['"]>([\s\S]*?)<\/div>/i)?.[1] || "").toLowerCase();
    return [score, date, author, title, body].join("|");
  }).filter((fingerprint) => fingerprint.replaceAll("|", "").length > 0);
  return { ...aggregate, reviewPoolKey: reviewFingerprints.length ? [...new Set(reviewFingerprints)].sort().slice(0, 5).join("||") : "" };
}

function reconcileReviewAggregates(products) {
  const groups = new Map();
  for (const product of products) {
    const key = product.reviewPoolKey || `product:${product.id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(product);
  }
  let uniqueReviews = 0; let weightedStars = 0; let duplicateReviewMentions = 0; let sharedPoolCount = 0;
  for (const group of groups.values()) {
    const representative = [...group].sort((a, b) => b.displayedReviewCount - a.displayedReviewCount)[0];
    const count = representative.displayedReviewCount; const rating = representative.displayedRating;
    representative.reviewCount = count; representative.rating = rating;
    uniqueReviews += count; weightedStars += rating * count;
    if (group.length > 1) {
      sharedPoolCount += 1;
      duplicateReviewMentions += group.reduce((sum, product) => sum + product.displayedReviewCount, 0) - count;
      for (const product of group) product.reviewPoolProductCount = group.length;
    }
    for (const product of group) delete product.reviewPoolKey;
  }
  const displayedReviewMentions = products.reduce((sum, product) => sum + product.displayedReviewCount, 0);
  const ageCoverageMentions = products.reduce((sum, product) => sum + product.reviewCount * product.ageBandKeys.length, 0);
  return {
    status: sharedPoolCount ? "Deduplicated shared review pools" : "Healthy",
    uniqueReviews, activeCatalogueReviews: uniqueReviews, historicalReviews: 0, displayedReviewMentions,
    duplicateReviewMentions: Math.max(duplicateReviewMentions, displayedReviewMentions - uniqueReviews), sharedPoolCount,
    ageCoverageMentions, ageOverlapMentions: Math.max(0, ageCoverageMentions - uniqueReviews),
    averageRating: uniqueReviews ? round(weightedStars / uniqueReviews, 2) : 0,
  };
}

async function fetchCatalogue(config) {
  const products = [];
  for (let page = 1; page <= 20; page += 1) {
    const payload = JSON.parse(await fetchText(`${config.baseUrl}/collections/all/products.json?limit=250&page=${page}`));
    products.push(...(payload.products || []));
    if ((payload.products || []).length < 250) break;
  }
  return products.filter((product) => !config.excludeProduct?.(product));
}

async function readCollectionMembership(config) {
  const membership = new Map();
  const handles = [...new Set(config.typeDefinitions.flatMap((definition) => definition.handles || []).concat(config.boysCollections || [], config.girlsCollections || []))];
  await Promise.all(handles.map(async (handle) => {
    try {
      const payload = JSON.parse(await fetchText(`${config.baseUrl}/collections/${handle}/products.json?limit=250`, 2));
      for (const product of payload.products || []) {
        const id = String(product.id); if (!membership.has(id)) membership.set(id, new Set()); membership.get(id).add(handle);
      }
    } catch { /* Product title and native type remain available as a fallback. */ }
  }));
  return membership;
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length); let index = 0;
  async function worker() { while (index < items.length) { const current = index; index += 1; results[current] = await mapper(items[current], current); } }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}

function extractCampaigns(config, homepageHtml, detailHtml, observedAt) {
  const homepage = visibleText(homepageHtml); const detail = visibleText(detailHtml); const campaigns = [];
  const add = (campaign) => { if (!campaigns.some((item) => item.key === campaign.key)) campaigns.push({ ...campaign, observedAt }); };
  const firstBuy = homepage.match(/use\s+([A-Z0-9]+)\s+to\s+get\s+(\d+)%\s+off\s+on\s+(?:your\s+)?first\s+buy/i)
    || homepage.match(/first\s+(?:buy|order)[^%]{0,80}?(\d+)%\s+off/i);
  if (firstBuy) {
    const hasCode = /[A-Z]/.test(firstBuy[1] || ""); const discount = hasCode ? firstBuy[2] : firstBuy[1]; const code = hasCode ? firstBuy[1].toUpperCase() : "";
    add({ key: `${config.id}:first-buy`, title: "First-purchase offer", detail: code ? `Use ${code} on the first purchase.` : "Discount promoted on a customer's first purchase.", discountText: `${discount}% off`, type: "Coupon", sourceSurface: "Announcement bar" });
  }
  for (const match of detail.matchAll(/use\s+(?:coupon\s+)?([A-Z][A-Z0-9]+)\s+at\s+checkout\s+to\s+get\s+(\d+)%\s+discount/gi)) {
    add({ key: `${config.id}:coupon:${match[1].toLowerCase()}`, title: "Checkout coupon", detail: `Use ${match[1].toUpperCase()} at checkout.`, discountText: `${match[2]}% off`, type: "Coupon", sourceSurface: "Product page" });
  }
  const newsletter = homepage.match(/sign\s+up\s+for\s+our\s+newsletter\s+and\s+receive\s+(\d+)%\s+off/i);
  if (newsletter) add({ key: `${config.id}:newsletter`, title: "Newsletter signup offer", detail: "Discount promoted for newsletter signup.", discountText: `${newsletter[1]}% off`, type: "Signup offer", sourceSurface: "Website footer" });
  const freeShipping = detail.match(/free\s+shipping[^.]{0,100}?(?:above|over)\s+(?:inr|rs\.?|₹)\s*(\d+)/i) || homepage.match(/free\s+shipping[^.]{0,100}?(?:above|over)\s+(?:inr|rs\.?|₹)\s*(\d+)/i);
  if (freeShipping) add({ key: `${config.id}:free-shipping`, title: "Free shipping threshold", detail: `Free shipping is promoted for orders above ₹${freeShipping[1]}.`, discountText: `Above ₹${freeShipping[1]}`, type: "Shipping benefit", sourceSurface: "Product page" });
  return campaigns;
}

function categoryAggregate(products, definitions, predicate) {
  return definitions.map((definition) => {
    const matching = products.filter((product) => predicate(product, definition));
    const totalReviews = matching.reduce((sum, product) => sum + product.reviewCount, 0);
    const reviewStars = matching.reduce((sum, product) => sum + product.rating * product.reviewCount, 0);
    return { key: definition.key, label: definition.label, productCount: matching.length, averageSellingPrice: round(average(matching.map((product) => product.sellingPrice)), 0), averageDiscount: round(average(matching.map((product) => product.discountPercent))), totalReviews, averageRating: totalReviews ? round(reviewStars / totalReviews, 2) : 0 };
  });
}

function buildCategories(products, config) {
  const types = [...config.typeDefinitions.map(({ key, label }) => ({ key, label })), config.fallbackType].filter((definition, index, rows) => rows.findIndex((row) => row.key === definition.key) === index && products.some((product) => product.productTypeKey === definition.key));
  const genders = ["Unisex", "Girls", "Boys", "Unspecified"].map((label) => ({ key: label.toLowerCase(), label })).filter((definition) => products.some((product) => product.gender === definition.label));
  return {
    type: categoryAggregate(products, types, (product, definition) => product.productTypeKey === definition.key),
    gender: categoryAggregate(products, genders, (product, definition) => product.gender === definition.label),
    age: categoryAggregate(products, AGE_BANDS, (product, definition) => product.ageBandKeys.includes(definition.key)),
  };
}

function priceSeverity(previous, current) {
  if (!previous || previous === current) return null;
  const absolute = Math.abs(current - previous); const percentage = (absolute / previous) * 100;
  if (absolute >= 100 || percentage >= 10) return "major";
  if (absolute >= 25 || percentage >= 3) return "normal";
  return null;
}

function persist(db, runId, observedAt, products, campaigns, config) {
  const known = new Map(db.prepare("SELECT product_id, active FROM products WHERE brand=?").all(config.brandName).map((row) => [row.product_id, row]));
  const seen = new Set(products.map((product) => product.id));
  const campaignPrefix = `${config.id}:%`;
  const knownCampaigns = new Map(db.prepare("SELECT campaign_key, active FROM campaigns WHERE campaign_key LIKE ?").all(campaignPrefix).map((row) => [row.campaign_key, row]));
  const currentCampaignKeys = new Set(campaigns.map((campaign) => campaign.key));
  const productUpsert = db.prepare("INSERT INTO products (product_id,brand,title,handle,canonical_url,product_type,gender,age_band_keys,tags,image_url,published_at,first_seen_at,last_seen_at,active) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,1) ON CONFLICT(product_id) DO UPDATE SET brand=excluded.brand,title=excluded.title,handle=excluded.handle,canonical_url=excluded.canonical_url,product_type=excluded.product_type,gender=excluded.gender,age_band_keys=excluded.age_band_keys,tags=excluded.tags,image_url=excluded.image_url,published_at=excluded.published_at,last_seen_at=excluded.last_seen_at,active=1");
  const variantUpsert = db.prepare("INSERT INTO variants (variant_id,product_id,sku,title,size,selling_price,mrp,available,last_seen_at) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(variant_id) DO UPDATE SET product_id=excluded.product_id,sku=excluded.sku,title=excluded.title,size=excluded.size,selling_price=excluded.selling_price,mrp=excluded.mrp,available=excluded.available,last_seen_at=excluded.last_seen_at");
  const productObservation = db.prepare("INSERT INTO product_observations (run_id,product_id,observed_at,selling_price,mrp,discount_percent,available_variants,total_variants,rating,review_count) VALUES (?,?,?,?,?,?,?,?,?,?)");
  const variantObservation = db.prepare("INSERT INTO variant_observations (run_id,variant_id,product_id,observed_at,selling_price,mrp,available) VALUES (?,?,?,?,?,?,?)");
  const eventInsert = db.prepare("INSERT INTO events (run_id,occurred_at,event_type,severity,product_id,variant_id,title,detail,previous_value,current_value) VALUES (?,?,?,?,?,?,?,?,?,?)");
  const campaignUpsert = db.prepare("INSERT INTO campaigns (campaign_key,title,detail,discount_text,first_seen_at,last_seen_at,active) VALUES (?,?,?,?,?,?,1) ON CONFLICT(campaign_key) DO UPDATE SET title=excluded.title,detail=excluded.detail,discount_text=excluded.discount_text,last_seen_at=excluded.last_seen_at,active=1");
  db.exec("BEGIN");
  try {
    for (const product of products) {
      const isNew = !known.has(product.id); product.status = isNew ? "new" : "existing";
      productUpsert.run(product.id, config.brandName, product.title, product.handle, product.url, product.productType, product.gender, JSON.stringify(product.ageBandKeys), JSON.stringify(product.tags), product.imageUrl, product.publishedAt, observedAt, observedAt);
      if (isNew) eventInsert.run(runId, observedAt, "product_added", "normal", product.id, null, `New product: ${product.title}`, product.productType, null, null);
      productObservation.run(runId, product.id, observedAt, product.sellingPrice, product.mrp, product.discountPercent, product.availableVariants, product.totalVariants, product.rating, product.reviewCount);
      for (const variant of product.variants) {
        const previous = db.prepare("SELECT selling_price FROM variant_observations WHERE variant_id=? ORDER BY observed_at DESC LIMIT 1").get(variant.id);
        variantUpsert.run(variant.id, product.id, variant.sku, variant.title, variant.size, variant.sellingPrice, variant.mrp, variant.available ? 1 : 0, observedAt);
        variantObservation.run(runId, variant.id, product.id, observedAt, variant.sellingPrice, variant.mrp, variant.available ? 1 : 0);
        const severity = previous ? priceSeverity(Number(previous.selling_price), variant.sellingPrice) : null;
        if (severity) eventInsert.run(runId, observedAt, "price_changed", severity, product.id, variant.id, `Price changed: ${product.title} · ${variant.size}`, `₹${previous.selling_price} → ₹${variant.sellingPrice}`, Number(previous.selling_price), variant.sellingPrice);
      }
    }
    for (const [productId, row] of known) if (row.active && !seen.has(productId)) { db.prepare("UPDATE products SET active=0 WHERE product_id=?").run(productId); eventInsert.run(runId, observedAt, "possibly_removed", "normal", productId, null, "Possibly removed product", "Missing from this successful catalogue scan; targeted recheck is required.", null, null); }
    db.prepare("UPDATE campaigns SET active=0 WHERE campaign_key LIKE ?").run(campaignPrefix);
    for (const campaign of campaigns) {
      campaignUpsert.run(campaign.key, campaign.title, campaign.detail, campaign.discountText, observedAt, observedAt);
      if (!knownCampaigns.has(campaign.key)) eventInsert.run(runId, observedAt, "campaign_added", "normal", null, null, `New campaign: ${campaign.title}`, campaign.detail, null, null);
    }
    for (const [key, row] of knownCampaigns) if (row.active && !currentCampaignKeys.has(key)) eventInsert.run(runId, observedAt, "campaign_removed", "normal", null, null, `Campaign ended: ${key}`, "Not found on the latest successful website scan.", null, null);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

export function createShopifyBrandCollector(config) {
  const getAllowance = () => refreshAllowance(config.id);
  const run = async ({ force = false, onProgress = () => {} } = {}) => {
    await Promise.all([mkdir(dataDir, { recursive: true }), mkdir(publicDataDir, { recursive: true })]);
    const allowance = getAllowance();
    if (!force && !allowance.allowed) { const error = new Error(`The ${config.brandName} one-full-refresh-per-day limit has already been used.`); error.code = "DAILY_LIMIT"; error.allowance = allowance; throw error; }
    const db = initialiseDatabase(); const startedAt = new Date().toISOString();
    const runId = Number(db.prepare("INSERT INTO scan_runs (source,started_at,status) VALUES (?,?,'running')").run(config.id, startedAt).lastInsertRowid);
    try {
      onProgress({ phase: "catalogue", current: 0, total: 0, message: `Reading the ${config.brandName} catalogue and native collections` });
      const [rawProducts, membership] = await Promise.all([fetchCatalogue(config), readCollectionMembership(config)]);
      const products = rawProducts.map((product) => normaliseProduct(product, membership, config));
      let pageSuccessCount = 0; let pageFailureCount = 0; let firstDetailHtml = "";
      await mapWithConcurrency(products, 3, async (product, index) => {
        try {
          const html = await fetchText(product.url, 2); if (!firstDetailHtml) firstDetailHtml = html;
          Object.assign(product, extractReviewWidget(html), { detailPageChecked: true }); pageSuccessCount += 1;
        } catch { pageFailureCount += 1; }
        onProgress({ phase: "reviews", current: index + 1, total: products.length, message: `Checking ${config.brandName} ratings ${index + 1}/${products.length}` });
        await wait(250);
      });
      const reviewAccounting = reconcileReviewAggregates(products);
      let homepageHtml = ""; try { homepageHtml = await fetchText(config.baseUrl, 2); } catch { /* Campaign failure does not invalidate catalogue data. */ }
      const observedAt = new Date().toISOString(); const campaigns = extractCampaigns(config, homepageHtml, firstDetailHtml, observedAt);
      const completedBefore = Number(db.prepare("SELECT COUNT(*) AS count FROM scan_runs WHERE source=? AND status='completed'").get(config.id).count);
      persist(db, runId, observedAt, products, campaigns, config);
      const rated = products.filter((product) => product.reviewCount > 0); const categories = buildCategories(products, config);
      const events = completedBefore === 0 ? [] : db.prepare("SELECT event_type AS type,severity,title,detail,product_id AS productId,variant_id AS variantId,previous_value AS previousValue,current_value AS currentValue,occurred_at AS occurredAt FROM events WHERE run_id=? ORDER BY id DESC").all(runId);
      const nextRefresh = new Date(); nextRefresh.setDate(nextRefresh.getDate() + 1); nextRefresh.setHours(0, 0, 0, 0);
      const summary = {
        source: { id: config.id, brand: config.brandName, url: config.baseUrl, mode: "Public website" }, generatedAt: observedAt, isBaseline: completedBefore === 0,
        metrics: { activeListings: products.length, variantCount: products.reduce((sum, product) => sum + product.totalVariants, 0), averageSellingPrice: round(average(products.map((product) => product.sellingPrice)), 0), averageDiscount: round(average(products.map((product) => product.discountPercent))), campaignCount: campaigns.length, totalReviews: reviewAccounting.uniqueReviews, averageRating: reviewAccounting.averageRating, averageReviewsPerProduct: round(reviewAccounting.activeCatalogueReviews / Math.max(rated.length, 1), 0), ratedProducts: rated.length },
        categories, campaigns, events, reviewAccounting,
        campaignHealth: { status: homepageHtml ? "Healthy" : "Partial", inspectedSurfaces: ["Homepage", "Product pages"] },
        health: { status: products.length > 0 && pageSuccessCount / products.length >= 0.9 ? "Healthy" : "Partial", catalogueComplete: products.length > 0, pricedProducts: products.filter((product) => product.sellingPrice > 0).length, detailPagesChecked: pageSuccessCount, detailPagesFailed: pageFailureCount },
        refresh: { allowed: false, scansToday: 1, limitPerDay: 1, nextAvailableAt: nextRefresh.toISOString() },
      };
      await Promise.all([writeFile(path.join(publicDataDir, `${config.id}-summary.json`), JSON.stringify(summary, null, 2)), writeFile(path.join(publicDataDir, `${config.id}-products.json`), JSON.stringify({ source: summary.source, generatedAt: observedAt, products }, null, 2))]);
      db.prepare("UPDATE scan_runs SET completed_at=?,status='completed',product_count=?,page_success_count=?,page_failure_count=? WHERE id=?").run(observedAt, products.length, pageSuccessCount, pageFailureCount, runId);
      db.exec("PRAGMA optimize"); db.close();
      onProgress({ phase: "complete", current: products.length, total: products.length, message: `${config.brandName} refresh completed` });
      return summary;
    } catch (error) {
      db.prepare("UPDATE scan_runs SET completed_at=?,status='failed',error_message=? WHERE id=?").run(new Date().toISOString(), String(error.message || error), runId); db.close(); throw error;
    }
  };
  return { run, getAllowance };
}
