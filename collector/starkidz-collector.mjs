import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = path.join(projectDir, "data");
const publicDataDir = path.join(projectDir, "public", "data");
const databasePath = path.join(dataDir, "market-pulse.sqlite");
const BASE_URL = "https://www.starkidz.co.in";
const CATALOG_URL = `${BASE_URL}/collections/all/products.json?limit=250`;
const REVIEW_API_URL = "https://api.judge.me/reviews/reviews_for_widget";
const REVIEW_SHOP_DOMAIN = "89c352-2.myshopify.com";
const USER_AGENT = "Starkidz Competitor Intelligence/1.0 (internal catalogue monitor; low-frequency)";

const TYPE_DEFINITIONS = [
  { key: "school-wear", label: "School Wear", handles: ["school-wear"], pattern: /school/i },
  { key: "party-wear", label: "Party Wear", handles: ["party-wear-shoes"], pattern: /party|ballerina|belly/i },
  { key: "sport-shoes", label: "Sport Shoes", handles: ["sports-shoe"], pattern: /sport|running/i },
  { key: "sneakers", label: "Sneakers", handles: ["sneakers-for-boys-girls"], pattern: /sneaker/i },
  { key: "clogs-slip-ons", label: "Clogs & Slip-ons", handles: ["clogs"], pattern: /clog|slip[ -]?on/i },
  { key: "sandals", label: "Sandals", handles: ["sandals-girls-boys"], pattern: /sandal/i },
  { key: "casual-shoes", label: "Casual Shoes", handles: ["casual-shoes-kids", "casual-wear"], pattern: /casual|lace|loafer/i },
];
const AGE_BANDS = [
  { key: "0-3-years", label: "0–3 years", min: 0, max: 36 },
  { key: "3-6-years", label: "3–6 years", min: 36, max: 72 },
  { key: "6-9-years", label: "6–9 years", min: 72, max: 108 },
  { key: "9-16-years", label: "9–16 years", min: 108, max: 192 },
];

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const round = (value, digits = 1) => Number(Number(value || 0).toFixed(digits));
const average = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
const stripHtml = (value = "") => value.replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

async function fetchText(url, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { "user-agent": USER_AGENT, accept: "text/html,application/json" }, signal: AbortSignal.timeout(30_000) });
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

export function getStarkidzRefreshAllowance() {
  const db = initialiseDatabase();
  const { start, end } = todayBounds();
  const row = db.prepare("SELECT COUNT(*) AS count FROM scan_runs WHERE source=? AND status='completed' AND completed_at>=? AND completed_at<?").get("starkidz", start, end);
  db.close();
  return { allowed: Number(row.count) < 1, scansToday: Number(row.count), limitPerDay: 1, nextAvailableAt: end };
}

function classifyGender(title) {
  if (/boys?\s*(?:&|and)\s*girls?|girls?\s*(?:&|and)\s*boys?|unisex/i.test(title)) return "Unisex";
  if (/\bgirls?\b/i.test(title)) return "Girls";
  if (/\bboys?\b/i.test(title)) return "Boys";
  return "Unspecified";
}

function ageValuesInMonths(product) {
  const source = [...product.options.flatMap((option) => option.values || []), product.title].join(" | ").toLowerCase();
  const values = [];
  for (const match of source.matchAll(/(\d+(?:\.\d+)?)\s*(?:-|to)\s*(\d+(?:\.\d+)?)\s*(years?|yrs?|months?|mos?)/gi)) {
    const factor = match[3].toLowerCase().startsWith("y") ? 12 : 1;
    values.push(Number(match[1]) * factor, Number(match[2]) * factor);
  }
  for (const match of source.matchAll(/(\d+(?:\.\d+)?)\s*(years?|yrs?|months?|mos?)/gi)) values.push(Number(match[1]) * (match[2].toLowerCase().startsWith("y") ? 12 : 1));
  return [...new Set(values.filter(Number.isFinite))];
}

function classifyAges(product) {
  const values = ageValuesInMonths(product);
  if (!values.length) return [];
  const min = Math.min(...values); const max = Math.max(...values);
  return AGE_BANDS.filter((band) => max >= band.min && min <= band.max).map((band) => band.key);
}

function extractReviewRecords(html) {
  return [...html.matchAll(/data-review-id=['"]([^'"]+)['"][^>]*data-product-title=['"][^'"]*['"][^>]*data-product-url=['"]([^'"]*)['"][\s\S]*?class=['"]jdgm-rev__rating['"][^>]*data-score=['"]?(\d+(?:\.\d+)?)/gi)]
    .map((match) => ({ id: match[1], productPath: match[2], score: Number(match[3]) }))
    .filter((review) => review.id && Number.isFinite(review.score));
}

