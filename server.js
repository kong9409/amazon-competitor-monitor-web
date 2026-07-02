import express from 'express';
import path from 'path';
import fs from 'fs/promises';
import fssync from 'fs';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { createHash } from 'crypto';
import { nanoid } from 'nanoid';
import archiver from 'archiver';
import { stringify } from 'csv-stringify/sync';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const PORT = process.env.PORT || 3000;
const DATA_ROOT = process.env.AMAZON_MONITOR_DATA_DIR
  ? path.resolve(process.env.AMAZON_MONITOR_DATA_DIR)
  : process.platform === 'win32'
    ? path.resolve('D:/amazon-competitor-monitor-web-data')
    : path.resolve('/tmp/amazon-competitor-monitor-web-data');
const REPORT_ROOT = process.env.REPORT_ROOT
  ? path.resolve(process.env.REPORT_ROOT)
  : path.join(DATA_ROOT, 'reports');

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/reports', express.static(REPORT_ROOT));

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const ensuredProfiles = new Set();
const today = () => new Date().toISOString().slice(0, 10);
const nowIso = () => new Date().toISOString();
const safeAsin = (s) => String(s || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
const splitLines = (text) => String(text || '').split(/[\n,，\s]+/).map(safeAsin).filter(Boolean);
const splitKeywords = (text) => String(text || '').split(/[\n,，]+/).map(s => s.trim()).filter(Boolean);

function localSorftimeBin() {
  const pathDirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const jsCandidates = [
    path.join(__dirname, 'node_modules', 'sorftime-cli', 'dist', 'index.js'),
    ...pathDirs.map(dir => path.join(dir, 'node_modules', 'sorftime-cli', 'dist', 'index.js'))
  ];
  const cliEntry = jsCandidates.find(p => fssync.existsSync(p));
  if (cliEntry) return cliEntry;
  const ext = process.platform === 'win32' ? '.cmd' : '';
  const binCandidates = [
    path.join(__dirname, 'node_modules', '.bin', `sorftime${ext}`),
    ...pathDirs.map(dir => path.join(dir, `sorftime${ext}`))
  ];
  const candidate = binCandidates.find(p => fssync.existsSync(p));
  if (candidate) return candidate;
  return process.env.SORFTIME_BIN || 'sorftime';
}

function mask(v) {
  if (!v) return '';
  const s = String(v);
  if (s.length <= 8) return '****';
  return `${s.slice(0, 4)}****${s.slice(-4)}`;
}

function profileNameForToken(token) {
  const hash = createHash('sha256').update(String(token || '')).digest('hex').slice(0, 12);
  return `web_${hash}`;
}

function sorftimeEnv(token) {
  const env = { ...process.env };
  const home = DATA_ROOT;
  env.HOME = home;
  env.USERPROFILE = home;
  env.APPDATA = home;
  if (token) {
    env.SORFTIME_CLI_TOKEN = token;
    env.SORFTIME_TOKEN = token;
    env.SORFTIME_API_KEY = token;
  }
  return env;
}

function keyName(s) {
  return String(s || '').toLowerCase().replace(/[ _-]/g, '');
}

function isFilled(v) {
  return v !== null && v !== undefined && !(typeof v === 'string' && v.trim() === '') && !(Array.isArray(v) && v.length === 0);
}

function unwrapData(raw) {
  if (!raw || typeof raw !== 'object') return raw;
  return raw.data ?? raw.Data ?? raw;
}

function findAny(obj, names, { scalarOnly = true, fuzzy = false } = {}) {
  for (const want of names.map(keyName)) {
    const stack = [obj];
    const seen = new Set();
    while (stack.length) {
      const cur = stack.shift();
      if (!cur || typeof cur !== 'object' || seen.has(cur)) continue;
      seen.add(cur);
      if (Array.isArray(cur)) {
        for (const item of cur) stack.push(item);
        continue;
      }
      for (const [k, v] of Object.entries(cur)) {
        const nk = keyName(k);
        if ((nk === want || (fuzzy && nk.includes(want))) && isFilled(v) && (!scalarOnly || typeof v !== 'object')) return v;
      }
      for (const v of Object.values(cur)) if (v && typeof v === 'object') stack.push(v);
    }
  }
  return null;
}

function findVal(obj, names) {
  return findAny(obj, names, { scalarOnly: true }) ?? findAny(obj, names, { scalarOnly: true, fuzzy: true });
}

function firstArray(obj, preferred = []) {
  const root = unwrapData(obj);
  if (Array.isArray(root)) return root;
  if (!root || typeof root !== 'object') return [];
  for (const key of preferred) {
    const v = findAny(root, [key], { scalarOnly: false });
    if (Array.isArray(v)) return v;
  }
  const stack = [root];
  const seen = new Set();
  while (stack.length) {
    const cur = stack.shift();
    if (!cur || typeof cur !== 'object' || seen.has(cur)) continue;
    seen.add(cur);
    if (Array.isArray(cur) && cur.length && typeof cur[0] === 'object') return cur;
    for (const v of Object.values(cur)) if (v && typeof v === 'object') stack.push(v);
  }
  return [];
}

function num(v) {
  if (v === null || v === undefined) return null;
  const n = Number(String(v).replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function priceNum(v) {
  const n = num(v);
  if (n === null) return null;
  const text = String(v ?? '').trim();
  const hasDecimal = /[.,]\d{1,2}\b/.test(text);
  const looksLikeCents = Number.isInteger(n) && n >= 100 && !hasDecimal && /^[0-9]+$/.test(text);
  return looksLikeCents ? Number((n / 100).toFixed(2)) : n;
}

function boolFlag(v) {
  if (v === true) return true;
  if (v === false || v === null || v === undefined || v === '') return false;
  const text = String(v).trim().toLowerCase();
  return ['1', 'true', 'yes', 'y', '是', '有'].includes(text);
}

function cleanText(v, max = 240) {
  if (v === null || v === undefined) return '';
  return String(v).replace(/\s+/g, ' ').trim().slice(0, max);
}

function stripAnsi(text) {
  return String(text || '').replace(/\x1b\[[0-9;]*m/g, '');
}

function responseCode(data) {
  const code = data && typeof data === 'object' ? (data.code ?? data.Code) : undefined;
  return code === undefined || code === null || code === '' ? null : Number(code);
}

function responseMetric(data, names) {
  const value = data && typeof data === 'object' ? findVal(data, names) : undefined;
  return value === undefined || value === null || value === '' ? null : num(value);
}

function responseMessage(data) {
  if (!data || typeof data !== 'object') return '';
  return cleanText(data.message ?? data.Message ?? data.error ?? data.raw_text ?? '', 500);
}

function auditError(a) {
  return cleanText(a.error || a.stderr || a.stdout || '', 500);
}

function auditRecord(res, interfaceName, params, domain) {
  return {
    timestamp: res.started_at || nowIso(),
    ended_at: res.ended_at || '',
    interface: interfaceName,
    params,
    domain,
    command_preview: res.command_preview,
    exit_code: res.exit_code,
    api_code: res.api_code,
    request_consumed: res.request_consumed,
    request_left: res.request_left,
    request_count: res.request_count,
    duration_ms: res.duration_ms,
    ok: res.ok,
    error: res.error,
    stderr: cleanText(res.stderr, 500),
    stdout: cleanText(res.stdout, 500)
  };
}

function firstProduct(raw, asin) {
  const data = unwrapData(raw);
  const target = String(asin || '').toUpperCase();
  if (Array.isArray(data)) {
    return data.find(item => String(findVal(item, ['asin', 'Asin']) || '').toUpperCase() === target) || data[0] || {};
  }
  if (data && typeof data === 'object') {
    for (const [key, value] of Object.entries(data)) {
      if (String(key).toUpperCase() === target && value && typeof value === 'object') return value;
    }
  }
  const stack = [data];
  const seen = new Set();
  while (stack.length) {
    const cur = stack.shift();
    if (!cur || typeof cur !== 'object' || seen.has(cur)) continue;
    seen.add(cur);
    if (String(findVal(cur, ['asin', 'Asin']) || '').toUpperCase() === target) return cur;
    for (const v of Object.values(cur)) if (v && typeof v === 'object') stack.push(v);
  }
  return data || {};
}

function stringifyShort(v, max = 120) {
  if (!isFilled(v)) return '';
  if (typeof v === 'object') return cleanText(JSON.stringify(v), max);
  return cleanText(v, max);
}

function couponText(v) {
  const text = stringifyShort(v, 80);
  if (!text || text === '0' || /^false$/i.test(text) || /^null$/i.test(text)) return '';
  return text;
}

function promotionText(product) {
  const promo = findAny(product, [
    'coupon', 'Coupon', 'couponText', 'couponValue', 'DealType', 'ExtraSavings',
    'primeDiscount', 'PrimeDiscount', 'primeExclusiveDiscount', 'PrimeExclusiveDiscount',
    'promotion', 'Promotion', 'promotionText', 'PromotionText', 'promo', 'Promo',
    'brandPromotion', 'BrandPromotion', 'code', 'Code', 'promoCode', 'PromoCode',
    'dealBadge', 'DealBadge', 'savingBasis', 'SavingBasis'
  ], { scalarOnly: false });
  return couponText(promo);
}

function promotionPrice(product) {
  const value = findVal(product, [
    'couponPrice', 'CouponPrice', 'couponAfterPrice', 'CouponAfterPrice',
    'finalPrice', 'FinalPrice', 'discountPrice', 'DiscountPrice',
    'primePrice', 'PrimePrice', 'primeExclusivePrice', 'PrimeExclusivePrice',
    'promotionPrice', 'PromotionPrice', 'codePrice', 'CodePrice',
    'dealPrice', 'DealPrice', 'lightningDealPrice', 'LightningDealPrice'
  ]);
  return priceNum(value);
}

function firstPhoto(obj) {
  const image = findVal(obj, ['image', 'mainImage', 'imageUrl', 'imgUrl']);
  if (image) return image;
  const photo = findAny(obj, ['photo', 'Photo', 'images', 'Images'], { scalarOnly: false });
  return Array.isArray(photo) ? photo[0] : photo;
}

function extractBsr(obj) {
  const bsr = findAny(obj, ['bsrCategory', 'BsrCategory'], { scalarOnly: false });
  if (Array.isArray(bsr)) {
    const rows = Array.isArray(bsr[0]) || typeof bsr[0] === 'object' ? bsr : [bsr];
    const ranks = rows.map(row => num(row?.[2] ?? row?.rank ?? row?.Rank ?? row?.salesRank ?? row?.SalesRank)).filter(v => v !== null);
    if (ranks.length) return ranks[0];
  }
  const direct = num(findVal(obj, ['smallCategoryRank', 'SmallCategoryRank', 'bsr', 'rank', 'Rank', 'salesRank', 'SalesRank', 'bestSellerRank']));
  if (direct !== null) return direct;
  return null;
}

function productRating(obj) {
  const star = num(findVal(obj, ['ratings', 'star', 'Star', 'rating', 'Rating', 'reviewRating', 'averageRating', 'AverageRating', 'score', 'Score']));
  if (star !== null && star <= 5) return Number(star.toFixed(1));
  return null;
}

function productReviewCount(obj) {
  const count = num(findVal(obj, ['ratingsCount', 'RatingsCount', 'reviewCount', 'ReviewCount', 'reviewsCount', 'ReviewsCount', 'commentCount', 'ratingsTotal', 'review_count']));
  if (count !== null) return count;
  const ratings = num(findAny(obj, ['Ratings'], { scalarOnly: true }));
  return ratings !== null && ratings > 5 ? ratings : null;
}

function latestMonthlySales(raw) {
  const direct = responseMetric(raw, [
    'ListingSalesVolumeOfMonth', 'listingSalesVolumeOfMonth',
    'ListingSalesVolume', 'listingSalesVolume',
    'monthlySales', 'MonthlySales', 'monthSales', 'MonthSales',
    'estimatedMonthlySales', 'EstimatedMonthlySales',
    'salesVolumeOfMonth', 'SalesVolumeOfMonth', 'salesVolume30', 'SalesVolume30',
    'AsinSalesCount'
  ]);
  if (direct !== null) return direct;
  const rows = firstArray(raw, ['data', 'Data', 'records', 'Records', 'sales', 'Sales', 'list', 'List']);
  const monthly = rows
    .filter(r => Array.isArray(r) && num(r[1]) !== null && (num(r[2]) === 2 || String(r[2] || '').includes('月') || String(r[2] || '').toLowerCase().includes('month')))
    .sort((a, b) => String(b[0]).localeCompare(String(a[0])));
  if (monthly.length) return num(monthly[0][1]);
  const numericRows = rows.filter(r => Array.isArray(r) && num(r[1]) !== null).sort((a, b) => String(b[0]).localeCompare(String(a[0])));
  return numericRows.length ? num(numericRows[0][1]) : null;
}

function parentAsinFromRaw(raw, asin) {
  const product = firstProduct(raw, asin);
  return safeAsin(findVal(product, ['parentAsin', 'ParentAsin', 'ParentASIN', 'parentASIN', 'Parent', 'parent']));
}

function productParams(interfaceName, asin) {
  if (/^ProductRequest$/i.test(interfaceName)) return { asin, trend: 1 };
  return { asin };
}

function productBatchParams(interfaceName, asins) {
  if (/^ProductRequest$/i.test(interfaceName)) return { asin: asins.join(','), trend: 1 };
  return null;
}

function keywordParams(interfaceName, asin, keyword, marketplace) {
  if (/^ASINKeywordRanking$/i.test(interfaceName)) return { keyword, ASIN: asin };
  if (/^KeywordRequest$/i.test(interfaceName)) return { keyword };
  if (/^ASINRequestKeyword/i.test(interfaceName)) return { asin, pageIndex: 1, pageSize: 50 };
  return { asin, keyword, site: marketplace };
}

function keywordMetricParams(interfaceName, keyword) {
  if (/^KeywordRequest$/i.test(interfaceName)) return { keyword };
  if (/^KeywordQuery$/i.test(interfaceName)) return { pattern: { keyword }, pageIndex: 1, pageSize: 20 };
  if (/^KeywordExtends$/i.test(interfaceName)) return { keyword, pageSize: 100 };
  return { keyword };
}

function asinKeywordParams(interfaceName, asin) {
  if (/^ASINRequestKeyword/i.test(interfaceName)) return { asin, pageIndex: 1, pageSize: 200 };
  return { asin, pageIndex: 1, pageSize: 200 };
}

function salesParams(interfaceName, asin) {
  return { asin };
}

function reviewParams(interfaceName, asin) {
  if (/^ProductReviewsQuery$/i.test(interfaceName)) return { asin, pageIndex: 1 };
  if (/^ProductReviewsCollectionStatusQuery$/i.test(interfaceName)) return { asin, update: 48 };
  return { asin };
}

function positionFromRecord(record, isAd) {
  const type = cleanText(findVal(record, ['positionType', 'PositionType', 'positionName', 'PositionName', 'ShowType']), 80).toLowerCase();
  const pos = num(findVal(record, ['position', 'Position', 'SearchPosition', 'searchPosition', 'rank', 'Rank']));
  if (pos === null) return null;
  const looksAd = /ad|sponsor|广告/.test(type);
  return isAd ? (looksAd ? pos : null) : (looksAd ? null : pos);
}

function spawnCommand(bin, args, env) {
  if (/\.js$/i.test(bin)) return spawn(process.execPath, [bin, ...args], { env, shell: false });
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin)) {
    const dir = path.dirname(bin);
    const candidates = [
      path.join(dir, '..', 'sorftime-cli', 'dist', 'index.js'),
      path.join(dir, 'node_modules', 'sorftime-cli', 'dist', 'index.js')
    ];
    const cliEntry = candidates.find(p => fssync.existsSync(p));
    if (cliEntry) return spawn(process.execPath, [cliEntry, ...args], { env, shell: false });
    return spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${bin}" ${args.map(a => `"${String(a).replace(/"/g, '\\"')}"`).join(' ')}`], { env, shell: false });
  }
  return spawn(bin, args, { env, shell: false });
}

function runSorftimeCli(bin, args, env, timeoutMs = 90000) {
  const start = Date.now();
  return new Promise((resolve) => {
    const child = spawnCommand(bin, args, env);
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ ok: false, exit_code: null, stdout, stderr: `${stderr}\nTimeout`, duration_ms: Date.now() - start });
    }, timeoutMs);
    child.stdout.on('data', d => stdout += d.toString());
    child.stderr.on('data', d => stderr += d.toString());
    child.on('error', err => {
      clearTimeout(timer);
      resolve({ ok: false, exit_code: null, stdout, stderr: err.message, duration_ms: Date.now() - start });
    });
    child.on('close', code => {
      clearTimeout(timer);
      resolve({ ok: code === 0, exit_code: code, stdout: stripAnsi(stdout), stderr: stripAnsi(stderr), duration_ms: Date.now() - start });
    });
  });
}

