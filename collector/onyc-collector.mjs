import { DatabaseSync } from "node:sqlite";
import { mkdir, writeFile } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = path.join(projectDir, "data");
const publicDataDir = path.join(projectDir, "public", "data");
const databasePath = path.join(dataDir, "market-pulse.sqlite");

const BASE_URL = "https://onyc.in";
const CATALOG_URL = `${BASE_URL}/products.json?limit=250`;
const USER_AGENT = "Starkidz Competitor Intelligence/1.0 (internal catalogue monitor; low-frequency)";
const EXPECTED_PRODUCT_TYPES = ["Shoes", "Sandals", "Sliders", "Flip-Flops"];
const AGE_BANDS = [
  { key: "infants", label: "Infants · 9–18m", min: 9, max: 18 },
  { key: "toddlers", label: "Toddlers · 18–36m", min: 18, max: 36 },
  { key: "early-years", label: "Early years · 3–5y", min: 36, max: 60 },
  { key: "growing-kids", label: "Growing kids · 5–9y", min: 60, max: 108 },
];

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const round = (value, digits = 1) => Number(Number(value || 0).toFixed(digits));
const average = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
const stripHtml = (value = "") => value.replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();

async function fetchText(url, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { "user-agent": USER_AGENT, accept: "text/html,application/json" },
        signal: AbortSignal.timeout(30_000),
      });
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
  const db = new DatabaseSync(databasePath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS scan_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      status TEXT NOT NULL,
      product_count INTEGER DEFAULT 0,
      page_success_count INTEGER DEFAULT 0,
      page_failure_count INTEGER DEFAULT 0,
      error_message TEXT
    );
    CREATE TABLE IF NOT EXISTS products (
      product_id TEXT PRIMARY KEY,
      brand TEXT NOT NULL,
      title TEXT NOT NULL,
      handle TEXT NOT NULL,
      canonical_url TEXT NOT NULL,
      product_type TEXT,
      gender TEXT,
      age_band_keys TEXT,
      tags TEXT,
      image_url TEXT,
      published_at TEXT,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS variants (
      variant_id TEXT PRIMARY KEY,
      product_id TEXT NOT NULL,
      sku TEXT,
      title TEXT,
      size TEXT,
      selling_price REAL,
      mrp REAL,
      available INTEGER NOT NULL,
      last_seen_at TEXT NOT NULL,
      FOREIGN KEY(product_id) REFERENCES products(product_id)
    );
    CREATE TABLE IF NOT EXISTS product_observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL,
      product_id TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      selling_price REAL,
      mrp REAL,
      discount_percent REAL,
      available_variants INTEGER,
      total_variants INTEGER,
      rating REAL,
      review_count INTEGER,
      FOREIGN KEY(run_id) REFERENCES scan_runs(id),
      FOREIGN KEY(product_id) REFERENCES products(product_id)
    );
    CREATE TABLE IF NOT EXISTS variant_observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL,
      variant_id TEXT NOT NULL,
      product_id TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      selling_price REAL,
      mrp REAL,
      available INTEGER NOT NULL,
      FOREIGN KEY(run_id) REFERENCES scan_runs(id)
    );
    CREATE TABLE IF NOT EXISTS campaigns (
      campaign_key TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      detail TEXT,
      discount_text TEXT,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL,
      occurred_at TEXT NOT NULL,
      event_type TEXT NOT NULL,
      severity TEXT NOT NULL,
      product_id TEXT,
      variant_id TEXT,
      title TEXT NOT NULL,
      detail TEXT,
      previous_value REAL,
      current_value REAL,
      FOREIGN KEY(run_id) REFERENCES scan_runs(id)
    );
    CREATE INDEX IF NOT EXISTS idx_product_observations_product ON product_observations(product_id, observed_at);
    CREATE INDEX IF NOT EXISTS idx_variant_observations_variant ON variant_observations(variant_id, observed_at);
    CREATE INDEX IF NOT EXISTS idx_events_run ON events(run_id);
  `);
  return db;
}

function classifyGender(product) {
  const title = product.title.toLowerCase();
  const tags = product.tags.map((tag) => String(tag).toLowerCase());
  if (/\bunisex\b/.test(title) || tags.some((tag) => tag.includes("unisex"))) return "Unisex";
  if (/\bgirls?\b/.test(title) || tags.some((tag) => /\bgirls?\b/.test(tag))) return "Girls";
  if (/\bboys?\b/.test(title) || tags.some((tag) => /\bboys?\b/.test(tag))) return "Boys";
  return "Unspecified";
}

function sizeToMonths(value) {
  const text = String(value).toLowerCase();
  const matches = [...text.matchAll(/(\d+(?:\.\d+)?)\s*(months?|mos?|m|years?|yrs?|y)/g)];
  return matches.map((match) => Number(match[1]) * (match[2].startsWith("y") ? 12 : 1));
}

function classifyAgeBands(product) {
  const sizeOption = product.options.find((option) => option.name.toLowerCase() === "size");
  const monthValues = (sizeOption?.values || []).flatMap(sizeToMonths);
  if (!monthValues.length) return [];
  const minimum = Math.min(...monthValues);
  const maximum = Math.max(...monthValues);
  return AGE_BANDS.filter((band) => maximum >= band.min && minimum <= band.max).map((band) => band.key);
}

function extractReviews(html) {
  const matches = [...html.matchAll(/data-average-rating=['"]([\d.]+)['"][^>]*data-number-of-reviews=['"](\d+)['"]/gi)]
    .map((match) => ({ rating: Number(match[1]), reviewCount: Number(match[2]) }));
  return matches.sort((a, b) => b.reviewCount - a.reviewCount)[0] || { rating: 0, reviewCount: 0 };
}

function normaliseProduct(product) {
  const variants = product.variants.map((variant) => ({
    id: String(variant.id),
    sku: variant.sku || "",
    title: variant.title || "",
    size: variant.option1 || "",
    sellingPrice: Number(variant.price || 0),
    mrp: Number(variant.compare_at_price || variant.price || 0),
    available: Boolean(variant.available),
  }));
  const availableVariants = variants.filter((variant) => variant.available && variant.sellingPrice > 0);
  const representative = [...(availableVariants.length ? availableVariants : variants)]
    .filter((variant) => variant.sellingPrice > 0)
    .sort((a, b) => a.sellingPrice - b.sellingPrice)[0];
  const sellingPrice = representative?.sellingPrice || 0;
  const mrp = representative?.mrp || sellingPrice;
  return {
    id: String(product.id),
    title: product.title,
    handle: product.handle,
    url: `${BASE_URL}/products/${product.handle}`,
    productType: product.product_type || "Unspecified",
    gender: classifyGender(product),
    ageBandKeys: classifyAgeBands(product),
    tags: product.tags.map(String),
    description: stripHtml(product.body_html),
    imageUrl: product.images?.[0]?.src || "",
    publishedAt: product.published_at,
    variants,
    sellingPrice,
    mrp,
    discountPercent: mrp > sellingPrice ? round(((mrp - sellingPrice) / mrp) * 100) : 0,
    availableVariants: variants.filter((variant) => variant.available).length,
    totalVariants: variants.length,
    rating: 0,
    reviewCount: 0,
    detailPageChecked: false,
  };
}

function decodePublicSettings(html) {
  const decoded = [];
  for (const match of html.matchAll(/b64DecodeUnicode\(["']([A-Za-z0-9+/=]+)["']\)/g)) {
    try {
      decoded.push(Buffer.from(match[1], "base64").toString("utf8"));
    } catch {
      // A malformed public setting should not prevent the remaining page from being inspected.
    }
  }
  return decoded.join(" ");
}

export function extractCampaigns(html, observedAt) {
  const plain = stripHtml(html);
  const decodedSettings = stripHtml(decodePublicSettings(html));
  const searchable = `${plain} ${decodedSettings}`;
  const campaigns = [];
  const firstOrder = searchable.match(/(\d+)%\s*(?:extra\s*)?off[^.]{0,100}?first\s+order/i)
    || searchable.match(/first\s+order[^.]{0,100}?(\d+)%\s*(?:extra\s*)?off/i);
  if (firstOrder) {
    const code = searchable.match(/\bONYC[A-Z0-9]+\b/i)?.[0]?.toUpperCase();
    campaigns.push({
      key: "first-order",
      title: "First-order offer",
      detail: code ? `Use ${code} on the first order.` : "Discount promoted on a customer’s first order.",
      discountText: `${firstOrder[1]}% extra off`,
      type: "Coupon",
      sourceSurface: "Announcement bar",
      observedAt,
    });
  }
  const tierMatches = [...searchable.matchAll(/buy\s*(\d+)\s*(?:and|&)?\s*(?:get)?[^%]{0,50}?(\d+)%\s*off/gi)];
  const uniqueTiers = [...new Map(tierMatches.map((match) => [`${match[1]}:${match[2]}`, { quantity: Number(match[1]), discount: Number(match[2]) }])).values()]
    .sort((a, b) => a.quantity - b.quantity);
  if (uniqueTiers.length) {
    campaigns.push({
      key: "multi-buy",
      title: "Multi-buy offer",
      detail: uniqueTiers.map((tier) => `Buy ${tier.quantity} · ${tier.discount}% extra off`).join("; "),
      discountText: uniqueTiers.map((tier) => `${tier.discount}%`).join(" / "),
      type: "Multi-buy",
      sourceSurface: decodedSettings ? "Cart drawer widget" : "Website text",
      observedAt,
    });
  }
  if (/free\s+(?:prepaid\s+)?delivery/i.test(searchable)) {
    campaigns.push({ key: "free-delivery", title: "Free prepaid delivery", detail: "Free delivery is promoted for prepaid orders.", discountText: "Service benefit", type: "Shipping benefit", sourceSurface: "Announcement bar", observedAt });
  }
  return campaigns;
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let index = 0;
  async function worker() {
    while (index < items.length) {
      const current = index;
      index += 1;
      results[current] = await mapper(items[current], current);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}

function categoryAggregate(products, definitions, predicate) {
  return definitions.map((definition) => {
    const matching = products.filter((product) => predicate(product, definition));
    const rated = matching.filter((product) => product.reviewCount > 0);
    return {
      key: definition.key,
      label: definition.label,
      productCount: matching.length,
      averageSellingPrice: round(average(matching.map((product) => product.sellingPrice)), 0),
      averageDiscount: round(average(matching.map((product) => product.discountPercent))),
      totalReviews: matching.reduce((sum, product) => sum + product.reviewCount, 0),
      averageRating: round(average(rated.map((product) => product.rating)), 2),
    };
  });
}

function buildCategoryViews(products) {
  const types = EXPECTED_PRODUCT_TYPES.map((label) => ({ key: label.toLowerCase().replaceAll(" ", "-"), label }));
  const genders = ["Unisex", "Girls", "Boys", "Unspecified"].map((label) => ({ key: label.toLowerCase(), label }));
  return {
    type: categoryAggregate(products, types, (product, item) => product.productType === item.label),
    gender: categoryAggregate(products, genders, (product, item) => product.gender === item.label),
    age: categoryAggregate(products, AGE_BANDS, (product, item) => product.ageBandKeys.includes(item.key)),
  };
}

function getTodayBounds() {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { start: start.toISOString(), end: end.toISOString() };
}

export function getRefreshAllowance() {
  mkdirSync(dataDir, { recursive: true });
  const db = initialiseDatabase();
  const { start, end } = getTodayBounds();
  const row = db.prepare("SELECT COUNT(*) AS count FROM scan_runs WHERE source = ? AND status = 'completed' AND completed_at >= ? AND completed_at < ?").get("onyc", start, end);
  db.close();
  return { allowed: Number(row.count) < 1, scansToday: Number(row.count), limitPerDay: 1, nextAvailableAt: end };
}

function priceSeverity(previous, current) {
  if (!previous || previous === current) return null;
  const absolute = Math.abs(current - previous);
  const percentage = (absolute / previous) * 100;
  if (absolute >= 100 || percentage >= 10) return "major";
  if (absolute >= 25 || percentage >= 3) return "normal";
  return null;
}

function persistRun(db, runId, observedAt, products, campaigns) {
  const productUpsert = db.prepare(`
    INSERT INTO products (product_id, brand, title, handle, canonical_url, product_type, gender, age_band_keys, tags, image_url, published_at, first_seen_at, last_seen_at, active)
    VALUES (?, 'ONYC', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    ON CONFLICT(product_id) DO UPDATE SET title=excluded.title, handle=excluded.handle, canonical_url=excluded.canonical_url,
      product_type=excluded.product_type, gender=excluded.gender, age_band_keys=excluded.age_band_keys, tags=excluded.tags,
      image_url=excluded.image_url, published_at=excluded.published_at, last_seen_at=excluded.last_seen_at, active=1
  `);
  const variantUpsert = db.prepare(`
    INSERT INTO variants (variant_id, product_id, sku, title, size, selling_price, mrp, available, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(variant_id) DO UPDATE SET product_id=excluded.product_id, sku=excluded.sku, title=excluded.title,
      size=excluded.size, selling_price=excluded.selling_price, mrp=excluded.mrp, available=excluded.available, last_seen_at=excluded.last_seen_at
  `);
  const productObservation = db.prepare(`INSERT INTO product_observations
    (run_id, product_id, observed_at, selling_price, mrp, discount_percent, available_variants, total_variants, rating, review_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const variantObservation = db.prepare(`INSERT INTO variant_observations
    (run_id, variant_id, product_id, observed_at, selling_price, mrp, available) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const eventInsert = db.prepare(`INSERT INTO events
    (run_id, occurred_at, event_type, severity, product_id, variant_id, title, detail, previous_value, current_value)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const campaignUpsert = db.prepare(`
    INSERT INTO campaigns (campaign_key, title, detail, discount_text, first_seen_at, last_seen_at, active)
    VALUES (?, ?, ?, ?, ?, ?, 1)
    ON CONFLICT(campaign_key) DO UPDATE SET title=excluded.title, detail=excluded.detail, discount_text=excluded.discount_text,
      last_seen_at=excluded.last_seen_at, active=1
  `);
  const knownProducts = new Map(db.prepare("SELECT product_id, active FROM products WHERE brand='ONYC'").all().map((row) => [row.product_id, row]));
  const currentProductIds = new Set(products.map((product) => product.id));
  const knownCampaigns = new Map(db.prepare("SELECT campaign_key, active FROM campaigns WHERE campaign_key NOT LIKE '%:%'").all().map((row) => [row.campaign_key, row]));
  const currentCampaignKeys = new Set(campaigns.map((campaign) => campaign.key));

  db.exec("BEGIN");
  try {
    for (const product of products) {
      const previousProduct = knownProducts.get(product.id);
      const wasKnown = Boolean(previousProduct);
      product.status = !wasKnown ? "new" : previousProduct.active ? "existing" : "restored";
      productUpsert.run(product.id, product.title, product.handle, product.url, product.productType, product.gender,
        JSON.stringify(product.ageBandKeys), JSON.stringify(product.tags), product.imageUrl, product.publishedAt, observedAt, observedAt);
      if (!wasKnown) eventInsert.run(runId, observedAt, "product_added", "normal", product.id, null, `New product: ${product.title}`, product.productType, null, null);
      else if (!previousProduct.active) eventInsert.run(runId, observedAt, "product_restored", "normal", product.id, null, `Product restored: ${product.title}`, product.productType, null, null);
      productObservation.run(runId, product.id, observedAt, product.sellingPrice, product.mrp, product.discountPercent,
        product.availableVariants, product.totalVariants, product.rating, product.reviewCount);
      for (const variant of product.variants) {
        const previous = db.prepare("SELECT selling_price FROM variant_observations WHERE variant_id = ? ORDER BY observed_at DESC LIMIT 1").get(variant.id);
        variantUpsert.run(variant.id, product.id, variant.sku, variant.title, variant.size, variant.sellingPrice, variant.mrp, variant.available ? 1 : 0, observedAt);
        variantObservation.run(runId, variant.id, product.id, observedAt, variant.sellingPrice, variant.mrp, variant.available ? 1 : 0);
        const severity = previous ? priceSeverity(Number(previous.selling_price), variant.sellingPrice) : null;
        if (severity) eventInsert.run(runId, observedAt, "price_changed", severity, product.id, variant.id,
          `Price changed: ${product.title} · ${variant.size}`, `₹${previous.selling_price} → ₹${variant.sellingPrice}`,
          Number(previous.selling_price), variant.sellingPrice);
      }
    }
    for (const [productId, row] of knownProducts) {
      if (row.active && !currentProductIds.has(productId)) {
        db.prepare("UPDATE products SET active = 0 WHERE product_id = ?").run(productId);
        eventInsert.run(runId, observedAt, "possibly_removed", "normal", productId, null, "Possibly removed product", "Missing from this successful catalogue scan; targeted recheck is required.", null, null);
      }
    }
    db.prepare("UPDATE campaigns SET active = 0 WHERE campaign_key NOT LIKE '%:%'").run();
    for (const campaign of campaigns) {
      campaignUpsert.run(campaign.key, campaign.title, campaign.detail, campaign.discountText, observedAt, observedAt);
      if (!knownCampaigns.has(campaign.key)) eventInsert.run(runId, observedAt, "campaign_added", "normal", null, null, `New campaign: ${campaign.title}`, campaign.detail, null, null);
    }
    for (const [campaignKey, row] of knownCampaigns) {
      if (row.active && !currentCampaignKeys.has(campaignKey)) eventInsert.run(runId, observedAt, "campaign_removed", "normal", null, null, `Campaign ended: ${campaignKey}`, "Not found in the latest successful homepage scan.", null, null);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function readEvents(db, runId) {
  return db.prepare("SELECT event_type AS type, severity, title, detail, product_id AS productId, variant_id AS variantId, previous_value AS previousValue, current_value AS currentValue, occurred_at AS occurredAt FROM events WHERE run_id = ? ORDER BY id DESC").all(runId);
}

export async function runOnycCollection({ force = false, onProgress = () => {} } = {}) {
  await Promise.all([mkdir(dataDir, { recursive: true }), mkdir(publicDataDir, { recursive: true })]);
  const allowance = getRefreshAllowance();
  if (!force && !allowance.allowed) {
    const error = new Error("The one-full-refresh-per-day limit has already been used.");
    error.code = "DAILY_LIMIT";
    error.allowance = allowance;
    throw error;
  }
  const db = initialiseDatabase();
  const startedAt = new Date().toISOString();
  const run = db.prepare("INSERT INTO scan_runs (source, started_at, status) VALUES ('onyc', ?, 'running')").run(startedAt);
  const runId = Number(run.lastInsertRowid);
  try {
    onProgress({ phase: "catalogue", current: 0, total: 0, message: "Reading the ONYC catalogue" });
    const catalogText = await fetchText(CATALOG_URL);
    const catalogue = JSON.parse(catalogText);
    const products = catalogue.products.map(normaliseProduct);
    let pageSuccessCount = 0;
    let pageFailureCount = 0;
    await mapWithConcurrency(products, 2, async (product, index) => {
      try {
        const html = await fetchText(product.url, 2);
        Object.assign(product, extractReviews(html), { detailPageChecked: true });
        pageSuccessCount += 1;
      } catch {
        pageFailureCount += 1;
      }
      onProgress({ phase: "reviews", current: index + 1, total: products.length, message: `Checking reviews ${index + 1}/${products.length}` });
      await wait(350);
    });
    onProgress({ phase: "campaigns", current: 0, total: 1, message: "Checking current campaigns" });
    let homepageHtml = "";
    try { homepageHtml = await fetchText(BASE_URL, 2); } catch { /* campaigns can fail independently */ }
    const observedAt = new Date().toISOString();
    const campaigns = extractCampaigns(homepageHtml, observedAt);
    persistRun(db, runId, observedAt, products, campaigns);
    const ratedProducts = products.filter((product) => product.reviewCount > 0);
    const variantCount = products.reduce((sum, product) => sum + product.totalVariants, 0);
    const categories = buildCategoryViews(products);
    const isBaseline = db.prepare("SELECT COUNT(*) AS count FROM scan_runs WHERE source='onyc' AND status='completed'").get().count === 0;
    const events = isBaseline ? [] : readEvents(db, runId);
    const nextRefresh = new Date();
    nextRefresh.setDate(nextRefresh.getDate() + 1);
    nextRefresh.setHours(0, 0, 0, 0);
    const summary = {
      source: { id: "onyc", brand: "ONYC", url: BASE_URL, mode: "Public website" },
      generatedAt: observedAt,
      isBaseline,
      metrics: {
        activeListings: products.length,
        variantCount,
        averageSellingPrice: round(average(products.map((product) => product.sellingPrice)), 0),
        averageDiscount: round(average(products.map((product) => product.discountPercent))),
        campaignCount: campaigns.length,
        totalReviews: products.reduce((sum, product) => sum + product.reviewCount, 0),
        averageRating: round(average(ratedProducts.map((product) => product.rating)), 2),
        averageReviewsPerProduct: round(average(ratedProducts.map((product) => product.reviewCount)), 0),
        ratedProducts: ratedProducts.length,
      },
      categories,
      campaigns,
      campaignHealth: {
        status: /upcart-bundle\.js/i.test(homepageHtml) && !/"tiers"/i.test(decodePublicSettings(homepageHtml)) ? "Needs review" : "Healthy",
        inspectedSurfaces: ["Homepage text", "Announcement bar", "Public cart-widget settings"],
      },
      events,
      health: {
        status: products.length > 0 && pageSuccessCount / products.length >= 0.9 ? "Healthy" : "Partial",
        catalogueComplete: products.length > 0,
        pricedProducts: products.filter((product) => product.sellingPrice > 0).length,
        detailPagesChecked: pageSuccessCount,
        detailPagesFailed: pageFailureCount,
      },
      refresh: { allowed: false, scansToday: 1, limitPerDay: 1, nextAvailableAt: nextRefresh.toISOString() },
    };
    const productExport = {
      source: summary.source,
      generatedAt: observedAt,
      products: products.map(({ detailPageChecked, ...product }) => ({ ...product, detailPageChecked })),
    };
    await Promise.all([
      writeFile(path.join(publicDataDir, "onyc-summary.json"), JSON.stringify(summary, null, 2)),
      writeFile(path.join(publicDataDir, "onyc-products.json"), JSON.stringify(productExport, null, 2)),
    ]);
    db.prepare("UPDATE scan_runs SET completed_at=?, status='completed', product_count=?, page_success_count=?, page_failure_count=? WHERE id=?")
      .run(observedAt, products.length, pageSuccessCount, pageFailureCount, runId);
    db.exec("PRAGMA optimize");
    db.close();
    onProgress({ phase: "complete", current: products.length, total: products.length, message: "ONYC refresh completed" });
    return summary;
  } catch (error) {
    db.prepare("UPDATE scan_runs SET completed_at=?, status='failed', error_message=? WHERE id=?").run(new Date().toISOString(), String(error.message || error), runId);
    db.close();
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runOnycCollection({
    force: process.argv.includes("--force"),
    onProgress: ({ phase, current, total, message }) => {
      if (phase !== "reviews" || current === 1 || current % 20 === 0 || current === total) console.log(message);
    },
  }).then((summary) => {
    console.log(`Saved ${summary.metrics.activeListings} products and ${summary.metrics.variantCount} variants.`);
  }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