function extractReviewWidget(html) {
  const candidates = [
    ...[...html.matchAll(/data-average-rating=['"]([\d.]+)['"][^>]*data-number-of-reviews=['"](\d+)['"]/gi)].map((match) => ({ displayedRating: Number(match[1]), displayedReviewCount: Number(match[2]) })),
    ...[...html.matchAll(/data-number-of-reviews=['"](\d+)['"][^>]*data-average-rating=['"]([\d.]+)['"]/gi)].map((match) => ({ displayedRating: Number(match[2]), displayedReviewCount: Number(match[1]) })),
  ];
  const aggregate = candidates.sort((a, b) => b.displayedReviewCount - a.displayedReviewCount)[0] || { displayedRating: 0, displayedReviewCount: 0 };
  const firstPageReviews = extractReviewRecords(html);
  const productId = html.match(/class=['"][^'"]*jdgm-review-widget[^'"]*['"][^>]*data-id=['"](\d+)['"]/i)?.[1]
    || html.match(/data-id=['"](\d+)['"][^>]*data-product-id/i)?.[1]
    || "";
  const reviewPoolKey = firstPageReviews.map((review) => review.id).sort().join("|") || (aggregate.displayedReviewCount ? `product:${productId}` : "");
  return { ...aggregate, reviewWidgetProductId: productId, reviewPoolKey, firstPageReviews };
}

async function fetchReviewPage(productId, page) {
  const url = new URL(REVIEW_API_URL);
  url.search = new URLSearchParams({ url: REVIEW_SHOP_DOMAIN, shop_domain: REVIEW_SHOP_DOMAIN, platform: "shopify", page: String(page), per_page: "5", product_id: productId }).toString();
  const payload = JSON.parse(await fetchText(url.toString(), 2));
  return extractReviewRecords(payload.html || "");
}

async function reconcileReviews(products) {
  const pools = new Map();
  for (const product of products) {
    if (!product.reviewPoolKey || !product.displayedReviewCount) continue;
    if (!pools.has(product.reviewPoolKey)) pools.set(product.reviewPoolKey, { representative: product, products: [] });
    pools.get(product.reviewPoolKey).products.push(product);
  }

  const uniqueReviews = new Map();
  for (const pool of pools.values()) {
    const { representative } = pool;
    const records = [...representative.firstPageReviews];
    const pageCount = Math.ceil(representative.displayedReviewCount / 5);
    for (let page = 2; page <= pageCount; page += 1) records.push(...await fetchReviewPage(representative.reviewWidgetProductId, page));
    const poolReviews = new Map(records.map((review) => [review.id, review]));
    if (poolReviews.size !== representative.displayedReviewCount) throw new Error(`Review reconciliation incomplete for ${representative.title}: expected ${representative.displayedReviewCount}, received ${poolReviews.size}.`);
    for (const review of poolReviews.values()) uniqueReviews.set(review.id, review);
    for (const product of pool.products) product.reviewPoolProductCount = pool.products.length;
  }

  const productsByPath = new Map(products.map((product) => [new URL(product.url).pathname, product]));
  const ownedReviews = new Map(products.map((product) => [product.id, []]));
  let historicalReviews = 0;
  for (const review of uniqueReviews.values()) {
    const product = productsByPath.get(review.productPath);
    if (product) ownedReviews.get(product.id).push(review);
    else historicalReviews += 1;
  }
  for (const product of products) {
    const reviews = ownedReviews.get(product.id);
    product.reviewCount = reviews.length;
    product.rating = reviews.length ? round(average(reviews.map((review) => review.score)), 2) : 0;
    delete product.firstPageReviews;
    delete product.reviewWidgetProductId;
    delete product.reviewPoolKey;
  }

  const activeCatalogueReviews = uniqueReviews.size - historicalReviews;
  const ageCoverageMentions = products.reduce((sum, product) => sum + product.reviewCount * product.ageBandKeys.length, 0);
  const displayedReviewMentions = products.reduce((sum, product) => sum + product.displayedReviewCount, 0);
  return {
    status: "Healthy",
    uniqueReviews: uniqueReviews.size,
    activeCatalogueReviews,
    historicalReviews,
    displayedReviewMentions,
    duplicateReviewMentions: displayedReviewMentions - uniqueReviews.size,
    sharedPoolCount: [...pools.values()].filter((pool) => pool.products.length > 1).length,
    ageCoverageMentions,
    ageOverlapMentions: ageCoverageMentions - activeCatalogueReviews,
    averageRating: round(average([...uniqueReviews.values()].map((review) => review.score)), 2),
  };
}

function selectPrimaryType(product, collectionMembership) {
  const memberships = collectionMembership.get(String(product.id)) || new Set();
  return TYPE_DEFINITIONS.find((definition) => definition.handles.some((handle) => memberships.has(handle)))
    || TYPE_DEFINITIONS.find((definition) => definition.pattern.test(product.title))
    || { key: "other", label: "Other" };
}

function normaliseProduct(product, collectionMembership) {
  const variants = product.variants.map((variant) => ({ id: String(variant.id), sku: variant.sku || "", title: variant.title || "", size: variant.option1 || "", sellingPrice: Number(variant.price || 0), mrp: Number(variant.compare_at_price || variant.price || 0), available: Boolean(variant.available) }));
  const priced = variants.filter((variant) => variant.available && variant.sellingPrice > 0);
  const representative = [...(priced.length ? priced : variants)].filter((variant) => variant.sellingPrice > 0).sort((a, b) => a.sellingPrice - b.sellingPrice)[0];
  const sellingPrice = representative?.sellingPrice || 0; const mrp = representative?.mrp || sellingPrice;
  const primaryType = selectPrimaryType(product, collectionMembership);
  return {
    id: String(product.id), title: product.title, handle: product.handle, url: `${BASE_URL}/products/${product.handle}`,
    productType: primaryType.label, productTypeKey: primaryType.key, gender: classifyGender(product.title), ageBandKeys: classifyAges(product),
    tags: (product.tags || []).map(String), description: stripHtml(product.body_html), imageUrl: product.images?.[0]?.src || "", publishedAt: product.published_at,
    variants, sellingPrice, mrp, discountPercent: mrp > sellingPrice ? round(((mrp - sellingPrice) / mrp) * 100) : 0,
    availableVariants: variants.filter((variant) => variant.available).length, totalVariants: variants.length,
    rating: 0, reviewCount: 0, displayedRating: 0, displayedReviewCount: 0, reviewPoolProductCount: 0, detailPageChecked: false, status: "existing",
  };
}

async function readCollectionMembership() {
  const membership = new Map();
  const handles = [...new Set(TYPE_DEFINITIONS.flatMap((definition) => definition.handles))];
  await Promise.all(handles.map(async (handle) => {
    try {
      const payload = JSON.parse(await fetchText(`${BASE_URL}/collections/${handle}/products.json?limit=250`, 2));
      for (const product of payload.products || []) {
        const id = String(product.id);
        if (!membership.has(id)) membership.set(id, new Set());
        membership.get(id).add(handle);
      }
    } catch { /* title fallback keeps the catalogue usable */ }
  }));
  return membership;
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length); let index = 0;
  async function worker() { while (index < items.length) { const current = index; index += 1; results[current] = await mapper(items[current], current); } }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}

function extractCampaigns(html, observedAt) {
  const text = stripHtml(html); const campaigns = [];
  const firstOrder = text.match(/(?:1st|first)\s+order\s+(\d+)%\s*off/i);
  if (firstOrder) campaigns.push({ key: "starkidz:first-order", title: "First-order offer", detail: "Discount promoted for a customer’s first order.", discountText: `${firstOrder[1]}% off`, type: "Coupon", observedAt });
  const tiers = [...new Map([...text.matchAll(/buy\s*(\d+)\s*get\s*(\d+)%\s*off/gi)].map((match) => [`${match[1]}:${match[2]}`, { quantity: match[1], discount: match[2] }])).values()];
  if (tiers.length) campaigns.push({ key: "starkidz:multi-buy", title: "Multi-buy offer", detail: tiers.map((tier) => `Buy ${tier.quantity} · ${tier.discount}% off`).join("; "), discountText: tiers.map((tier) => `${tier.discount}%`).join(" / "), type: "Multi-buy", observedAt });
  const sale = text.match(/end\s+of\s+season\s+sale\s+up\s*to\s*(\d+)%/i);
  if (sale) campaigns.push({ key: "starkidz:end-of-season", title: "End-of-season sale", detail: "Sitewide end-of-season sale message.", discountText: `Up to ${sale[1]}%`, type: "Seasonal sale", observedAt });
  if (/free\s+shipping\s+on\s+prepaid\s+orders/i.test(text)) campaigns.push({ key: "starkidz:free-shipping", title: "Free prepaid shipping", detail: "Free shipping is promoted for prepaid orders.", discountText: "Service benefit", type: "Shipping benefit", observedAt });
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

function buildCategories(products) {
  const types = [...TYPE_DEFINITIONS.map(({ key, label }) => ({ key, label })), { key: "other", label: "Other" }].filter((definition) => products.some((product) => product.productTypeKey === definition.key));
  const genders = ["Unisex", "Girls", "Boys", "Unspecified"].map((label) => ({ key: label.toLowerCase(), label }));
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

function persist(db, runId, observedAt, products, campaigns) {
  const known = new Map(db.prepare("SELECT product_id, active FROM products WHERE brand='Starkidz'").all().map((row) => [row.product_id, row]));
  const seen = new Set(products.map((product) => product.id));
  const productUpsert = db.prepare("INSERT INTO products (product_id,brand,title,handle,canonical_url,product_type,gender,age_band_keys,tags,image_url,published_at,first_seen_at,last_seen_at,active) VALUES (?,'Starkidz',?,?,?,?,?,?,?,?,?,?,?,1) ON CONFLICT(product_id) DO UPDATE SET title=excluded.title,handle=excluded.handle,canonical_url=excluded.canonical_url,product_type=excluded.product_type,gender=excluded.gender,age_band_keys=excluded.age_band_keys,tags=excluded.tags,image_url=excluded.image_url,published_at=excluded.published_at,last_seen_at=excluded.last_seen_at,active=1");
  const variantUpsert = db.prepare("INSERT INTO variants (variant_id,product_id,sku,title,size,selling_price,mrp,available,last_seen_at) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(variant_id) DO UPDATE SET product_id=excluded.product_id,sku=excluded.sku,title=excluded.title,size=excluded.size,selling_price=excluded.selling_price,mrp=excluded.mrp,available=excluded.available,last_seen_at=excluded.last_seen_at");
  const productObservation = db.prepare("INSERT INTO product_observations (run_id,product_id,observed_at,selling_price,mrp,discount_percent,available_variants,total_variants,rating,review_count) VALUES (?,?,?,?,?,?,?,?,?,?)");
  const variantObservation = db.prepare("INSERT INTO variant_observations (run_id,variant_id,product_id,observed_at,selling_price,mrp,available) VALUES (?,?,?,?,?,?,?)");
  const eventInsert = db.prepare("INSERT INTO events (run_id,occurred_at,event_type,severity,product_id,variant_id,title,detail,previous_value,current_value) VALUES (?,?,?,?,?,?,?,?,?,?)");
  const campaignUpsert = db.prepare("INSERT INTO campaigns (campaign_key,title,detail,discount_text,first_seen_at,last_seen_at,active) VALUES (?,?,?,?,?,?,1) ON CONFLICT(campaign_key) DO UPDATE SET title=excluded.title,detail=excluded.detail,discount_text=excluded.discount_text,last_seen_at=excluded.last_seen_at,active=1");
  db.exec("BEGIN");
  try {
    for (const product of products) {
      const isNew = !known.has(product.id); product.status = isNew ? "new" : "existing";
      productUpsert.run(product.id, product.title, product.handle, product.url, product.productType, product.gender, JSON.stringify(product.ageBandKeys), JSON.stringify(product.tags), product.imageUrl, product.publishedAt, observedAt, observedAt);
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
    for (const campaign of campaigns) campaignUpsert.run(campaign.key, campaign.title, campaign.detail, campaign.discountText, observedAt, observedAt);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

export async function runStarkidzCollection({ force = false, onProgress = () => {} } = {}) {
  await Promise.all([mkdir(dataDir, { recursive: true }), mkdir(publicDataDir, { recursive: true })]);
  const allowance = getStarkidzRefreshAllowance();
  if (!force && !allowance.allowed) { const error = new Error("The Starkidz one-full-refresh-per-day limit has already been used."); error.code = "DAILY_LIMIT"; error.allowance = allowance; throw error; }
  const db = initialiseDatabase(); const startedAt = new Date().toISOString();
  const runId = Number(db.prepare("INSERT INTO scan_runs (source,started_at,status) VALUES ('starkidz',?,'running')").run(startedAt).lastInsertRowid);
  try {
    onProgress({ phase: "catalogue", current: 0, total: 0, message: "Reading the Starkidz catalogue and collections" });
    const [catalogueText, membership] = await Promise.all([fetchText(CATALOG_URL), readCollectionMembership()]);
    const products = JSON.parse(catalogueText).products.map((product) => normaliseProduct(product, membership));
    let pageSuccessCount = 0; let pageFailureCount = 0;
    await mapWithConcurrency(products, 2, async (product, index) => {
      try { Object.assign(product, extractReviewWidget(await fetchText(product.url, 2)), { detailPageChecked: true }); pageSuccessCount += 1; } catch { pageFailureCount += 1; }
      onProgress({ phase: "reviews", current: index + 1, total: products.length, message: `Checking Starkidz reviews ${index + 1}/${products.length}` });
      await wait(350);
    });
    onProgress({ phase: "reviews", current: products.length, total: products.length, message: "Reconciling shared Starkidz review pools" });
    const reviewAccounting = await reconcileReviews(products);
    let homepageHtml = ""; try { homepageHtml = await fetchText(BASE_URL, 2); } catch { /* independent campaign failure */ }
    const observedAt = new Date().toISOString(); const campaigns = extractCampaigns(homepageHtml, observedAt);
    const completedBefore = Number(db.prepare("SELECT COUNT(*) AS count FROM scan_runs WHERE source='starkidz' AND status='completed'").get().count);
    persist(db, runId, observedAt, products, campaigns);
    const rated = products.filter((product) => product.reviewCount > 0); const categories = buildCategories(products);
    const events = completedBefore === 0 ? [] : db.prepare("SELECT event_type AS type,severity,title,detail,product_id AS productId,variant_id AS variantId,previous_value AS previousValue,current_value AS currentValue,occurred_at AS occurredAt FROM events WHERE run_id=? ORDER BY id DESC").all(runId);
    const nextRefresh = new Date(); nextRefresh.setDate(nextRefresh.getDate() + 1); nextRefresh.setHours(0, 0, 0, 0);
    const summary = {
      source: { id: "starkidz", brand: "Starkidz", url: BASE_URL, mode: "Public website" }, generatedAt: observedAt, isBaseline: completedBefore === 0,
      metrics: { activeListings: products.length, variantCount: products.reduce((sum, product) => sum + product.totalVariants, 0), averageSellingPrice: round(average(products.map((product) => product.sellingPrice)), 0), averageDiscount: round(average(products.map((product) => product.discountPercent))), campaignCount: campaigns.length, totalReviews: reviewAccounting.uniqueReviews, averageRating: reviewAccounting.averageRating, averageReviewsPerProduct: round(reviewAccounting.activeCatalogueReviews / Math.max(rated.length, 1), 0), ratedProducts: rated.length },
      categories, campaigns, events, reviewAccounting,
      health: { status: products.length > 0 && pageSuccessCount / products.length >= 0.9 ? "Healthy" : "Partial", catalogueComplete: products.length > 0, pricedProducts: products.filter((product) => product.sellingPrice > 0).length, detailPagesChecked: pageSuccessCount, detailPagesFailed: pageFailureCount },
      refresh: { allowed: false, scansToday: 1, limitPerDay: 1, nextAvailableAt: nextRefresh.toISOString() },
    };
    await Promise.all([writeFile(path.join(publicDataDir, "starkidz-summary.json"), JSON.stringify(summary, null, 2)), writeFile(path.join(publicDataDir, "starkidz-products.json"), JSON.stringify({ source: summary.source, generatedAt: observedAt, products }, null, 2))]);
    db.prepare("UPDATE scan_runs SET completed_at=?,status='completed',product_count=?,page_success_count=?,page_failure_count=? WHERE id=?").run(observedAt, products.length, pageSuccessCount, pageFailureCount, runId);
    db.exec("PRAGMA optimize"); db.close();
    onProgress({ phase: "complete", current: products.length, total: products.length, message: "Starkidz refresh completed" });
    return summary;
  } catch (error) {
    db.prepare("UPDATE scan_runs SET completed_at=?,status='failed',error_message=? WHERE id=?").run(new Date().toISOString(), String(error.message || error), runId); db.close(); throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runStarkidzCollection({ force: process.argv.includes("--force"), onProgress: ({ phase, current, total, message }) => { if (phase !== "reviews" || current === 1 || current % 20 === 0 || current === total) console.log(message); } })
    .then((summary) => console.log(`Saved ${summary.metrics.activeListings} Starkidz products and ${summary.metrics.variantCount} variants.`))
    .catch((error) => { console.error(error.message); process.exitCode = 1; });
}