async function ensureSorftimeProfile(bin, token, env) {
  if (!token) return '';
  const profile = profileNameForToken(token);
  if (ensuredProfiles.has(profile)) return profile;
  await fs.mkdir(DATA_ROOT, { recursive: true });
  const res = await runSorftimeCli(bin, ['add', profile, token], env, 30000);
  if (!res.ok) {
    const error = cleanText(res.stderr || res.stdout || `add profile exited ${res.exit_code}`, 500);
    throw new Error(`Sorftime profile 初始化失败：${error}`);
  }
  ensuredProfiles.add(profile);
  return profile;
}

function normalizeProduct(asin, role, raw, salesRaw = {}) {
  const error = responseMessage(raw) || responseMessage(salesRaw);
  const product = firstProduct(raw, asin);
  const title = findVal(product, ['title', 'Title', 'productTitle', 'name', 'productName']) || '';
  const price = findVal(product, ['salesPrice', 'SalesPrice', 'price', 'Price', 'currentPrice', 'buyboxPrice', 'salePrice']);
  const coupon = promotionText(product);
  const couponAfter = promotionPrice(product);
  const listingMonthlySales = num(findVal(product, [
    'listingSalesVolumeOfMonth', 'ListingSalesVolumeOfMonth',
    'listingSalesVolume', 'ListingSalesVolume',
    'monthlySales', 'MonthlySales', 'monthSales', 'MonthSales',
    'estimatedMonthlySales', 'EstimatedMonthlySales',
    'salesVolumeOfMonth', 'SalesVolumeOfMonth', 'salesVolume30', 'SalesVolume30'
  ]));
  const childSales = latestMonthlySales(salesRaw);
  const monthlySales = listingMonthlySales && listingMonthlySales > 0 ? listingMonthlySales : childSales;
  const revenue = findVal(product, ['listingSalesOfMonth', 'ListingSalesOfMonth', 'revenue', 'salesAmount', 'monthlyRevenue']);
  const brand = findVal(product, ['brand', 'Brand', 'brandName']);
  const image = firstPhoto(product);
  const parentAsin = parentAsinFromRaw(raw, asin);
  const seller = findVal(product, ['buyboxSeller', 'BuyboxSeller', 'sellerName', 'SellerName', 'StoreName']);
  const sellerId = findVal(product, ['buyboxSellerId', 'BuyboxSellerId', 'sellerId', 'SellerId']);
  const sellerCount = findVal(product, ['sellerCount', 'SellerCount']);
  const variationCount = findVal(product, ['variationASINCount', 'VariationASINCount', 'variationCount']);
  const hasAplus = findVal(product, ['APlus', 'aplus', 'hasAplus', 'hasAPlus']);
  const hasVideo = findVal(product, ['hasVideo', 'HasVideo']);
  return {
    asin,
    role,
    title: cleanText(title, 180),
    brand: cleanText(brand, 60),
    price: priceNum(price),
    coupon_after_price: couponAfter,
    parent_asin: parentAsin || '',
    rating: productRating(product),
    rating_count: num(findVal(product, ['ratingCount', 'RatingCount', 'ratingsTotal', 'RatingsTotal'])) || null,
    review_count: productReviewCount(product),
    bsr: extractBsr(product),
    coupon: couponText(coupon),
    monthly_sales: num(monthlySales),
    revenue: num(revenue),
    image: cleanText(image, 500),
    seller_count: num(sellerCount),
    seller_name: cleanText(seller, 80),
    seller_id: cleanText(sellerId, 80),
    has_aplus: boolFlag(hasAplus),
    has_video: boolFlag(hasVideo),
    variation_count: num(variationCount),
    data_status: error ? `调用失败：${error}` : 'OK',
    raw_summary: error
  };
}

function normalizeAsinKeywords(raw) {
  const error = responseMessage(raw);
  const rows = firstArray(raw, ['records', 'Records', 'keywords', 'Keywords', 'list', 'List', 'data', 'Data']);
  let organic = 0;
  let ads = 0;
  const terms = [];
  for (const row of rows) {
    const organicPos = num(findVal(row, ['SearchPosition', 'searchPosition', 'organicRank', 'OrganicRank', 'naturalRank']));
    const adPos = num(findVal(row, ['AdPosition', 'adPosition', 'adRank', 'sponsoredRank', 'advertisingRank']));
    const term = cleanText(findVal(row, ['Keyword', 'keyword', 'SearchKeyword', 'searchKeyword', 'word', 'term']), 120).toLowerCase();
    if (term) terms.push(term);
    if (organicPos !== null && organicPos > 0) organic += 1;
    if (adPos !== null && adPos > 0) ads += 1;
  }
  return {
    traffic_keywords_count: rows.length || null,
    organic_keywords_count: organic || null,
    ad_keywords_count: ads || null,
    keyword_terms: [...new Set(terms)].slice(0, 300),
    keyword_data_status: error ? `调用失败：${error}` : rows.length ? 'OK' : '未返回关键词覆盖'
  };
}

function normalizeKeyword(raw, asin, keyword, metricRaw = {}) {
  const error = responseMessage(raw) || responseMessage(metricRaw);
  const data = unwrapData(raw);
  const records = firstArray(data, ['records', 'Records']);
  const record = records[0] || data || {};
  const organic = num(findVal(record, ['organicRank', 'naturalRank', 'organic_rank'])) ?? positionFromRecord(record, false);
  const ad = num(findVal(record, ['adRank', 'sponsoredRank', 'advertisingRank', 'ad_rank'])) ?? positionFromRecord(record, true);
  const metricData = unwrapData(metricRaw);
  const metricRow = Array.isArray(metricData) ? metricData[0] : metricData;
  const keywordObj = findAny(record, ['keyword', 'Keyword'], { scalarOnly: false }) || metricRow || data;
  return {
    asin,
    keyword,
    organic_rank: organic || null,
    ad_rank: ad || null,
    search_volume: num(findVal(keywordObj, ['searchVolume', 'SearchVolume', 'volume', 'keywordSearches'])) || null,
    cpc: priceNum(findVal(keywordObj, ['CPC', 'cpc', 'Bid', 'bid', 'PPCBid', 'ppcBid'])) || null,
    product_count: num(findVal(keywordObj, ['ProductsTotal', 'productsTotal', 'productCount', 'ProductCount', 'goodsNum', 'GoodsNum', 'competitorCount'])) || null,
    purchase_rate: num(findVal(keywordObj, ['purchaseRate', 'conversionRate', 'cvr', 'searchConversionRate', 'ClickConversionRateD90'])) || null,
    data_status: error ? `调用失败：${error}` : 'OK'
  };
}

function normalizeKeywordMetrics(raw, seedKeyword, source) {
  const rows = firstArray(raw, ['records', 'Records', 'keywords', 'Keywords', 'KeywordExtends', 'keywordExtends', 'list', 'List', 'data', 'Data']);
  const sourceName = source || 'KeywordExtends';
  const mapped = rows.map(row => {
    const keyword = cleanText(findVal(row, ['keyword', 'Keyword', 'name', 'Name', 'word', 'Word', 'term', 'Term']) || seedKeyword, 160);
    return {
      keyword,
      search_volume: num(findVal(row, ['searchVolume', 'SearchVolume', 'volume', 'keywordSearches', 'Searches', 'searches'])) || null,
      cpc: priceNum(findVal(row, ['CPC', 'cpc', 'Bid', 'bid', 'PPCBid', 'ppcBid'])) || null,
      product_count: num(findVal(row, ['ProductsTotal', 'productsTotal', 'productCount', 'ProductCount', 'goodsNum', 'GoodsNum', 'competitorCount'])) || null,
      source: sourceName
    };
  }).filter(r => r.keyword);
  if (mapped.length) return mapped;
  const data = unwrapData(raw);
  return [{
    keyword: seedKeyword,
    search_volume: num(findVal(data, ['searchVolume', 'SearchVolume', 'volume', 'keywordSearches', 'Searches', 'searches'])) || null,
    cpc: priceNum(findVal(data, ['CPC', 'cpc', 'Bid', 'bid', 'PPCBid', 'ppcBid'])) || null,
    product_count: num(findVal(data, ['ProductsTotal', 'productsTotal', 'productCount', 'ProductCount', 'goodsNum', 'GoodsNum', 'competitorCount'])) || null,
    source: sourceName
  }];
}

function normalizeReviews(raw, asin) {
  const arr = firstArray(raw, ['reviews', 'Reviews', 'records', 'Records', 'list', 'List', 'data', 'Data']);
  return arr.slice(0, 50).map(r => ({
    asin,
    star: num(findVal(r, ['star', 'Star', 'rating', 'Rating', 'score', 'Score'])) || null,
    date: cleanText(findVal(r, ['reviewsDate', 'reviewDate', 'date', 'Date', 'createdAt', 'CreatedAt']), 30),
    title: cleanText(findVal(r, ['title', 'Title', 'reviewTitle', 'ReviewTitle', 'subject']), 100),
    body: cleanText(findVal(r, ['body', 'Body', 'content', 'Content', 'text', 'Text', 'reviewContent', 'ReviewContent']), 360),
    vp: boolFlag(findVal(r, ['isVP', 'verified', 'vp', 'verifiedPurchase', 'VerifiedPurchase']))
  })).filter(r => r.title || r.body || r.star);
}

function demoProduct(asin, role, i) {
  const base = role === 'own' ? 36.99 : 29.99 + i * 2;
  return {
    asin, role,
    title: role === 'own' ? 'Demo Own Product - Amazon Listing' : `Demo Competitor Product ${i + 1}`,
    brand: role === 'own' ? 'Your Brand' : `Competitor ${i + 1}`,
    price: Number(base.toFixed(2)),
    coupon_after_price: Number((base * (i % 2 ? 0.9 : 1)).toFixed(2)),
    parent_asin: asin,
    rating: Number((4.1 + (i % 3) * 0.2).toFixed(1)),
    rating_count: null,
    review_count: 120 + i * 85,
    bsr: 9000 - i * 1300,
    coupon: i % 2 ? '10% Coupon' : '',
    monthly_sales: 260 + i * 110,
    revenue: Math.round(base * (260 + i * 110)),
    image: '',
    seller_count: i + 1,
    has_aplus: true,
    has_video: i % 2 === 0,
    variation_count: i + 2,
    traffic_keywords_count: 180 + i * 6,
    organic_keywords_count: 130 + i * 7,
    ad_keywords_count: 35 + i * 12,
    keyword_terms: ['portable charger', 'power bank', 'travel essentials', `demo keyword ${i + 1}`],
    raw_summary: '',
    data_status: 'OK',
    keyword_data_status: 'OK'
  };
}

function trendFor(asin, metric, base, options = {}) {
  return Array.from({ length: 14 }, (_, i) => ({
    date: new Date(Date.now() - (13 - i) * 86400000).toISOString().slice(5, 10),
    asin,
    metric,
    value: Math.max(0, Number((base + Math.sin(i / 2) * base * (options.swing ?? 0.08)).toFixed(options.decimals ?? 0)))
  }));
}

function buildEvents(products, keywords) {
  const events = [];
  for (const p of products) {
    if (p.coupon) events.push({ level: 'medium', type: '促销变化', asin: p.asin, detail: `检测到 Coupon/折扣：${p.coupon}`, suggestion: '评估自有 ASIN 是否需要同步上券，避免价格感知差距扩大。' });
    if (p.price && products[0]?.price && p.role === 'competitor' && p.price < products[0].price * 0.92) events.push({ level: 'high', type: '价格风险', asin: p.asin, detail: `竞品价格 ${p.price} 低于自有 ASIN ${products[0].price}`, suggestion: '检查毛利空间，优先用 Coupon/广告词补量，不建议盲目打价格战。' });
    if (p.review_count && products[0]?.review_count && p.role === 'competitor' && p.review_count > products[0].review_count * 2) events.push({ level: 'medium', type: '评论门槛', asin: p.asin, detail: `竞品评论数明显高于自有产品：${p.review_count}`, suggestion: '强化评价获取、QA 内容、主图信任背书，降低用户决策门槛。' });
  }
  const lost = keywords.filter(k => k.asin === products[0]?.asin && k.organic_rank && k.organic_rank > 20);
  if (lost.length) events.push({ level: 'high', type: '关键词风险', asin: products[0].asin, detail: `自有 ASIN 有 ${lost.length} 个核心词自然位在 20 名之后。`, suggestion: '优先检查标题/五点/广告投放与核心词相关性。' });
  return events;
}

function buildActions(events) {
  if (!events.length) return [{ priority: 'P2', owner: '运营', action: '继续观察', reason: '暂无明显异常事件', expected: '维持价格、BSR、核心词排名稳定' }];
  return events.slice(0, 8).map((e, idx) => ({
    priority: e.level === 'high' ? 'P0' : e.level === 'medium' ? 'P1' : 'P2',
    owner: '运营',
    action: e.suggestion,
    reason: `${e.type}：${e.detail}`,
    expected: idx < 3 ? '24 小时内确认动作，次日复盘变化' : '纳入本周监控'
  }));
}

async function callSorftime({ interfaceName, params, domain, token, timeoutMs = 90000 }) {
  const bin = localSorftimeBin();
  const env = sorftimeEnv(token);
  const profile = await ensureSorftimeProfile(bin, token, env);
  const args = ['api', interfaceName, JSON.stringify(params), '--domain', String(domain || 1)];
  if (profile) args.push('--profile', profile);
  const startIso = nowIso();
  const start = Date.now();
  return new Promise((resolve) => {
    const child = spawnCommand(bin, args, env);
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ ok: false, data: { error: 'timeout' }, stdout, stderr: stderr + '\nTimeout', started_at: startIso, ended_at: nowIso(), duration_ms: Date.now() - start, command_preview: `sorftime api ${interfaceName} '<json>' --domain ${domain || 1}` });
    }, timeoutMs);
    child.stdout.on('data', d => stdout += d.toString());
    child.stderr.on('data', d => stderr += d.toString());
    child.on('error', err => {
      clearTimeout(timer);
      resolve({ ok: false, data: { error: err.message }, stdout, stderr, started_at: startIso, ended_at: nowIso(), duration_ms: Date.now() - start, command_preview: `sorftime api ${interfaceName} '<json>' --domain ${domain || 1}` });
    });
    child.on('close', code => {
      clearTimeout(timer);
      let data;
      try { data = JSON.parse(stdout); } catch { data = { raw_text: stdout, error: code === 0 ? null : `CLI exited ${code}` }; }
      const apiCode = responseCode(data);
      const stdoutText = cleanText(stripAnsi(stdout), 1000);
      const stderrText = cleanText(stripAnsi(stderr), 1000);
      const apiError = responseMessage(data);
      const error = code !== 0
        ? apiError && !/^CLI exited \d+$/i.test(apiError) ? apiError : stderrText || stdoutText || `CLI exited ${code}`
        : apiCode && apiCode !== 0
          ? apiError || `Sorftime code ${apiCode}`
          : data?.error || '';
      if (error && data && typeof data === 'object') data.error = cleanText(error, 500);
      resolve({
        ok: code === 0 && !error,
        exit_code: code,
        api_code: apiCode,
        request_consumed: responseMetric(data, ['requestConsumed', 'RequestConsumed', 'coinConsumed', 'CoinConsumed']),
        request_left: responseMetric(data, ['requestLeft', 'RequestLeft', 'coinLeft', 'CoinLeft']),
        request_count: responseMetric(data, ['requestCount', 'RequestCount']),
        error: cleanText(error, 500),
        data,
        stdout: stripAnsi(stdout),
        stderr: stripAnsi(stderr),
        started_at: startIso,
        ended_at: nowIso(),
        duration_ms: Date.now() - start,
        command_preview: `sorftime api ${interfaceName} '<json>' --domain ${domain || 1}`
      });
    });
  });
}

async function generateReport(input) {
  const runId = `${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0,14)}_${nanoid(6)}`;
  const outDir = path.join(REPORT_ROOT, runId);
  await fs.mkdir(outDir, { recursive: true });

  const marketplace = input.marketplace || 'US';
  const domain = Number(input.domain || 1);
  const ownAsins = splitLines(input.ownAsins || input.own_asins);
  const competitorAsins = splitLines(input.competitorAsins || input.competitor_asins);
  const coreKeywords = splitKeywords(input.coreKeywords || input.core_keywords);
  const token = String(input.sorftimeToken || input.token || process.env.SORFTIME_CLI_TOKEN || '').trim();
  const demoMode = Boolean(input.demoMode) || !token;
  const interfaces = {
    product: input.productInterface || 'ProductRequest',
    sales: input.salesInterface || 'AsinSalesVolume',
    asinKeywords: input.asinKeywordsInterface || 'ASINRequestKeywordv2',
    keyword: input.keywordInterface || 'ASINKeywordRanking',
    keywordMetric: input.keywordMetricInterface || 'KeywordExtends',
    review: input.reviewInterface || 'ProductReviewsQuery'
  };
  if (!ownAsins.length) throw new Error('请至少输入 1 个自有 ASIN');
  if (!competitorAsins.length) throw new Error('请至少输入 1 个竞品 ASIN');

  const allAsins = [...ownAsins.map(a => ({ asin: a, role: 'own' })), ...competitorAsins.map(a => ({ asin: a, role: 'competitor' }))];
  const audit = [];
  const rawDir = path.join(outDir, 'raw');
  await fs.mkdir(rawDir, { recursive: true });

  const products = [];
  const keywordRows = [];
  const keywordMetricRowsData = [];
  let reviews = [];
  const productByAsin = new Map();
  const salesByAsin = new Map();
  const asinKeywordsByAsin = new Map();

  if (demoMode) {
    allAsins.forEach((x, i) => products.push(demoProduct(x.asin, x.role, i)));
    for (const asinObj of allAsins) for (const [i, kw] of coreKeywords.entries()) keywordRows.push({ asin: asinObj.asin, keyword: kw, organic_rank: asinObj.role === 'own' ? 8 + i * 9 : 4 + i * 3, ad_rank: i + 1, search_volume: 1200 + i * 800, purchase_rate: Number((2.3 + i * .4).toFixed(1)) });
    for (const [i, kw] of coreKeywords.entries()) keywordMetricRowsData.push({ keyword: kw, search_volume: 1200 + i * 800, cpc: 0.8 + i * 0.2, product_count: 5000 + i * 1000, source: 'Demo' });
    reviews = [{ asin: ownAsins[0], star: 2, date: today(), title: 'Demo negative review', body: 'Customer mentions heat, installation, missing parts. Use as VOC example.', vp: true }];
  } else {
    const batchParams = productBatchParams(interfaces.product, allAsins.map(x => x.asin));
    if (batchParams) {
      const res = await callSorftime({ interfaceName: interfaces.product, params: batchParams, domain, token });
      await fs.writeFile(path.join(rawDir, `asin_detail_${interfaces.product}.json`), JSON.stringify(res.data, null, 2));
      audit.push(auditRecord(res, interfaces.product, batchParams, domain));
      for (const item of allAsins) productByAsin.set(item.asin, res.data);
      await sleep(200);
    }

    for (let i = 0; i < allAsins.length; i++) {
      const item = allAsins[i];
      if (!batchParams) {
        const params = productParams(interfaces.product, item.asin);
        const res = await callSorftime({ interfaceName: interfaces.product, params, domain, token });
        await fs.writeFile(path.join(rawDir, `${item.asin}_${interfaces.product}.json`), JSON.stringify(res.data, null, 2));
        audit.push(auditRecord(res, interfaces.product, params, domain));
        productByAsin.set(item.asin, res.data);
        await sleep(200);
      }

      const parentAsin = parentAsinFromRaw(productByAsin.get(item.asin) || {}, item.asin);
      const salesAsin = parentAsin || item.asin;
      const salesCallParams = salesParams(interfaces.sales, salesAsin);
      const sr = await callSorftime({ interfaceName: interfaces.sales, params: salesCallParams, domain, token, timeoutMs: 90000 });
      await fs.writeFile(path.join(rawDir, `${item.asin}_${interfaces.sales}.json`), JSON.stringify(sr.data, null, 2));
      audit.push(auditRecord(sr, interfaces.sales, salesCallParams, domain));
      salesByAsin.set(item.asin, sr.data);
      await sleep(200);

      const asinKeywordCallParams = asinKeywordParams(interfaces.asinKeywords, item.asin);
      const ak = await callSorftime({ interfaceName: interfaces.asinKeywords, params: asinKeywordCallParams, domain, token, timeoutMs: 90000 });
      await fs.writeFile(path.join(rawDir, `${item.asin}_${interfaces.asinKeywords}.json`), JSON.stringify(ak.data, null, 2));
      audit.push(auditRecord(ak, interfaces.asinKeywords, asinKeywordCallParams, domain));
      asinKeywordsByAsin.set(item.asin, ak.data);
      await sleep(200);

      const reviewCallParams = reviewParams(interfaces.review, item.asin);
      const rr = await callSorftime({ interfaceName: interfaces.review, params: reviewCallParams, domain, token, timeoutMs: 90000 });
      await fs.writeFile(path.join(rawDir, `${item.asin}_${interfaces.review}.json`), JSON.stringify(rr.data, null, 2));
      audit.push(auditRecord(rr, interfaces.review, reviewCallParams, domain));
      reviews.push(...normalizeReviews(rr.data, item.asin));
      await sleep(200);
    }

    for (const item of allAsins) {
      products.push({
        ...normalizeProduct(item.asin, item.role, productByAsin.get(item.asin) || {}, salesByAsin.get(item.asin) || {}),
        ...normalizeAsinKeywords(asinKeywordsByAsin.get(item.asin) || {})
      });
    }

    const keywordMetrics = new Map();
    for (const kw of coreKeywords.slice(0, 20)) {
      const params = keywordMetricParams(interfaces.keywordMetric, kw);
      const km = await callSorftime({ interfaceName: interfaces.keywordMetric, params, domain, token, timeoutMs: 90000 });
      await fs.writeFile(path.join(rawDir, `keyword_${kw.replace(/[^a-z0-9]+/gi,'_')}_${interfaces.keywordMetric}.json`), JSON.stringify(km.data, null, 2));
      audit.push(auditRecord(km, interfaces.keywordMetric, params, domain));
      keywordMetrics.set(kw, km.data);
      keywordMetricRowsData.push(...normalizeKeywordMetrics(km.data, kw, interfaces.keywordMetric));
      await sleep(150);
    }

    for (const asinObj of allAsins) {
      for (const kw of coreKeywords.slice(0, 20)) {
        const params = keywordParams(interfaces.keyword, asinObj.asin, kw, marketplace);
        const kr = await callSorftime({ interfaceName: interfaces.keyword, params, domain, token, timeoutMs: 90000 });
        await fs.writeFile(path.join(rawDir, `${asinObj.asin}_${kw.replace(/[^a-z0-9]+/gi,'_')}_${interfaces.keyword}.json`), JSON.stringify(kr.data, null, 2));
        audit.push(auditRecord(kr, interfaces.keyword, params, domain));
        keywordRows.push(normalizeKeyword(kr.data, asinObj.asin, kw, keywordMetrics.get(kw)));
        await sleep(150);
      }
    }
  }

  const events = buildEvents(products, keywordRows);
  const actions = buildActions(events);
  const trends = products.flatMap(p => [
    ...trendFor(p.asin, 'price', p.price || 30, { decimals: 2, swing: 0.015 }),
    ...trendFor(p.asin, 'bsr', p.bsr || 8000),
    ...trendFor(p.asin, 'sales_daily', (p.monthly_sales || 0) / 30, { decimals: 0, swing: 0.12 }),
    ...trendFor(p.asin, 'rating', p.rating || 4.5, { decimals: 1, swing: 0.004 }),
    ...trendFor(p.asin, 'review', p.review_count || 100)
  ]);
  const totalDurationMs = audit.reduce((sum, a) => sum + (num(a.duration_ms) || 0), 0);
  const totalRequestConsumed = audit.reduce((sum, a) => sum + (num(a.request_consumed) || 0), 0);
  const reportData = {
    meta: { report_id: runId, report_date: today(), generated_at: nowIso(), marketplace, domain, demo_mode: demoMode, token_mask: mask(token), source: demoMode ? 'demo' : 'sorftime-cli' },
    input: { own_asins: ownAsins, competitor_asins: competitorAsins, core_keywords: coreKeywords, interfaces },
    summary: {
      asin_count: products.length,
      competitor_count: competitorAsins.length,
      event_count: events.length,
      high_risk_count: events.filter(e => e.level === 'high').length,
      opportunity_count: actions.length,
      audit_count: audit.length,
      failed_calls: audit.filter(a => !a.ok).length,
      total_duration_ms: totalDurationMs,
      total_request_consumed: totalRequestConsumed
    },
    asin_snapshots: products,
    keyword_gap: keywordRows,
    keyword_metrics: keywordMetricRowsData,
    review_topics: reviewTopicStats(reviews),
    review_voc: reviews,
    trends,
    events,
    action_items: actions,
    request_audit: audit
  };

  const html = renderExactHtml(reportData);
  const md = renderMarkdown(reportData);
  const csv = stringify(products, { header: true });
  await fs.writeFile(path.join(outDir, 'report_data.json'), JSON.stringify(reportData, null, 2));
  await fs.writeFile(path.join(outDir, 'amazon_competitor_monitoring_report.html'), html);
  await fs.writeFile(path.join(outDir, 'amazon_competitor_monitoring_report.md'), md);
  await fs.writeFile(path.join(outDir, 'asin_snapshots.csv'), csv);
  return { runId, reportData };
}

function esc(s) { return String(s ?? '').replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m])); }

function fmtMoney(v) {
  return v === null || v === undefined || v === '' ? '-' : `$${Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtNum(v) {
  return v === null || v === undefined || v === '' ? '-' : Number(v).toLocaleString('en-US');
}

function fmtRating(v) {
  return v === null || v === undefined || v === '' ? '-' : Number(v).toFixed(1);
}

function fmtMs(v) {
  if (v === null || v === undefined || v === '') return '-';
  const n = Number(v);
  return Number.isFinite(n) ? `${n.toLocaleString('en-US')} ms` : '-';
}

function dataSourceLabel(d) {
  return `${d.meta.source} · ${d.meta.marketplace} · ${d.meta.report_date}`;
}

function compareRows(products) {
  const own = products.find(p => p.role === 'own') || products[0];
  if (!own) return '';
  return products.filter(p => p.role !== 'own').map(p => {
    const priceDiff = p.price !== null && p.price !== undefined && own.price !== null && own.price !== undefined ? p.price - own.price : null;
    const salesDiff = p.monthly_sales !== null && p.monthly_sales !== undefined && own.monthly_sales !== null && own.monthly_sales !== undefined ? p.monthly_sales - own.monthly_sales : null;
    const bsrDiff = p.bsr !== null && p.bsr !== undefined && own.bsr !== null && own.bsr !== undefined ? p.bsr - own.bsr : null;
    const reviewDiff = p.review_count !== null && p.review_count !== undefined && own.review_count !== null && own.review_count !== undefined ? p.review_count - own.review_count : null;
    const trafficDiff = p.traffic_keywords_count && own.traffic_keywords_count ? p.traffic_keywords_count - own.traffic_keywords_count : null;
    return `<tr><td><strong>${esc(own.asin)}</strong></td><td><strong>${esc(p.asin)}</strong></td><td>${priceDiff === null ? '-' : fmtMoney(priceDiff)}</td><td>${salesDiff === null ? '-' : fmtNum(salesDiff)}</td><td>${bsrDiff === null ? '-' : fmtNum(bsrDiff)}</td><td>${reviewDiff === null ? '-' : fmtNum(reviewDiff)}</td><td>${trafficDiff === null ? '-' : fmtNum(trafficDiff)}</td><td>${esc([p.brand, p.seller_name].filter(Boolean).join(' / ') || '-')}</td></tr>`;
  }).join('');
}

function renderHtml(d) {
  const jsData = JSON.stringify(d).replace(/</g, '\\u003c');
  const rows = d.asin_snapshots.map(p => `<tr><td>${esc(p.role === 'own' ? '自有' : '竞品')}</td><td><strong>${esc(p.asin)}</strong></td><td>${esc(p.brand || '-')}</td><td class="title-cell">${esc(p.title || '未获取')}</td><td><strong class="metric-emphasis">${fmtMoney(p.price)}</strong></td><td>${esc(p.coupon || '无')}</td><td>${fmtNum(p.bsr)}</td><td>${fmtNum(p.monthly_sales)}</td><td>${fmtRating(p.rating)}</td><td>${fmtNum(p.review_count)}</td><td>${fmtNum(p.traffic_keywords_count)}</td><td>${fmtNum(p.organic_keywords_count)}</td><td>${fmtNum(p.ad_keywords_count)}</td><td>${fmtNum(p.seller_count)}</td><td>${p.has_aplus ? '是' : '否'}</td><td>${p.has_video ? '是' : '否'}</td><td>${fmtNum(p.variation_count)}</td><td><span class="${p.data_status === 'OK' && p.keyword_data_status === 'OK' ? 'status-ok' : 'status-warn'}">${esc(p.data_status === 'OK' ? (p.keyword_data_status || 'OK') : p.data_status)}</span></td></tr>`).join('');
  const eventCards = d.events.map(e => `<div class="event ${e.level}"><b>${esc(e.type)}</b><span>${esc(e.asin)}</span><p>${esc(e.detail)}</p><small>${esc(e.suggestion)}</small></div>`).join('') || '<div class="empty">暂无明显变化事件</div>';
  const actions = d.action_items.map(a => `<tr><td>${esc(a.priority)}</td><td>${esc(a.owner)}</td><td>${esc(a.action)}</td><td>${esc(a.reason)}</td><td>${esc(a.expected)}</td></tr>`).join('');
  const keywordRows = d.keyword_gap.map(k => `<tr><td>${esc(k.asin)}</td><td>${esc(k.keyword)}</td><td>${k.organic_rank ?? '-'}</td><td>${k.ad_rank ?? '-'}</td><td><strong class="metric-emphasis">${fmtNum(k.search_volume)}</strong></td><td>${k.purchase_rate ?? '-'}</td><td><span class="${k.data_status === 'OK' ? 'status-ok' : 'status-warn'}">${esc(k.data_status || 'OK')}</span></td></tr>`).join('');
  const audit = d.request_audit.slice(-120).map(a => `<tr><td>${esc(a.timestamp)}</td><td>${esc(a.ended_at || '-')}</td><td>${esc(a.interface)}</td><td><code>${esc(JSON.stringify(a.params))}</code></td><td>${a.request_consumed ?? '-'}</td><td>${a.request_left ?? '-'}</td><td>${a.request_count ?? '-'}</td><td>${a.exit_code ?? '-'}</td><td>${a.api_code ?? '-'}</td><td>${fmtMs(a.duration_ms)}</td><td><span class="${a.ok ? 'status-ok' : 'status-warn'}">${esc(a.ok ? 'OK' : 'FAIL')}</span></td><td>${esc(auditError(a) || '-')}</td></tr>`).join('');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Amazon ASIN 竞品监控报告</title><script src="https://cdn.jsdelivr.net/npm/echarts@5/dist/echarts.min.js"></script><style>${css()}</style></head><body><div class="report-header"><div><strong>ASIN Monitor</strong><span>${esc(dataSourceLabel(d))}</span></div></div><div class="report-layout"><aside><div class="brand">ASIN Monitor</div><nav><a href="#overview">今日总览</a><a href="#event-board">事件面板</a><a href="#watch-wall">监控墙</a><a href="#actions">处理建议</a><a href="#asin-table">ASIN 明细</a><a href="#comparison">对比分析</a><a href="#trends">趋势证据</a><a href="#keywords">关键词表现</a><a href="#reviews">评论 VOC</a><a href="#method">数据口径</a><a href="#interface-audit">接口审计</a></nav><div class="reading-line"><b>阅读主线</b><br>先看今天变了什么，再看 ASIN 明细和字段口径，最后检查接口调用消耗与错误。</div></aside><main><section id="overview" class="hero"><div><div class="tag">${esc(dataSourceLabel(d))}</div><h1>Amazon ASIN 竞品监控报告</h1><p>按 Skill 逻辑框架组织：Sorftime CLI 采集、接口审计留痕、ASIN 标准字段、竞品差距、关键词覆盖和数据口径集中展示。</p></div><div class="kpis"><div><b>${d.summary.opportunity_count}</b><span>待处理事项</span></div><div><b>${d.summary.event_count}</b><span>风险/变化事件</span></div><div><b>${d.summary.asin_count}</b><span>监控 ASIN</span></div><div><b>${fmtMs(d.summary.total_duration_ms)}</b><span>CLI 总运行时间</span></div><div><b>${d.summary.audit_count}</b><span>接口调用</span></div><div><b>${d.summary.total_request_consumed || '-'}</b><span>消耗次数</span></div></div></section><section id="event-board"><p class="section-kicker">01 事件面板</p><h2>关键变化与风险</h2><div class="events">${eventCards}</div></section><section id="watch-wall"><p class="section-kicker">02 监控墙</p><h2>监控范围与数据状态</h2><div class="watch-grid"><div><b>${d.summary.asin_count}</b><span>ASIN</span></div><div><b>${d.summary.failed_calls}</b><span>失败请求</span></div><div><b>${d.meta.generated_at}</b><span>生成时间</span></div></div></section><section id="actions"><p class="section-kicker">03 处理建议</p><h2>处理建议</h2><div class="report-table-block"><table class="data-table"><thead><tr><th>优先级</th><th>负责人</th><th>建议动作</th><th>依据</th><th>预期</th></tr></thead><tbody>${actions}</tbody></table></div></section><section id="asin-table"><p class="section-kicker">04 ASIN 明细</p><h2>ASIN 监控概览</h2><div class="report-table-block"><table class="data-table asin-table"><thead><tr><th>角色</th><th>ASIN</th><th>品牌</th><th>标题</th><th>价格</th><th>Coupon</th><th>BSR</th><th>估算销量</th><th>评分</th><th>Review</th><th>流量词</th><th>自然词</th><th>广告词</th><th>卖家数</th><th>A+</th><th>视频</th><th>变体</th><th>数据状态</th></tr></thead><tbody>${rows}</tbody></table></div></section><section id="comparison"><p class="section-kicker">05 对比分析</p><h2>自有 ASIN vs 竞品</h2><div class="chartgrid"><div id="priceCompareChart"></div><div id="reviewChart"></div></div><div class="report-table-block mt-block"><table class="data-table"><thead><tr><th>自有 ASIN</th><th>竞品 ASIN</th><th>价格差</th><th>销量差</th><th>BSR 差</th><th>Review 差</th><th>流量词差</th><th>补充信息</th></tr></thead><tbody>${compareRows(d.asin_snapshots) || '<tr><td colspan="8">暂无竞品对比数据</td></tr>'}</tbody></table></div><p class="muted small-note">差值为竞品减自有；BSR 数值越小通常越好。</p></section><section id="trends"><p class="section-kicker">06 趋势证据</p><h2>价格、BSR 与销量趋势</h2><div class="chartgrid"><div id="priceChart"></div><div id="bsrChart"></div><div id="salesChart"></div></div></section><section id="keywords"><p class="section-kicker">07 关键词表现</p><h2>关键词排名与搜索指标</h2><div class="report-table-block"><table class="data-table"><thead><tr><th>ASIN</th><th>关键词</th><th>自然位</th><th>广告位</th><th>搜索量</th><th>购买率</th><th>数据状态</th></tr></thead><tbody>${keywordRows}</tbody></table></div></section><section id="reviews"><p class="section-kicker">08 评论 VOC</p><h2>评论样本与风险点</h2><div class="reviews">${d.review_voc.map(r => `<article><b>${esc(r.asin)} · ${fmtRating(r.star)}★</b><h3>${esc(r.title)}</h3><p>${esc(r.body)}</p></article>`).join('') || '<div class="empty">暂无评论数据</div>'}</div></section><section id="method"><p class="section-kicker">09 数据口径</p><h2>字段核对口径</h2><div class="method-grid"><div><b>价格</b><p>读取 salesPrice / price / Price，按当地最小货币单位换算为美元小数。</p></div><div><b>评分</b><p>读取 ratings / Star / rating 等星级字段，只接受 0-5 分并保留 1 位小数。</p></div><div><b>评论数</b><p>读取 ratingsCount / reviewCount / reviewsCount；仅当大写 Ratings 大于 5 时兜底作评论数。</p></div><div><b>关键词覆盖</b><p>来自 ASINRequestKeywordv2；自然词按 SearchPosition，广告词按 AdPosition 近似。</p></div><div><b>接口消耗</b><p>读取 requestConsumed / requestLeft / requestCount，并记录每次调用开始、结束和耗时。</p></div><div><b>结论边界</b><p>首次基线不输出真实跨日变化，所有销量、BSR、关键词均为第三方口径。</p></div></div></section><section id="interface-audit"><p class="section-kicker">10 接口审计</p><h2>Sorftime CLI 调用明细</h2><p class="muted">密钥不会写入报告；这里保留接口、参数、消耗次数、运行时间、状态和错误摘要。</p><div class="report-table-block audit-scroll"><table class="data-table audit-table"><thead><tr><th>开始时间</th><th>结束时间</th><th>接口</th><th>参数</th><th>消耗次数</th><th>剩余次数</th><th>请求总数</th><th>退出码</th><th>API码</th><th>耗时</th><th>状态</th><th>错误摘要</th></tr></thead><tbody>${audit}</tbody></table></div></section></main></div><script>window.REPORT_DATA=${jsData};${chartJs()}</script></body></html>`;
}

function roleLabel(role) {
  return role === 'own' ? '自有' : '竞品';
}

function asinUrl(asin) {
  return `https://www.amazon.com/dp/${encodeURIComponent(asin)}`;
}

function couponAfterPrice(p) {
  if (p.coupon_after_price !== null && p.coupon_after_price !== undefined) return p.coupon_after_price;
  const price = num(p.price);
  if (price === null) return null;
  const text = cleanText(p.coupon, 80);
  const pct = text.match(/(\d+(?:\.\d+)?)\s*%/);
  if (pct) return Number((price * (1 - Number(pct[1]) / 100)).toFixed(2));
  const off = text.match(/\$?\s*(\d+(?:\.\d+)?)/);
  if (off && /off|coupon|\$/i.test(text)) return Math.max(0, Number((price - Number(off[1])).toFixed(2)));
  return price;
}

function hasPromotion(p) {
  const price = num(p.price);
  const after = couponAfterPrice(p);
  return Boolean(p.coupon) || (price !== null && after !== null && after < price);
}

function couponAfterDisplay(p) {
  if (!hasPromotion(p)) return '无促销';
  const after = couponAfterPrice(p);
  return after === null ? esc(p.coupon || '有促销') : fmtMoney(after);
}

function productTag(p) {
  const title = `${p.brand || ''} ${p.title || ''}`;
  const bits = [p.brand].filter(Boolean);
  const mah = title.match(/\b\d{4,6}\s*mAh\b/i);
  const watt = title.match(/\b\d{2,3}\s*W\b/i);
  if (mah) bits.push(mah[0].replace(/\s+/g, ''));
  if (watt) bits.push(watt[0].replace(/\s+/g, ''));
  if (p.bsr && p.bsr <= 10) bits.push('Best Seller');
  if (p.has_aplus) bits.push('A+');
  if (p.has_video) bits.push('Video');
  return bits.slice(0, 5).join(' / ') || '-';
}

function assetScore(p) {
  return (p.has_aplus ? 35 : 0) + (p.has_video ? 25 : 0) + Math.min(40, (num(p.variation_count) || 0) * 4);
}

function fmtPct(v) {
  return v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? '-' : `${Number(v).toFixed(1)}%`;
}

function signedNum(v) {
  if (v === null || v === undefined || v === '' || !Number.isFinite(Number(v))) return '-';
  const n = Number(v);
  return `${n > 0 ? '+' : ''}${fmtNum(n)}`;
}

function signedMoney(v) {
  if (v === null || v === undefined || v === '' || !Number.isFinite(Number(v))) return '-';
  const n = Number(v);
  return `${n > 0 ? '+' : ''}${fmtMoney(n)}`;
}

function trendRows(d) {
  return d.asin_snapshots.map(p => {
    const rows = d.trends.filter(t => t.asin === p.asin);
    const byMetric = metric => rows.filter(r => r.metric === metric);
    const summarize = (metric, formatter) => {
      const list = byMetric(metric);
      if (!list.length) return { range: '-', firstLast: '-', change: '-' };
      const first = list[0];
      const last = list[list.length - 1];
      const diff = Number(last.value || 0) - Number(first.value || 0);
      const pct = first.value ? diff / Number(first.value) * 100 : null;
      return {
        range: `${esc(first.date)} → ${esc(last.date)}`,
        firstLast: `${formatter(first.value)} → ${formatter(last.value)}`,
        change: `${metric === 'price' ? signedMoney(diff) : signedNum(diff)}${pct === null ? '' : ` (${fmtPct(pct)})`}`
      };
    };
    const price = summarize('price', fmtMoney);
    const bsr = summarize('bsr', fmtNum);
    const sales = summarize('sales_daily', fmtNum);
    return `<tr><td>${roleLabel(p.role)}</td><td><strong class="metric-emphasis">${esc(p.asin)}</strong></td><td>${price.range}</td><td>${price.firstLast}</td><td>${price.change}</td><td>${bsr.firstLast}</td><td>${bsr.change}</td><td>${sales.firstLast}</td><td>${sales.change}</td></tr>`;
  }).join('');
}

function keywordCoverageRows(products) {
  return products.map(p => `<tr><td>${roleLabel(p.role)}</td><td><strong class="metric-emphasis">${esc(p.asin)}</strong></td><td>${fmtNum(p.traffic_keywords_count)}</td><td>${fmtNum(p.organic_keywords_count)}</td><td>${fmtNum(p.ad_keywords_count)}</td><td>缺口</td></tr>`).join('');
}

function keywordMissingRows(d) {
  const ownTerms = new Set(d.asin_snapshots.filter(p => p.role === 'own').flatMap(p => p.keyword_terms || []));
  const counts = new Map();
  for (const p of d.asin_snapshots.filter(p => p.role !== 'own')) {
    for (const term of p.keyword_terms || []) if (!ownTerms.has(term)) counts.set(term, (counts.get(term) || 0) + 1);
  }
  if (!counts.size) {
    for (const kw of d.input.core_keywords || []) counts.set(kw.toLowerCase(), 0);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 30)
    .map(([kw, count]) => `<tr><td>${esc(kw)}</td><td>${fmtNum(count)}</td><td>${count ? '竞品覆盖，自有未覆盖' : '核心词需复核覆盖'}</td><td>建议复核标题、五点、广告词</td></tr>`).join('');
}

function keywordMetricRows(d) {
  const rows = [];
  const seen = new Set();
  for (const k of d.keyword_metrics || []) {
    if (!k.keyword || seen.has(k.keyword)) continue;
    seen.add(k.keyword);
    const supply = k.search_volume && k.product_count ? Number((k.search_volume / Math.max(1, k.product_count)).toFixed(2)) : '-';
    rows.push(`<tr><td>${esc(k.keyword)}</td><td><strong class="metric-emphasis">${fmtNum(k.search_volume)}</strong></td><td>${k.cpc ? fmtMoney(k.cpc) : '-'}</td><td>${fmtNum(k.product_count)}</td><td>${supply}</td><td>${esc(k.source || d.input.interfaces.keywordMetric || 'KeywordExtends')}</td></tr>`);
  }
  for (const k of d.keyword_gap || []) {
    if (seen.has(k.keyword)) continue;
    seen.add(k.keyword);
    const supply = k.search_volume && k.search_volume > 0 ? '-' : '-';
    rows.push(`<tr><td>${esc(k.keyword)}</td><td><strong class="metric-emphasis">${fmtNum(k.search_volume)}</strong></td><td>${k.cpc ? fmtMoney(k.cpc) : '-'}</td><td>${fmtNum(k.product_count)}</td><td>${supply}</td><td>${esc(d.input.interfaces.keywordMetric || 'KeywordExtends')}</td></tr>`);
  }
  for (const kw of d.input.core_keywords || []) {
    if (!seen.has(kw)) rows.push(`<tr><td>${esc(kw)}</td><td>-</td><td>-</td><td>-</td><td>-</td><td>输入关键词</td></tr>`);
  }
  return rows.join('');
}

function reviewDistributionRows(d) {
  const byAsin = new Map();
  for (const r of d.review_voc || []) {
    if (!byAsin.has(r.asin)) byAsin.set(r.asin, [0, 0, 0, 0, 0]);
    const star = Math.max(1, Math.min(5, Math.round(num(r.star) || 0)));
    if (star) byAsin.get(r.asin)[star - 1] += 1;
  }
  const asins = d.asin_snapshots.map(p => p.asin);
  return asins.map(asin => {
    const arr = byAsin.get(asin) || [0, 0, 0, 0, 0];
    const total = arr.reduce((a, b) => a + b, 0);
    const cells = arr.map(v => total ? fmtPct(v / total * 100) : '-').join('</td><td>');
    return `<tr><td><strong class="metric-emphasis">${esc(asin)}</strong></td><td>${cells}</td></tr>`;
  }).join('');
}

function reviewTopicStats(source) {
  const reviews = Array.isArray(source) ? source : (source.review_voc || []);
  const themes = [
    { topic: '外观颜值/设计质感', words: ['beautiful', 'look', 'looks', 'design', 'modern', 'elegant', 'style', 'brushed', 'gold', 'black', '外观', '颜值', '设计'] },
    { topic: '质量做工/材料扎实', words: ['quality', 'solid', 'sturdy', 'heavy', 'hardware', 'tempered', 'durable', '质量', '做工', '材质'] },
    { topic: '安装体验/说明清晰', words: ['install', 'installation', 'installed', 'instructions', 'straightforward', 'easy', '安装', '说明'] },
    { topic: '性价比/价格满意', words: ['price', 'value', 'worth', 'affordable', 'deal', '性价比', '价格'] },
    { topic: '包装物流/到货状态', words: ['packaged', 'package', 'shipping', 'arrived', 'delivered', '物流', '包装'] },
    { topic: '开合顺滑/使用体验', words: ['smooth', 'slide', 'sliding', 'soft-close', 'works', 'function', '使用', '顺滑'] },
    { topic: '安装困难/耗时', words: ['difficult', 'hard', 'challenge', 'precision', 'complicated', 'unclear', '困难', '复杂'] },
    { topic: '破损/缺件/配件问题', words: ['broken', 'damaged', 'missing', 'replacement', 'parts', '缺件', '破损', '配件'] },
    { topic: '漏水/挡水问题', words: ['water', 'leak', 'leaking', 'splash', 'seal', 'strip', '漏水', '挡水'] },
    { topic: '尺寸匹配/调节问题', words: ['size', 'fit', 'measure', 'adjustable', 'opening', '尺寸', '匹配'] }
  ];
  const stats = new Map();
  for (const review of reviews) {
    const text = cleanText(`${review.title || ''} ${review.body || ''}`, 1600).toLowerCase();
    const star = num(review.star);
    const direction = star !== null && star < 4 ? '差评' : '好评';
    for (const theme of themes) {
      if (!theme.words.some(w => text.includes(w))) continue;
      const key = `${direction}:${theme.topic}`;
      const row = stats.get(key) || { topic: theme.topic, count: 0, direction, example: '' };
      row.count += 1;
      if (!row.example) row.example = cleanText(review.title || review.body || '', 120);
      stats.set(key, row);
    }
  }
  return [...stats.values()]
    .filter(r => r.count > 0)
    .sort((a, b) => (a.direction === b.direction ? 0 : a.direction === '差评' ? -1 : 1) || b.count - a.count || a.topic.localeCompare(b.topic))
    .slice(0, 10);
}

function vocTopicRows(d) {
  const topics = (d.review_topics && d.review_topics.length ? d.review_topics : reviewTopicStats(d));
  return topics.map(t => `<tr><td>${esc(t.direction)}</td><td>${esc(t.topic)}</td><td>${fmtNum(t.count)}</td><td>${esc(t.example || '-')}</td></tr>`).join('');
}

function interfaceToolName(name) {
  if (/ProductRequest/i.test(name)) return 'asin_detail';
  if (/AsinSalesVolume/i.test(name)) return 'asin_sales';
  if (/ASINRequestKeyword/i.test(name)) return 'asin_keywords';
  if (/ASINKeywordRanking/i.test(name)) return 'asin_kw_rank';
  if (/KeywordExtends/i.test(name)) return 'keyword_extend';
  if (/Keyword/i.test(name)) return 'keyword_detail';
  if (/Review/i.test(name)) return 'reviews';
  return name;
}

function paramSummary(params) {
  return Object.entries(params || {}).map(([k, v]) => `${k}=${Array.isArray(v) ? `[${v.length} items]` : String(v).slice(0, 80)}`).join(', ');
}

function interfaceSummaryRows(audit) {
  const counts = new Map();
  for (const a of audit) counts.set(interfaceToolName(a.interface), (counts.get(interfaceToolName(a.interface)) || 0) + 1);
  return [...counts.entries()].map(([tool, count]) => `<tr><td>${esc(tool)}</td><td>${fmtNum(count)}</td></tr>`).join('');
}

function interfaceDetailRows(audit) {
  return audit.map((a, i) => `<tr><td>${i + 1}</td><td>${esc(interfaceToolName(a.interface))}</td><td><code>${esc(a.command_preview || a.interface)}</code></td><td>${esc(paramSummary(a.params))}</td><td>${a.ok ? 'PAID_REQUEST' : 'FAILED'}</td><td>${a.request_consumed ?? '-'}</td><td>${a.request_left ?? '-'}</td><td>-</td><td>-</td><td>${esc(a.timestamp || '-')}</td><td>${fmtMs(a.duration_ms)}</td></tr>`).join('');
}

function chartCard(title, id, type, note) {
  return `<div class="rounded-lg border border-line bg-white p-4"><div class="mb-3 flex items-center justify-between gap-3"><p class="text-sm font-semibold text-ink">${title}</p><span class="rounded-full border border-line bg-slate-50 px-2 py-1 text-xs text-muted">${type}</span></div><div id="${id}" class="chart"></div><p class="mt-2 text-xs text-muted">${note}</p></div>`;
}

function tableBlock(headers, rows, minWidth = 1120) {
  return `<div class="report-table-block mt-4 rounded-lg border border-line"><table class="data-table w-full border-collapse" style="min-width:${minWidth}px"><thead><tr>${headers.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows || `<tr><td colspan="${headers.length}" class="text-muted">暂无数据</td></tr>`}</tbody></table></div>`;
}

function metricCard(label, value, sub = '') {
  return `<div class="rounded-lg border border-line bg-slate-50 p-4" style="min-width:0;overflow:visible"><p class="text-xs font-semibold text-muted">${label}</p><p class="metric-value mt-2"><span class="metric-number" style="display:block;font-size:clamp(15px,1.2vw,20px);line-height:1.15;white-space:nowrap;overflow:visible;text-overflow:clip;letter-spacing:0" title="${esc(value)}">${value}</span></p><p class="mt-1 text-xs text-muted">${sub}</p></div>`;
}

function sectionShell(id, kicker, title, desc, inner) {
  const extra = id === 'reviews'
    ? `<div class="mt-5 grid gap-4 md:grid-cols-2">${chartCard('星级分布','ratingDistributionChart','horizontal_bar','来自已采集评论样本；无评论样本时显示为空。')}${chartCard('评论主题提及','reviewTopicMentionChart','horizontal_bar','提及次数仅统计已采集评论样本中的规则命中，不外推为整体评论分布。')}</div>`
    : '';
  return `<section id="${id}" class="rounded-lg border border-line bg-white p-6 shadow-panel"><p class="text-xs font-bold uppercase tracking-wide text-brand">${kicker}</p><h2 class="mt-1 text-2xl font-semibold text-ink">${title}</h2><p class="mt-2 text-sm leading-6 text-muted">${desc}</p>${extra}${inner}</section>`;
}

function renderExactHtml(d) {
  const jsData = JSON.stringify(d).replace(/</g, '\\u003c');
  const own = d.asin_snapshots.find(p => p.role === 'own') || d.asin_snapshots[0] || {};
  const riskEvents = d.events.filter(e => e.level === 'high' || e.level === 'medium');
  const oppEvents = d.events.filter(e => /机会|关键词/i.test(e.type));
  const heroActions = d.action_items.slice(0, 4).map(a => `<div class="rounded-lg border border-slate-700 bg-slate-900 p-4"><p class="text-sm font-bold text-white">${esc(a.priority)} · ${esc(a.reason.split('：')[0] || '复核')} · ${esc((a.reason.match(/[A-Z0-9]{10}/) || [own.asin || '-'])[0])}</p><p class="mt-2 text-sm leading-6 text-slate-300">${esc(a.reason)}</p><p class="mt-2 text-sm leading-6 text-slate-300">${esc(a.action)}</p></div>`).join('');
  const eventColumns = [
    ['风险变化', riskEvents, '建议优先复核原因，并判断是否需要处理。'],
    ['机会变化', oppEvents, '可作为价格、广告或新增监控的参考。'],
    ['价格、排名与卖家', d.events.filter(e => /价格|促销|卖家|BSR|排名/.test(e.type + e.detail)), '价格、排名或卖家变化可能影响销量和转化。'],
    ['Listing 调整', d.events.filter(e => /Listing|图片|标题|视频|A\+/.test(e.type + e.detail)), '标题、五点、图片、变体或内容资产发生变化。'],
    ['关键词覆盖', d.events.filter(e => /关键词/.test(e.type + e.detail)), '流量词数量或结构发生变化。']
  ].map(([title, events, note]) => `<div class="rounded-lg border border-line bg-slate-50 p-4"><div class="flex items-center justify-between gap-3"><p class="text-sm font-bold text-ink">${title}</p><span class="rounded-full border border-line bg-white px-2 py-1 text-xs font-bold text-muted">${events.length}</span></div><p class="mt-2 text-xs leading-5 text-muted">${note}</p>${events.slice(0, 3).map(e => `<div class="mt-3 border-t border-line pt-3 text-xs leading-5 text-slate-700"><b>${esc(e.level)} · ${esc(e.asin)}</b><br>${esc(e.type)}：${esc(e.detail)}</div>`).join('') || '<div class="mt-3 border-t border-line pt-3 text-xs leading-5 text-muted">暂无</div>'}</div>`).join('');
  const watchCards = d.asin_snapshots.map(p => `<div class="asin-watch-card rounded-lg border border-line bg-white p-4"><div class="flex gap-3"><div class="inline-flex h-20 w-20 shrink-0 items-center justify-center rounded-md border border-line bg-white p-2">${p.image ? `<img class="max-h-full max-w-full object-contain" src="${esc(p.image)}" alt="${esc(p.asin)}主图">` : '<span class="text-xs text-muted">无图</span>'}</div><div class="min-w-0"><p class="truncate text-sm font-bold text-ink"><a class="text-brand hover:underline" href="${asinUrl(p.asin)}" target="_blank" rel="noopener">${esc(p.asin)}</a></p><p class="mt-1 text-xs text-muted">${roleLabel(p.role)} · ${esc(p.brand || '-')}</p><p class="asin-card-title mt-2 text-xs leading-5 text-muted">${esc(p.title || '未获取标题')}</p></div></div><div class="asin-card-metrics mt-4 grid gap-2 md:grid-cols-3">${metricCard('价格', fmtMoney(p.price))}${metricCard('BSR', fmtNum(p.bsr))}${metricCard('估算销量', fmtNum(p.monthly_sales))}${metricCard('评分', fmtRating(p.rating))}${metricCard('Review', fmtNum(p.review_count))}${metricCard('流量词', fmtNum(p.traffic_keywords_count))}</div><div class="mt-3 flex flex-wrap gap-2"><span class="rounded-full border border-line bg-slate-50 px-2 py-1 text-xs text-muted">事件 ${d.events.filter(e => e.asin === p.asin).length}</span><span class="rounded-full border border-line bg-slate-50 px-2 py-1 text-xs text-muted">风险 ${d.events.filter(e => e.asin === p.asin && e.level === 'high').length}</span></div></div>`).join('');
  const actionRows = d.action_items.map(a => `<tr><td>${esc(a.priority)}</td><td>${esc(a.reason.split('：')[0] || '复核')}</td><td>${esc(a.reason.match(/[A-Z0-9]{10}/)?.[0] || '-')}</td><td>${esc(a.reason)}</td><td>${esc(a.action)}</td></tr>`).join('');
  const asinRows = d.asin_snapshots.map(p => `<tr><td><div class="inline-flex h-20 w-20 items-center justify-center rounded-md border border-line bg-white p-2">${p.image ? `<img class="max-h-full max-w-full object-contain" src="${esc(p.image)}" alt="${esc(p.asin)}主图">` : '<span class="text-xs text-muted">无图</span>'}</div></td><td>${roleLabel(p.role)}</td><td><a class="font-medium text-brand hover:underline" href="${asinUrl(p.asin)}" target="_blank" rel="noopener"><strong class="metric-emphasis">${esc(p.asin)}</strong></a></td><td>${esc(p.brand || '-')}</td><td><strong class="metric-emphasis">${fmtMoney(p.price)}</strong></td><td><strong class="metric-emphasis">${couponAfterDisplay(p)}</strong></td><td>${fmtNum(p.bsr)}</td><td><strong class="metric-emphasis">${fmtNum(p.monthly_sales)}</strong></td><td>${fmtRating(p.rating)}</td><td>${fmtNum(p.rating_count)}</td><td><strong class="metric-emphasis">${fmtNum(p.review_count)}</strong></td><td>${fmtNum(p.traffic_keywords_count)}</td><td>${fmtNum(p.ad_keywords_count)}</td><td>${fmtNum(p.seller_count)}</td><td>${p.has_aplus ? '有' : '无'}</td><td>${p.has_video ? '有' : '无'}</td><td>${esc(productTag(p))}</td></tr>`).join('');
  const compareRowsExact = d.asin_snapshots.filter(p => p.role !== 'own').map(p => `<tr><td><strong class="metric-emphasis">${esc(own.asin || '-')}</strong></td><td><strong class="metric-emphasis">${esc(p.asin)}</strong></td><td><strong class="metric-emphasis">${signedMoney((num(p.price) ?? 0) - (num(own.price) ?? 0))}</strong></td><td>${signedNum((num(p.monthly_sales) ?? 0) - (num(own.monthly_sales) ?? 0))}</td><td>${signedNum((num(p.bsr) ?? 0) - (num(own.bsr) ?? 0))}</td><td>${signedNum((num(p.rating) ?? 0) - (num(own.rating) ?? 0))}</td><td>${signedNum((num(p.traffic_keywords_count) ?? 0) - (num(own.traffic_keywords_count) ?? 0))}</td><td>${esc(productTag(p))}</td></tr>`).join('');
  const trendEventRows = d.events.map(e => `<tr><td>${esc(d.meta.report_date)}</td><td>${esc(e.level)}</td><td>${e.level === 'high' ? 'risk' : e.type.includes('机会') ? 'opportunity' : 'neutral'}</td><td>${roleLabel(d.asin_snapshots.find(p => p.asin === e.asin)?.role)}</td><td><strong class="metric-emphasis">${esc(e.asin)}</strong></td><td>${esc(e.type)}</td><td>${esc(e.detail)}</td></tr>`).join('');
  const reviewSampleRows = (d.review_voc || []).slice(0, 30).map(r => `<tr><td><strong class="metric-emphasis">${esc(r.asin)}</strong></td><td>${fmtRating(r.star)}</td><td>${esc(r.title || '-')}</td><td>${esc(r.body || '-')}</td><td>${r.vp ? 'VP' : '-'}</td></tr>`).join('');
  const audit = d.request_audit || [];
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ASIN 竞品监控报告</title><script src="https://cdn.jsdelivr.net/npm/echarts@5/dist/echarts.min.js"></script><script src="https://cdn.jsdelivr.net/npm/lucide@latest/dist/umd/lucide.min.js"></script><style>${exactCss()}</style></head><body><div class="report-watermark" aria-hidden="true"></div><div class="min-h-screen"><header class="report-header sticky top-0 z-40 border-b border-line bg-white/92 backdrop-blur no-print"><div class="mx-auto flex max-w-[1500px] items-center justify-between gap-4 px-5 py-3"><div class="flex min-w-0 items-center gap-3"><div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-ink text-white"><i data-lucide="activity" class="h-5 w-5"></i></div><div class="min-w-0"><p class="truncate text-sm font-semibold text-ink">Amazon 竞品监控报告工具 by kong</p><p class="truncate text-xs text-muted">${esc(d.meta.marketplace)} ｜ 快照：${esc(d.meta.report_date)} ｜ Sorftime CLI + 本地快照差异</p></div></div><span class="rounded-full border border-line bg-white px-3 py-1 text-xs text-muted">${d.meta.demo_mode ? '演示模式' : '真实请求'}</span></div></header><div class="report-layout mx-auto grid max-w-[1500px] grid-cols-1 gap-5 px-5 py-5 lg:grid-cols-[280px_minmax(0,1fr)]"><aside class="no-print hidden lg:block"><nav class="sticky-nav sticky top-[76px] max-h-[calc(100vh-96px)] overflow-y-auto rounded-lg border border-line bg-white p-3 shadow-panel"><p class="px-3 pb-2 text-xs font-bold uppercase tracking-wide text-muted">监控目录</p><div class="space-y-3"><div><p class="mb-1 flex items-center gap-2 px-3 text-xs font-bold text-slate-400"><i data-lucide="layout-dashboard" class="h-3.5 w-3.5"></i>总览</p><a href="#overview" aria-current="true">今日总览</a><a href="#event-board">变化概览</a><a href="#actions">处理建议</a></div><div class="border-t border-line pt-3"><p class="mb-1 flex items-center gap-2 px-3 text-xs font-bold text-brand"><i data-lucide="boxes" class="h-3.5 w-3.5"></i>监控对象</p><a href="#watch-wall">ASIN 监控概览</a><a href="#asin-table">ASIN 明细表</a><a href="#comparison">自有 vs 竞品</a></div><div class="border-t border-line pt-3"><p class="mb-1 flex items-center gap-2 px-3 text-xs font-bold text-brand"><i data-lucide="line-chart" class="h-3.5 w-3.5"></i>证据</p><a href="#trends">趋势证据</a><a href="#keywords">关键词表现</a><a href="#reviews">评论 VOC</a></div><div class="border-t border-line pt-3"><p class="mb-1 flex items-center gap-2 px-3 text-xs font-bold text-brand"><i data-lucide="shield-check" class="h-3.5 w-3.5"></i>审计</p><a href="#method">数据口径</a><a href="#interface-audit">接口审计</a></div></div><div class="mt-4 rounded-md bg-slate-50 p-3 text-xs leading-5 text-muted"><b class="text-ink">阅读主线</b><br>先看竞品今天变了什么，再看自有输赢在哪，最后落到今天要复核或处理的事项。</div></nav></aside><main class="space-y-5"><section id="overview" class="overflow-hidden rounded-lg border border-line bg-white shadow-panel"><div class="grid gap-0 xl:grid-cols-[1.1fr_0.9fr]"><div class="p-7"><div class="mb-4 inline-flex items-center gap-2 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-700"><i data-lucide="radar" class="h-4 w-4"></i>${esc(d.meta.marketplace)} · ASIN 竞品监控</div><h1 class="hero-title max-w-4xl text-ink">Amazon 竞品监控报告工具 by kong</h1><p class="hero-copy mt-4 max-w-3xl text-muted">复刻 Jax 丰哥在跨境写代码的 ASIN 竞品监控报告框架。输入 CLI Token、自有 ASIN、竞品 ASIN 和关键词后，自动采集 Sorftime 数据并形成同版式监控报告。</p><p class="mt-3 text-sm"><a class="text-brand hover:underline" href="http://mp.weixin.qq.com/s?__biz=MzY5MTMyNTQ3Mg==&mid=2247483693&idx=1&sn=439089733fc16d941b2f413ab5c33453&chksm=f525c7bd3ba225a68fd0636cb24b43d67ce2a374315b5a9ecd43dc16baca5953332b9626109b&scene=126&sessionid=1782973447&subscene=227&clicktime=1782973450&enterid=1782973450#rd" target="_blank" rel="noopener">查看原文章：Jax 丰哥在跨境写代码</a></p><div class="mt-6 grid gap-3 md:grid-cols-4 xl:grid-cols-2">${metricCard('待处理事项', `${d.summary.opportunity_count} 项`, 'P0/P1/P2')}${metricCard('风险事件', `${riskEvents.length} 个`, '需复核原因')}${metricCard('机会事件', `${oppEvents.length} 个`, '需结合业务确认')}${metricCard('监控状态', d.meta.demo_mode ? '演示' : '真实', '基于当前快照判断')}</div><div class="mt-5 grid gap-4 md:grid-cols-2"><div class="rounded-lg border border-line bg-slate-50 text-ink p-4"><p class="text-sm font-bold">监控范围</p><p class="mt-1 text-sm leading-6 text-muted">${d.input.own_asins.length} 个自有 ASIN，${d.input.competitor_asins.length} 个竞品 ASIN，快照日期 ${esc(d.meta.report_date)}。</p></div><div class="rounded-lg border border-line bg-slate-50 text-ink p-4"><p class="text-sm font-bold">当前状态</p><p class="mt-1 text-sm leading-6 text-muted">报告来自 ${d.meta.demo_mode ? '演示数据' : 'Sorftime CLI 真实请求'}，接口消耗 ${d.summary.total_request_consumed || '-'} 次，CLI 运行 ${fmtMs(d.summary.total_duration_ms)}。</p></div></div></div><div class="bg-ink p-7 text-white"><p class="text-xs font-bold uppercase tracking-wide text-emerald-300">今日处理</p><h2 class="mt-1 text-2xl font-semibold">优先复核事项</h2><p class="mt-3 text-sm leading-6 text-slate-300">建议结合库存、广告、订单和利润数据复核；本页只回答竞品监控层面的变化与差距。</p><div class="mt-5 space-y-3">${heroActions || '<div class="rounded-lg border border-slate-700 bg-slate-900 p-4 text-slate-300">暂无优先复核事项</div>'}</div></div></div></section>${sectionShell('event-board','01 变化概览','今日变化概览','以下事件由当前快照与最近一次历史快照比对生成。首次基线仅记录纳入监控，不代表竞品发生实际变化。', `<div class="mt-5 grid gap-4 md:grid-cols-5">${eventColumns}</div>`)}${sectionShell('watch-wall','02 ASIN 概览','ASIN 监控概览','按 ASIN 汇总当前价格、BSR、估算销量、评分、评论和关键词覆盖，便于快速查看自有产品与竞品状态。主图来自 Sorftime CLI 返回的真实商品图，点击可放大。', `<div class="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-4">${watchCards}</div>`)}${sectionShell('actions','03 处理建议','处理建议','将变化事件转成运营动作，便于今天直接复核。', tableBlock(['优先级','动作类型','对象','触发原因','建议动作'], actionRows, 980))}${sectionShell('asin-table','04 ASIN 明细','ASIN 监控列表','汇总自有与竞品的当前状态，包括价格、BSR、估算销量、评分评论、关键词和 Listing 资产。', tableBlock(['主图','角色','ASIN','品牌','价格','Coupon 后','BSR','估算销量','评分','Rating','Review','流量词','广告词','卖家数','A+','视频','标签'], asinRows, 1680))}${sectionShell('comparison','05 对比分析','自有 ASIN vs 竞品','从价格、销量、BSR、评分和关键词覆盖等维度对比自有 ASIN 与竞品差距。', `<div class="mt-5 grid gap-4 md:grid-cols-2">${chartCard('价格带对比','priceBandCompareChart','horizontal_bar','截面图，按当前价格或券后到手价排序；用于判断自有 ASIN 处于价格带的哪个位置。')}${chartCard('估算月销量对比','salesVolumeCompareChart','horizontal_bar','销量为 Sorftime 估算口径，不等同于 Amazon 后台真实订单。')}${chartCard('BSR 截面对比','bsrSnapshotCompareChart','horizontal_bar','BSR 越小越好；排序按当前 BSR 从优到弱排列。')}${chartCard('Coupon 力度对比','couponDiscountCompareChart','horizontal_bar','折扣率=(当前价格-券后到手价)/当前价格。')}${chartCard('Listing 资产覆盖','listingAssetCoverageChart','bar','A+=35 分、视频=25 分、每个变体 4 分封顶 40 分。')}${chartCard('Buybox / 卖家数对比','buyboxSellerCompareChart','bar','卖家数用于监控 Buybox 稳定性。')}${chartCard('口碑壁垒散点','ratingReviewMoatChart','scatter','右上代表评论厚度与评分同时较强。')}</div>${tableBlock(['自有 ASIN','竞品 ASIN','价格差','销量差','BSR 差','评分差','流量词差','竞品标签'], compareRowsExact, 1120)}<p class="mt-2 text-xs text-muted">价格差、销量差、流量词差均为竞品减自有；BSR 差为数值差，越小通常越好。</p>`)}${sectionShell('trends','06 趋势证据','趋势与事件','优先使用 Sorftime ProductRequest trend=1 的近 15 天趋势；缺失时回退到本地每日快照。', `<div class="mt-5 grid gap-4 md:grid-cols-2">${chartCard('价格趋势','priceTrendChart','line','来自 Sorftime ProductRequest trend=1 返回的近 15 天价格趋势；缺失点为空。')}${chartCard('BSR 趋势','bsrTrendChart','line','Y 轴已反转，越靠上排名越好。')}${chartCard('估算日销量趋势','salesTrendChart','line','销量为估算口径，不等同于真实订单。')}${chartCard('评分趋势','ratingTrendChart','line','真实趋势不足时按当前快照生成确定性序列。')}${chartCard('Review 数趋势','reviewTrendChart','line','用于观察口碑厚度增长。')}${chartCard('今日事件结构','eventStructureChart','pie','按风险、机会、记录三类聚合今日事件。')}</div>${tableBlock(['角色','ASIN','趋势区间','价格首尾','价格变化','BSR 首尾','BSR 变化','估算日销量首尾','估算日销量变化'], trendRows(d), 1180)}${tableBlock(['日期','严重度','方向','角色','ASIN','类型','事件摘要'], trendEventRows, 1180)}`)}${sectionShell('keywords','07 关键词表现','关键词表现','汇总 ASIN 级关键词覆盖、竞品覆盖但自有缺失的词，以及核心词搜索漏斗近似。', `<div class="mt-5 grid gap-4 md:grid-cols-2">${chartCard('关键词覆盖对比','keywordCoverageCompareChart','bar','来自 ASINRequestKeywordv2 聚合；自然词按 SearchPosition 非空近似，广告词按 AdPosition 非空近似。')}${chartCard('关键词机会矩阵','keywordOpportunityMatrixChart','scatter','高搜索量且排名偏后的词优先复核广告与 Listing 覆盖。')}${chartCard('核心词 SOV 近似','keywordSovApproxChart','horizontal_bar','近似 SOV：用 ASIN 关键词自然位/广告位覆盖占比估算。')}</div>${tableBlock(['角色','ASIN','全部流量词','自然词','广告词','关联流量份额'], keywordCoverageRows(d.asin_snapshots), 1120)}${tableBlock(['关键词','覆盖竞品数','判断','建议'], keywordMissingRows(d), 1120)}${tableBlock(['关键词','搜索量','CPC','商品数','供需近似','来源'], keywordMetricRows(d), 1120)}`)}${sectionShell('reviews','08 评论 VOC','评论与 VOC','基于评论样本归纳好评主题、差评主题和产品改进线索。', `${tableBlock(['ASIN','1星占比','2星占比','3星占比','4星占比','5星占比'], reviewDistributionRows(d), 1040)}${tableBlock(['方向','归纳点','提及评论数','代表评论'], vocTopicRows(d), 1040)}${tableBlock(['ASIN','星级','标题','内容摘要','标识'], reviewSampleRows, 1040)}`)}${sectionShell('method','09 数据口径','数据口径','本报告基于 Sorftime CLI 响应和本地每日快照生成。销量、销售额、BSR、关键词和评论均以第三方口径为准，不等同于 Amazon 后台真实订单、广告或利润数据。', `<div class="mt-5 grid gap-4 md:grid-cols-2"><div class="rounded-lg border border-line bg-slate-50 text-ink p-4"><p class="text-sm font-bold">当前快照</p><p class="mt-1 text-sm leading-6 text-muted">价格、Coupon、BSR、评分评论、Listing 资产、卖家数和关键词覆盖来自当日采集。</p></div><div class="rounded-lg border border-line bg-slate-50 text-ink p-4"><p class="text-sm font-bold">变更事件</p><p class="mt-1 text-sm leading-6 text-muted">标题、五点、图片、变体、卖家、价格和关键词变化由本地快照差异生成。</p></div></div>`)}${sectionShell('interface-audit','10 接口审计','Sorftime CLI 接口审计','记录本次报告涉及的 Sorftime CLI 请求、缓存状态、消耗次数和调用时间，便于复核数据来源。', `<div class="mt-5 interface-metric-grid">${metricCard('已记录调用', `${audit.length} 次`, 'manifest.requests')}${metricCard('真实请求', `${audit.filter(a => a.ok).length} 次`, 'PAID_REQUEST')}${metricCard('消耗次数', d.summary.total_request_consumed || '-', 'requestConsumed')}${metricCard('失败请求', `${d.summary.failed_calls} 次`, 'FAILED')}</div><div class="mt-5 interface-audit-grid"><div class="rounded-lg border border-line bg-white p-4"><p class="text-sm font-semibold text-ink">接口调用计次</p><div id="interfaceAuditChart" class="chart mt-3"></div><p class="mt-2 text-xs text-muted">按 Sorftime 逻辑工具统计，每次 CLI 调用都会计入。</p></div><div class="interface-summary-table overflow-auto rounded-lg border border-line"><table class="data-table w-full border-collapse" style="min-width:560px"><thead><tr><th>工具</th><th>次数</th></tr></thead><tbody>${interfaceSummaryRows(audit)}</tbody></table></div></div><div class="mt-4 rounded-lg border border-line"><p class="border-b border-line bg-slate-50 px-4 py-3 text-sm font-semibold text-ink">接口明细计次</p><div class="interface-detail-scroll"><table class="data-table w-full border-collapse" style="min-width:1560px"><thead><tr><th>序号</th><th>工具</th><th>CLI 命令</th><th>参数摘要</th><th>缓存状态</th><th>消耗次数</th><th>剩余次数</th><th>响应文件</th><th>原文件</th><th>调用时间</th><th>运行耗时</th></tr></thead><tbody>${interfaceDetailRows(audit)}</tbody></table></div></div>`)}</main></div></div><script>window.REPORT_DATA=${jsData};${exactChartJs()}if(window.lucide){lucide.createIcons();}</script></body></html>`;
}

function renderMarkdown(d) {
  const lines = [];
  lines.push(`# Amazon ASIN 竞品监控报告`);
  lines.push(`生成时间：${d.meta.generated_at}  市场：${d.meta.marketplace}  数据源：${d.meta.source}`);
  lines.push(`\n## 今日总览\n- 监控 ASIN：${d.summary.asin_count}\n- 变化事件：${d.summary.event_count}\n- 高风险：${d.summary.high_risk_count}\n- 接口调用：${d.summary.audit_count}`);
  lines.push(`\n## 变化概览`);
  d.events.forEach(e => lines.push(`- **${e.type} / ${e.asin}**：${e.detail}；建议：${e.suggestion}`));
  lines.push(`\n## 处理建议`);
  d.action_items.forEach(a => lines.push(`- **${a.priority}** ${a.action}｜依据：${a.reason}｜预期：${a.expected}`));
  lines.push(`\n## ASIN 明细`);
  lines.push(`|角色|ASIN|标题|价格|评分|评论数|BSR|Coupon|月销量|数据状态|`);
  lines.push(`|---|---|---|---:|---:|---:|---:|---|---:|---|`);
  d.asin_snapshots.forEach(p => lines.push(`|${p.role}|${p.asin}|${(p.title||'').replace(/\|/g,'/')}|${fmtMoney(p.price)}|${fmtRating(p.rating)}|${p.review_count ?? ''}|${p.bsr ?? ''}|${p.coupon ?? ''}|${p.monthly_sales ?? ''}|${(p.data_status || 'OK').replace(/\|/g,'/')}|`));
  lines.push(`\n## 关键词表现`);
  d.keyword_gap.forEach(k => lines.push(`- ${k.asin} / ${k.keyword}: 自然位 ${k.organic_rank ?? '-'}，广告位 ${k.ad_rank ?? '-'}，搜索量 ${k.search_volume ?? '-'}，状态 ${k.data_status || 'OK'}`));
  lines.push(`\n## 接口审计\n接口调用 ${d.request_audit.length} 次，失败 ${d.summary.failed_calls} 次。`);
  lines.push(`总消耗次数：${d.summary.total_request_consumed || '-'}，CLI 总运行时间：${fmtMs(d.summary.total_duration_ms)}`);
  d.request_audit.forEach(a => lines.push(`- ${a.interface}: 消耗 ${a.request_consumed ?? '-'}，开始 ${a.timestamp || '-'}，结束 ${a.ended_at || '-'}，耗时 ${fmtMs(a.duration_ms)}，状态 ${a.ok ? 'OK' : 'FAIL'}`));
  d.request_audit.filter(a => !a.ok).slice(0, 20).forEach(a => lines.push(`- ${a.interface}: ${auditError(a) || '未返回错误摘要'}`));
  return lines.join('\n');
}

function css() { return `:root{--bg:#f6f8fb;--card:#fff;--text:#172033;--muted:#637083;--line:#dfe8f2;--green:#0f8a6a;--red:#b42318;--amber:#b54708;--ink:#111827}*{box-sizing:border-box}body{margin:0;background:linear-gradient(180deg,#f7f9fc 0%,#eef3f7 100%);color:var(--text);font:14px/1.72 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",Arial,sans-serif;font-variant-numeric:tabular-nums}.report-header{position:sticky;top:0;z-index:30;background:rgba(255,255,255,.92);border-bottom:1px solid var(--line);backdrop-filter:blur(10px);padding:12px 28px}.report-header div{max-width:1480px;margin:0 auto;display:flex;justify-content:space-between;gap:16px}.report-header span{color:var(--muted)}.report-layout{display:grid;grid-template-columns:240px minmax(0,1fr);gap:22px;max-width:1480px;margin:0 auto;padding:22px}aside{position:sticky;top:74px;align-self:start;max-height:calc(100vh - 96px);background:white;border:1px solid var(--line);border-radius:14px;padding:18px;overflow:auto;box-shadow:0 12px 30px rgba(17,24,39,.04)}aside .brand{font-size:20px;font-weight:800;margin-bottom:16px;color:var(--ink)}aside a{display:block;color:#334155;text-decoration:none;padding:9px 10px;border-radius:8px;margin:3px 0}aside a:hover{background:#f1f5f9;color:#0f172a}.reading-line{margin-top:14px;border-radius:8px;background:#f8fafc;padding:12px;color:var(--muted);font-size:12px;line-height:1.6}main{min-width:0}.hero,section{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:26px;margin-bottom:20px;box-shadow:0 12px 30px rgba(17,24,39,.04)}.hero{display:grid;grid-template-columns:1.1fr .9fr;gap:24px;background:#fff}h1{font-size:34px;line-height:1.15;margin:10px 0;font-weight:750;letter-spacing:0}h2{font-size:24px;line-height:1.25;margin:0 0 18px;font-weight:750;letter-spacing:0}.section-kicker{color:#0f8a6a;font-size:12px;font-weight:800;letter-spacing:0;text-transform:uppercase;margin:0 0 6px}.tag{display:inline-block;background:#e7fbf3;color:#087455;border:1px solid #b8ead7;padding:4px 10px;border-radius:999px;font-weight:700}.kpis{display:grid;grid-template-columns:repeat(2,1fr);gap:14px}.kpis div,.watch-grid div,.method-grid div{background:#f8fafc;border:1px solid var(--line);border-radius:10px;padding:16px}.kpis b{display:block;font-size:28px;line-height:1.15}.kpis span,.watch-grid span,.muted{color:var(--muted)}.small-note{font-size:12px;margin-top:8px}.mt-block{margin-top:16px}.watch-grid,.method-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px}.watch-grid b{display:block;font-size:18px;word-break:break-word}.method-grid b{display:block;margin-bottom:6px}.method-grid p{margin:0;color:var(--muted)}code{border-radius:4px;background:#f1f5f9;padding:1px 5px;color:#0f172a;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.92em}.report-table-block{max-height:460px;overflow:auto;border:1px solid var(--line);border-radius:10px;background:white}.audit-scroll{max-height:560px}.data-table{width:100%;min-width:980px;border-collapse:collapse;background:white}.audit-table{min-width:1480px}.data-table th,.data-table td{padding:12px 13px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}.data-table th{position:sticky;top:0;z-index:1;background:#f8fafc;color:#475569;font-size:12px;font-weight:750}.data-table td{font-size:13px}.asin-table{min-width:1680px}.title-cell{min-width:300px;max-width:520px}.metric-emphasis{color:#17202a;font-weight:800;white-space:nowrap}.status-ok{display:inline-flex;border-radius:999px;background:#ecfdf5;color:#087455;border:1px solid #bbf7d0;padding:2px 8px;font-weight:750}.status-warn{display:inline-flex;border-radius:999px;background:#fff7ed;color:#b54708;border:1px solid #fed7aa;padding:2px 8px;font-weight:750;max-width:360px;white-space:normal}.events{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px}.event{border:1px solid var(--line);border-left:5px solid var(--green);border-radius:12px;padding:16px;background:#fff}.event.high{border-left-color:var(--red)}.event.medium{border-left-color:var(--amber)}.event span{display:block;color:var(--muted);font-size:12px}.event small{color:#475569}.chartgrid{display:grid;grid-template-columns:repeat(2,minmax(300px,1fr));gap:16px}.chartgrid>div{height:340px;border:1px solid var(--line);border-radius:12px;background:white}.reviews{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px}.reviews article{border:1px solid var(--line);border-radius:12px;padding:16px;background:white}.reviews h3{font-size:15px;margin:8px 0}.empty{padding:24px;border:1px dashed var(--line);border-radius:12px;color:var(--muted);background:#fafafa}@media(max-width:980px){.report-layout{display:block;padding:14px}aside{position:static;max-height:none;margin-bottom:14px}.hero{grid-template-columns:1fr}.chartgrid{grid-template-columns:1fr}.data-table{font-size:12px;min-width:900px}}@media print{.report-header,aside{display:none}.report-layout{display:block;padding:0}.hero,section{box-shadow:none;break-inside:avoid}.chartgrid>div{height:280px}.report-table-block{max-height:none;overflow:visible}}`; }
function chartJs() { return `function draw(metric,id,title){const el=document.getElementById(id);if(!el)return;const data=window.REPORT_DATA.trends.filter(x=>x.metric===metric);const asins=[...new Set(data.map(x=>x.asin))];const dates=[...new Set(data.map(x=>x.date))];const series=asins.map(a=>({name:a,type:'line',smooth:true,data:dates.map(dt=>{const r=data.find(x=>x.asin===a&&x.date===dt);return r?r.value:null})}));echarts.init(el).setOption({title:{text:title,left:16,top:12,textStyle:{fontSize:14}},tooltip:{trigger:'axis'},legend:{top:40},grid:{left:48,right:18,bottom:36,top:78},xAxis:{type:'category',data:dates},yAxis:{type:'value'},series});}function drawBar(id,title,field){const el=document.getElementById(id);if(!el)return;const ps=window.REPORT_DATA.asin_snapshots;echarts.init(el).setOption({title:{text:title,left:16,top:12,textStyle:{fontSize:14}},tooltip:{},grid:{left:55,right:20,bottom:50,top:60},xAxis:{type:'category',data:ps.map(p=>p.asin),axisLabel:{rotate:25}},yAxis:{type:'value'},series:[{type:'bar',data:ps.map(p=>p[field]||0)}]});}drawBar('priceCompareChart','价格对比','price');drawBar('reviewChart','评论数对比','review_count');draw('price','priceChart','价格趋势');draw('bsr','bsrChart','BSR 趋势');draw('sales','salesChart','销量趋势');`; }

function exactCss() { return `:root{--bg:#f5f7fb;--ink:#0f172a;--muted:#64748b;--line:#e2e8f0;--brand:#047857;--brand-soft:#ecfdf5;--panel:0 10px 28px rgba(15,23,42,.06)}*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:#f5f7fb;color:var(--ink);font:14px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",Arial,sans-serif;font-variant-numeric:tabular-nums}.min-h-screen{min-height:100vh}.report-header{position:sticky;top:0;z-index:40;background:rgba(255,255,255,.92);backdrop-filter:blur(10px);border-bottom:1px solid var(--line)}.mx-auto{margin-left:auto;margin-right:auto}.max-w-\\[1500px\\]{max-width:1500px}.grid{display:grid}.flex{display:flex}.hidden{display:none}.items-center{align-items:center}.items-start{align-items:flex-start}.justify-between{justify-content:space-between}.gap-2{gap:8px}.gap-3{gap:12px}.gap-4{gap:16px}.gap-5{gap:20px}.space-y-3>*+*{margin-top:12px}.space-y-5>*+*{margin-top:20px}.min-w-0{min-width:0}.shrink-0{flex-shrink:0}.overflow-hidden{overflow:hidden}.overflow-auto{overflow:auto}.overflow-y-auto{overflow-y:auto}.truncate{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.sticky{position:sticky}.top-0{top:0}.top-\\[76px\\]{top:76px}.max-h-\\[calc\\(100vh-96px\\)\\]{max-height:calc(100vh - 96px)}.px-2{padding-left:8px;padding-right:8px}.px-3{padding-left:12px;padding-right:12px}.px-4{padding-left:16px;padding-right:16px}.px-5{padding-left:20px;padding-right:20px}.py-1{padding-top:4px;padding-bottom:4px}.py-2{padding-top:8px;padding-bottom:8px}.py-3{padding-top:12px;padding-bottom:12px}.py-5{padding-top:20px;padding-bottom:20px}.p-2{padding:8px}.p-3{padding:12px}.p-4{padding:16px}.p-6{padding:24px}.p-7{padding:28px}.pt-3{padding-top:12px}.pb-2{padding-bottom:8px}.mt-1{margin-top:4px}.mt-2{margin-top:8px}.mt-3{margin-top:12px}.mt-4{margin-top:16px}.mt-5{margin-top:20px}.mt-6{margin-top:24px}.mb-1{margin-bottom:4px}.mb-3{margin-bottom:12px}.mb-4{margin-bottom:16px}.rounded-md{border-radius:6px}.rounded-lg{border-radius:8px}.rounded-full{border-radius:999px}.border{border:1px solid var(--line)}.border-t{border-top:1px solid var(--line)}.border-b{border-bottom:1px solid var(--line)}.border-line{border-color:var(--line)}.border-emerald-200{border-color:#a7f3d0}.border-slate-700{border-color:#334155}.bg-white{background:#fff}.bg-white\\/92{background:rgba(255,255,255,.92)}.bg-slate-50{background:#f8fafc}.bg-slate-900{background:#0f172a}.bg-ink{background:#0f172a}.bg-emerald-50{background:#ecfdf5}.text-white{color:#fff}.text-ink{color:var(--ink)}.text-muted{color:var(--muted)}.text-brand{color:var(--brand)}.text-emerald-700{color:#047857}.text-emerald-300{color:#6ee7b7}.text-slate-300{color:#cbd5e1}.text-slate-400{color:#94a3b8}.text-slate-700{color:#334155}.text-xs{font-size:12px}.text-sm{font-size:14px}.text-2xl{font-size:24px}.font-medium{font-weight:500}.font-semibold{font-weight:650}.font-bold{font-weight:750}.uppercase{text-transform:uppercase}.tracking-wide{letter-spacing:.04em}.leading-5{line-height:20px}.leading-6{line-height:24px}.shadow-panel{box-shadow:var(--panel)}.w-full{width:100%}.h-3\\.5{height:14px}.w-3\\.5{width:14px}.h-4{height:16px}.w-4{width:16px}.h-5{height:20px}.w-5{width:20px}.h-10{height:40px}.w-10{width:40px}.h-20{height:80px}.w-20{width:80px}.max-h-full{max-height:100%}.max-w-full{max-width:100%}.object-contain{object-fit:contain}.inline-flex{display:inline-flex}.hover\\:underline:hover{text-decoration:underline}.hover\\:bg-slate-50:hover{background:#f8fafc}.sticky-nav a{display:flex;align-items:center;gap:8px;border-radius:6px;padding:8px 12px;color:#334155;text-decoration:none;font-size:14px}.sticky-nav a[aria-current=true],.sticky-nav a:hover{background:#f8fafc;color:#0f172a}.report-layout{grid-template-columns:1fr}.hero-title{font-size:36px;line-height:1.14;font-weight:800;letter-spacing:0;margin:0}.hero-copy{font-size:15px}.metric-value{margin:0}.metric-number{font-size:28px;line-height:1.1;font-weight:800}.metric-unit{margin-left:4px;color:var(--muted);font-size:12px}.metric-emphasis{font-weight:800;color:#111827;white-space:nowrap}.asin-card-title{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}.asin-card-metrics .rounded-md{min-height:72px}.report-table-block{overflow:auto;background:#fff}.top20-parameter-scroll,.interface-detail-scroll{max-height:520px;overflow:auto}.data-table{border-collapse:collapse;background:#fff}.data-table th,.data-table td{padding:11px 12px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}.data-table th{position:sticky;top:0;z-index:1;background:#f8fafc;color:#475569;font-size:12px;font-weight:800}.data-table td{font-size:13px}.chart{height:300px;min-height:300px}.interface-metric-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:16px}.interface-audit-grid{display:grid;grid-template-columns:minmax(0,1fr) 360px;gap:16px}.text-muted{color:var(--muted)}a{color:inherit}code{display:inline-block;max-width:560px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;border-radius:4px;background:#f1f5f9;padding:2px 5px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px}.report-watermark{display:none}@media(min-width:768px){.md\\:grid-cols-2{grid-template-columns:repeat(2,minmax(0,1fr))}.md\\:grid-cols-3{grid-template-columns:repeat(3,minmax(0,1fr))}.md\\:grid-cols-4{grid-template-columns:repeat(4,minmax(0,1fr))}.md\\:grid-cols-5{grid-template-columns:repeat(5,minmax(0,1fr))}.md\\:flex{display:flex}}@media(min-width:1024px){.lg\\:block{display:block}.lg\\:grid-cols-\\[280px_minmax\\(0\\,1fr\\)\\]{grid-template-columns:280px minmax(0,1fr)}}@media(min-width:1280px){.xl\\:grid-cols-2{grid-template-columns:repeat(2,minmax(0,1fr))}.xl\\:grid-cols-4{grid-template-columns:repeat(4,minmax(0,1fr))}.xl\\:grid-cols-\\[1\\.1fr_0\\.9fr\\]{grid-template-columns:1.1fr .9fr}}@media(max-width:900px){.px-5{padding-left:12px;padding-right:12px}.p-7,.p-6{padding:16px}.hero-title{font-size:28px}.interface-metric-grid,.interface-audit-grid{grid-template-columns:1fr}.chart{height:260px}.hidden{display:none!important}}@media print{.no-print,aside,.report-header{display:none!important}.report-layout{display:block;padding:0}.shadow-panel{box-shadow:none}.chart{height:240px}.report-table-block,.interface-detail-scroll{max-height:none;overflow:visible}}`; }

function exactChartJs() { return `(() => {
const d=window.REPORT_DATA||{};const ps=d.asin_snapshots||[];const trends=d.trends||[];const events=d.events||[];const audit=d.request_audit||[];const reviews=d.review_voc||[];
const money=v=>v==null?0:Number(v)||0;const label=p=>(p.role==='own'?'自有 ':'竞品 ')+p.asin+(p.brand?' · '+p.brand:'');
const watchGrid=document.querySelector('#watch-wall .grid');if(watchGrid){watchGrid.style.gridTemplateColumns='repeat('+Math.min(Math.max(ps.length,1),3)+',minmax(0,1fr))';watchGrid.style.width='100%';}document.querySelectorAll('#watch-wall .asin-card-metrics').forEach(g=>{g.style.gridTemplateColumns='repeat(3,minmax(0,1fr))';g.style.gap='10px';});document.querySelectorAll('#watch-wall .asin-card-metrics>div').forEach(c=>{c.style.minHeight='96px';c.style.padding='16px';});
const couponAfter=p=>p.coupon_after_price!=null?money(p.coupon_after_price):money(p.price);
const asset=p=>(p.has_aplus?35:0)+(p.has_video?25:0)+Math.min(40,(Number(p.variation_count)||0)*4);
function chart(id,opt){const el=document.getElementById(id);if(!el||!window.echarts)return;echarts.init(el).setOption(opt);}
function hbar(id,name,values,unit=''){chart(id,{tooltip:{trigger:'axis',valueFormatter:v=>unit?String(v)+unit:v},legend:{top:0},grid:{left:132,right:18,top:34,bottom:22},xAxis:{type:'value'},yAxis:{type:'category',data:ps.map(label),axisLabel:{width:120,overflow:'truncate'}},series:[{name,type:'bar',data:values,itemStyle:{color:'#047857'}}]});}
hbar('priceBandCompareChart','当前价格/券后价',ps.map(p=>couponAfter(p)),'$');
hbar('salesVolumeCompareChart','估算月销量',ps.map(p=>money(p.monthly_sales)),'件');
hbar('bsrSnapshotCompareChart','小类 BSR',ps.map(p=>money(p.bsr)),'位');
hbar('couponDiscountCompareChart','到手价折扣',ps.map(p=>{const price=money(p.price);return price?+((price-couponAfter(p))/price*100).toFixed(1):0}),'%');
chart('listingAssetCoverageChart',{tooltip:{trigger:'axis'},legend:{top:0},grid:{left:45,right:12,top:44,bottom:58},xAxis:{type:'category',data:ps.map(label),axisLabel:{rotate:25,width:82,overflow:'truncate'}},yAxis:{type:'value',max:100},series:[{name:'Listing资产分',type:'bar',data:ps.map(asset),itemStyle:{color:'#0f766e'}}]});
chart('buyboxSellerCompareChart',{tooltip:{trigger:'axis'},legend:{top:0},grid:{left:45,right:12,top:44,bottom:58},xAxis:{type:'category',data:ps.map(label),axisLabel:{rotate:25,width:82,overflow:'truncate'}},yAxis:{type:'value'},series:[{name:'卖家数',type:'bar',data:ps.map(p=>money(p.seller_count)),itemStyle:{color:'#2563eb'}}]});
chart('ratingReviewMoatChart',{tooltip:{formatter:p=>{const v=p.value;return v[3]+'<br/>Review 数：'+v[0]+'<br/>评分：'+v[1]}},legend:{top:0},grid:{left:58,right:24,top:42,bottom:42},xAxis:{name:'Review 数',type:'value'},yAxis:{name:'评分',type:'value',min:0,max:5},series:[{name:'ASIN：Review 数 × 评分',type:'scatter',symbolSize:v=>Math.max(10,Math.min(42,Math.sqrt(v[2]||1))),label:{show:true,formatter:p=>p.value[3],position:'right',fontSize:10},data:ps.map(p=>[money(p.review_count),money(p.rating),money(p.review_count),p.asin]),itemStyle:{color:'#7c3aed'}}]});
function line(id,metric,reverse=false){const rows=trends.filter(t=>t.metric===metric);const dates=[...new Set(rows.map(r=>r.date))];const asins=[...new Set(rows.map(r=>r.asin))];chart(id,{tooltip:{trigger:'axis'},legend:{top:0,type:'scroll'},grid:{left:52,right:18,top:52,bottom:34},xAxis:{type:'category',data:dates},yAxis:{type:'value',inverse:reverse},series:asins.map(a=>({name:a,type:'line',smooth:true,data:dates.map(dt=>{const r=rows.find(x=>x.asin===a&&x.date===dt);return r?r.value:null})}))});}
line('priceTrendChart','price');line('bsrTrendChart','bsr',true);line('salesTrendChart','sales_daily');line('ratingTrendChart','rating');line('reviewTrendChart','review');
const eventCounts={risk:events.filter(e=>e.level==='high'||e.level==='medium').length,opportunity:events.filter(e=>/机会|关键词/.test(e.type||'')).length,record:events.length};chart('eventStructureChart',{tooltip:{},legend:{bottom:0},series:[{name:'事件数',type:'pie',radius:['42%','70%'],data:[{name:'风险',value:eventCounts.risk},{name:'机会',value:eventCounts.opportunity},{name:'记录',value:eventCounts.record}]}]});
chart('keywordCoverageCompareChart',{tooltip:{trigger:'axis'},legend:{top:0},grid:{left:45,right:12,top:44,bottom:58},xAxis:{type:'category',data:ps.map(label),axisLabel:{rotate:25,width:82,overflow:'truncate'}},yAxis:{type:'value'},series:[{name:'自然词',type:'bar',data:ps.map(p=>money(p.organic_keywords_count))},{name:'广告词',type:'bar',data:ps.map(p=>money(p.ad_keywords_count))}]});
chart('keywordOpportunityMatrixChart',{tooltip:{formatter:p=>p.value[2]+'<br/>搜索量：'+p.value[0]+'<br/>自然位：'+p.value[1]},legend:{top:0},grid:{left:58,right:90,top:42,bottom:42},xAxis:{name:'搜索量',type:'value'},yAxis:{name:'自然位',type:'value',inverse:true},series:[{name:'核心词',type:'scatter',label:{show:true,formatter:p=>p.value[2],position:'right',fontSize:10},data:(d.keyword_gap||[]).filter(k=>k.asin===(d.input?.own_asins||[])[0]).map(k=>[money(k.search_volume),money(k.organic_rank)||100,k.keyword]),itemStyle:{color:'#dc2626'}}]});
const sovSeries=[{name:'自然词占比',field:'organic_keywords_count',color:'#047857'},{name:'广告词占比',field:'ad_keywords_count',color:'#2563eb'}].map(s=>({name:s.name,type:'bar',stack:'sov',data:ps.map(p=>{const total=money(p.organic_keywords_count)+money(p.ad_keywords_count);return total?+(money(p[s.field])/total*100).toFixed(1):0}),itemStyle:{color:s.color}}));
chart('keywordSovApproxChart',{tooltip:{trigger:'axis',valueFormatter:v=>v+'%'},legend:{top:0},grid:{left:132,right:18,top:44,bottom:22},xAxis:{type:'value',max:100},yAxis:{type:'category',data:ps.map(label),axisLabel:{width:120,overflow:'truncate'}},series:sovSeries});
const byAsin={};reviews.forEach(r=>{byAsin[r.asin]=byAsin[r.asin]||[0,0,0,0,0];const s=Math.max(1,Math.min(5,Math.round(money(r.star))));byAsin[r.asin][s-1]++});chart('ratingDistributionChart',{tooltip:{trigger:'axis'},legend:{top:0},grid:{left:132,right:18,top:44,bottom:22},xAxis:{type:'value',max:100},yAxis:{type:'category',data:ps.map(label),axisLabel:{width:120,overflow:'truncate'}},series:[1,2,3,4,5].map(star=>({name:star+'星',type:'bar',stack:'rating',data:ps.map(p=>{const arr=byAsin[p.asin]||[0,0,0,0,0];const total=arr.reduce((a,b)=>a+b,0);return total?+(arr[star-1]/total*100).toFixed(1):0})}))});
const reviewTopics=d.review_topics||[];chart('reviewTopicMentionChart',{tooltip:{trigger:'axis',formatter:p=>{const t=reviewTopics[p[0].dataIndex]||{};return (t.direction||'')+'：'+(t.topic||'')+'<br/>提及评论数：'+(t.count||0)+'<br/>代表评论：'+(t.example||'-')}},legend:{top:0},grid:{left:132,right:18,top:34,bottom:22},xAxis:{type:'value'},yAxis:{type:'category',data:reviewTopics.map(t=>(t.direction||'')+'：'+t.topic),axisLabel:{width:122,overflow:'truncate'}},series:[{name:'提及评论数',type:'bar',data:reviewTopics.map(t=>money(t.count)),itemStyle:{color:p=>(reviewTopics[p.dataIndex]||{}).direction==='差评'?'#dc2626':'#0f766e'}}]});
const toolCounts={};audit.forEach(a=>{let n=a.interface||'unknown';if(/ProductRequest/i.test(n))n='asin_detail';else if(/AsinSalesVolume/i.test(n))n='asin_sales';else if(/ASINRequestKeyword/i.test(n))n='asin_keywords';else if(/ASINKeywordRanking/i.test(n))n='asin_kw_rank';else if(/KeywordExtends/i.test(n))n='keyword_extend';else if(/Keyword/i.test(n))n='keyword_detail';else if(/Review/i.test(n))n='reviews';toolCounts[n]=(toolCounts[n]||0)+1});chart('interfaceAuditChart',{tooltip:{},legend:{top:0},grid:{left:120,right:20,top:34,bottom:24},xAxis:{type:'value'},yAxis:{type:'category',data:Object.keys(toolCounts)},series:[{name:'调用次数',type:'bar',data:Object.values(toolCounts),itemStyle:{color:'#047857'}}]});
const navLinks=[...document.querySelectorAll('.sticky-nav a[href^="#"]')];const sections=navLinks.map(a=>document.querySelector(a.getAttribute('href'))).filter(Boolean);function setCurrent(id){navLinks.forEach(a=>a.removeAttribute('aria-current'));const active=navLinks.find(a=>a.getAttribute('href')==='#'+id);if(active)active.setAttribute('aria-current','true');}if(sections.length&&'IntersectionObserver'in window){const obs=new IntersectionObserver(entries=>{const active=entries.filter(e=>e.isIntersecting).sort((a,b)=>b.intersectionRatio-a.intersectionRatio)[0];if(active)setCurrent(active.target.id);},{rootMargin:'-18% 0px -68% 0px',threshold:[0,.1,.25,.5,.75]});sections.forEach(s=>obs.observe(s));}else{window.addEventListener('scroll',()=>{let current=sections[0];for(const section of sections){if(section.getBoundingClientRect().top<160)current=section;}if(current)setCurrent(current.id);},{passive:true});}
})();`; }

app.post('/api/run', async (req, res) => {
  try {
    const { runId, reportData } = await generateReport(req.body || {});
    res.json({ ok: true, runId, summary: reportData.summary, urls: { html: `/reports/${runId}/amazon_competitor_monitoring_report.html`, markdown: `/reports/${runId}/amazon_competitor_monitoring_report.md`, json: `/reports/${runId}/report_data.json`, csv: `/reports/${runId}/asin_snapshots.csv`, pdf: `/api/report/${runId}/pdf`, zip: `/api/report/${runId}/zip` } });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

function printPdfWithChromium(htmlPath, pdfPath) {
  const candidates = process.platform === 'win32'
    ? ['chrome.exe', 'msedge.exe']
    : ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable'];
  const args = [
    '--headless',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    `--print-to-pdf=${pdfPath}`,
    `file://${htmlPath}`
  ];
  return new Promise((resolve, reject) => {
    let index = 0;
    const tryNext = () => {
      if (index >= candidates.length) return reject(new Error('未找到可用 Chromium/Chrome 命令'));
      const child = spawn(candidates[index++], args, { windowsHide: true });
      let stderr = '';
      child.stderr.on('data', chunk => { stderr += String(chunk); });
      child.on('error', tryNext);
      child.on('close', code => {
        if (code === 0 && fssync.existsSync(pdfPath)) resolve(pdfPath);
        else tryNext();
      });
    };
    tryNext();
  });
}

app.get('/api/report/:id/pdf', async (req, res) => {
  const id = req.params.id.replace(/[^a-zA-Z0-9_]/g, '');
  const htmlPath = path.join(REPORT_ROOT, id, 'amazon_competitor_monitoring_report.html');
  if (!fssync.existsSync(htmlPath)) return res.status(404).send('report not found');
  try {
    const pdfPath = path.join(REPORT_ROOT, id, 'amazon_competitor_monitoring_report.pdf');
    try {
      const { default: puppeteer } = await import('puppeteer');
      const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
      const page = await browser.newPage();
      await page.goto(`file://${htmlPath}`, { waitUntil: 'networkidle0' });
      const pdf = await page.pdf({ format: 'A4', printBackground: true, margin: { top: '12mm', right: '10mm', bottom: '12mm', left: '10mm' } });
      await browser.close();
      await fs.writeFile(pdfPath, pdf);
    } catch {
      await printPdfWithChromium(htmlPath, pdfPath);
    }
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="amazon_competitor_monitoring_report.pdf"');
    res.send(await fs.readFile(pdfPath));
  } catch (e) {
    res.status(501).send(`PDF 生成失败：当前部署环境没有可用浏览器。\n原因：${e.message}\n请先打开 HTML 报告，使用浏览器 Ctrl+P 另存为 PDF。`);
  }
});

app.get('/api/report/:id/zip', async (req, res) => {
  const id = req.params.id.replace(/[^a-zA-Z0-9_]/g, '');
  const dir = path.join(REPORT_ROOT, id);
  if (!fssync.existsSync(dir)) return res.status(404).send('report not found');
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', 'attachment; filename="amazon_competitor_monitoring_outputs.zip"');
  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.pipe(res);
  archive.directory(dir, false);
  archive.finalize();
});

app.get('/health', (_, res) => res.json({ ok: true }));
app.listen(PORT, () => console.log(`Amazon competitor monitor web running on :${PORT}`));
