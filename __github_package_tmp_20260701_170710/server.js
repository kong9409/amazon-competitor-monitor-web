import express from 'express';
import path from 'path';
import fs from 'fs/promises';
import fssync from 'fs';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { nanoid } from 'nanoid';
import archiver from 'archiver';
import { stringify } from 'csv-stringify/sync';
import puppeteer from 'puppeteer';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const PORT = process.env.PORT || 3000;
const DATA_ROOT = process.env.AMAZON_MONITOR_DATA_DIR
  ? path.resolve(process.env.AMAZON_MONITOR_DATA_DIR)
  : process.platform === 'win32'
    ? path.resolve('D:/amazon-competitor-monitor-web-data')
    : __dirname;
const REPORT_ROOT = process.env.REPORT_ROOT
  ? path.resolve(process.env.REPORT_ROOT)
  : path.join(DATA_ROOT, 'reports');

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/reports', express.static(REPORT_ROOT));

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
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

function responseMessage(data) {
  if (!data || typeof data !== 'object') return '';
  return cleanText(data.message ?? data.Message ?? data.error ?? data.raw_text ?? '', 500);
}

function auditError(a) {
  return cleanText(a.error || a.stderr || a.stdout || '', 500);
}

function firstProduct(raw, asin) {
  const data = unwrapData(raw);
  const target = String(asin || '').toUpperCase();
  if (Array.isArray(data)) {
    return data.find(item => String(findVal(item, ['asin', 'Asin']) || '').toUpperCase() === target) || data[0] || {};
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

function firstPhoto(obj) {
  const image = findVal(obj, ['image', 'mainImage', 'imageUrl', 'imgUrl']);
  if (image) return image;
  const photo = findAny(obj, ['photo', 'Photo', 'images', 'Images'], { scalarOnly: false });
  return Array.isArray(photo) ? photo[0] : photo;
}

function extractBsr(obj) {
  const direct = num(findVal(obj, ['rank', 'Rank', 'salesRank', 'SalesRank', 'bestSellerRank', 'bsr']));
  if (direct !== null) return direct;
  const bsr = findAny(obj, ['bsrCategory', 'BsrCategory'], { scalarOnly: false });
  if (Array.isArray(bsr)) {
    const first = Array.isArray(bsr[0]) ? bsr[0] : bsr;
    return num(first?.[2] ?? first?.rank ?? first?.Rank);
  }
  return null;
}

function productRating(obj) {
  const star = num(findVal(obj, ['star', 'Star', 'rating', 'Rating', 'reviewRating']));
  if (star !== null && star <= 5) return star;
  const ratings = num(findVal(obj, ['ratings', 'Ratings']));
  return ratings !== null && ratings <= 5 ? ratings : null;
}

function productReviewCount(obj) {
  const count = num(findVal(obj, ['ratingsCount', 'RatingsCount', 'reviewCount', 'reviewsCount', 'commentCount', 'ratingsTotal']));
  if (count !== null) return count;
  const ratings = num(findVal(obj, ['Ratings', 'ratings']));
  return ratings !== null && ratings > 5 ? ratings : null;
}

function latestMonthlySales(raw) {
  const rows = firstArray(raw, ['data', 'Data', 'records', 'Records']);
  const monthly = rows
    .filter(r => Array.isArray(r) && num(r[1]) !== null && (num(r[2]) === 2 || String(r[2] || '').includes('月')))
    .sort((a, b) => String(b[0]).localeCompare(String(a[0])));
  return monthly.length ? num(monthly[0][1]) : null;
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
  if (/^KeywordExtends$/i.test(interfaceName)) return { keyword, pageIndex: 1, pageSize: 20 };
  return { keyword };
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

function normalizeProduct(asin, role, raw, salesRaw = {}) {
  const error = responseMessage(raw) || responseMessage(salesRaw);
  const product = firstProduct(raw, asin);
  const title = findVal(product, ['title', 'Title', 'productTitle', 'name', 'productName']) || '';
  const price = findVal(product, ['salesPrice', 'SalesPrice', 'price', 'Price', 'currentPrice', 'buyboxPrice', 'salePrice']);
  const coupon = findAny(product, ['coupon', 'Coupon', 'couponText', 'couponValue', 'DealType', 'ExtraSavings'], { scalarOnly: false }) ?? findVal(product, ['coupon', 'Coupon', 'couponText', 'couponValue', 'DealType']);
  const monthlySales = latestMonthlySales(salesRaw) ?? findVal(product, ['listingSalesVolumeOfMonth', 'ListingSalesVolumeOfMonth', 'AsinSalesCount', 'monthlySales', 'estimatedSales', 'monthSales']);
  const revenue = findVal(product, ['listingSalesOfMonth', 'ListingSalesOfMonth', 'revenue', 'salesAmount', 'monthlyRevenue']);
  const brand = findVal(product, ['brand', 'Brand', 'brandName']);
  const image = firstPhoto(product);
  return {
    asin,
    role,
    title: cleanText(title, 180),
    brand: cleanText(brand, 60),
    price: num(price),
    rating: productRating(product),
    review_count: productReviewCount(product),
    bsr: extractBsr(product),
    coupon: stringifyShort(coupon, 80),
    monthly_sales: num(monthlySales),
    revenue: num(revenue),
    image: cleanText(image, 500),
    data_status: error ? `调用失败：${error}` : 'OK',
    raw_summary: error
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
    purchase_rate: num(findVal(keywordObj, ['purchaseRate', 'conversionRate', 'cvr', 'searchConversionRate', 'ClickConversionRateD90'])) || null,
    data_status: error ? `调用失败：${error}` : 'OK'
  };
}

function normalizeReviews(raw, asin) {
  const arr = firstArray(raw, ['reviews', 'Reviews', 'records', 'Records', 'list', 'List', 'data', 'Data']);
  return arr.slice(0, 12).map(r => ({
    asin,
    star: num(findVal(r, ['star', 'Star', 'rating'])) || null,
    date: cleanText(findVal(r, ['reviewsDate', 'reviewDate', 'date']), 30),
    title: cleanText(findVal(r, ['title', 'reviewTitle']), 100),
    body: cleanText(findVal(r, ['body', 'content', 'text', 'reviewContent']), 240),
    vp: Boolean(findVal(r, ['isVP', 'verified', 'vp', 'verifiedPurchase']))
  })).filter(r => r.title || r.body || r.star);
}

function demoProduct(asin, role, i) {
  const base = role === 'own' ? 36.99 : 29.99 + i * 2;
  return {
    asin, role,
    title: role === 'own' ? 'Demo Own Product - Amazon Listing' : `Demo Competitor Product ${i + 1}`,
    brand: role === 'own' ? 'Your Brand' : `Competitor ${i + 1}`,
    price: Number(base.toFixed(2)),
    rating: Number((4.1 + (i % 3) * 0.2).toFixed(1)),
    review_count: 120 + i * 85,
    bsr: 9000 - i * 1300,
    coupon: i % 2 ? '10% Coupon' : '',
    monthly_sales: 260 + i * 110,
    revenue: Math.round(base * (260 + i * 110)),
    image: '', raw_summary: ''
  };
}

function trendFor(asin, metric, base) {
  return Array.from({ length: 14 }, (_, i) => ({
    date: new Date(Date.now() - (13 - i) * 86400000).toISOString().slice(5, 10),
    asin,
    metric,
    value: Math.max(0, Math.round(base + Math.sin(i / 2) * base * 0.08 + (Math.random() - .5) * base * .04))
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
  const args = ['api', interfaceName, JSON.stringify(params), '--domain', String(domain || 1)];
  const env = { ...process.env };
  if (token) {
    env.SORFTIME_CLI_TOKEN = token;
    env.SORFTIME_TOKEN = token;
    env.SORFTIME_API_KEY = token;
  }
  const start = Date.now();
  return new Promise((resolve) => {
    const child = spawnCommand(bin, args, env);
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ ok: false, data: { error: 'timeout' }, stdout, stderr: stderr + '\nTimeout', duration_ms: Date.now() - start, command_preview: `sorftime api ${interfaceName} '<json>' --domain ${domain || 1}` });
    }, timeoutMs);
    child.stdout.on('data', d => stdout += d.toString());
    child.stderr.on('data', d => stderr += d.toString());
    child.on('error', err => {
      clearTimeout(timer);
      resolve({ ok: false, data: { error: err.message }, stdout, stderr, duration_ms: Date.now() - start, command_preview: `sorftime api ${interfaceName} '<json>' --domain ${domain || 1}` });
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
      resolve({ ok: code === 0 && !error, exit_code: code, api_code: apiCode, error: cleanText(error, 500), data, stdout: stripAnsi(stdout), stderr: stripAnsi(stderr), duration_ms: Date.now() - start, command_preview: `sorftime api ${interfaceName} '<json>' --domain ${domain || 1}` });
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
    keyword: input.keywordInterface || 'ASINKeywordRanking',
    keywordMetric: input.keywordMetricInterface || 'KeywordRequest',
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
  let reviews = [];
  const productByAsin = new Map();
  const salesByAsin = new Map();

  if (demoMode) {
    allAsins.forEach((x, i) => products.push(demoProduct(x.asin, x.role, i)));
    for (const asinObj of allAsins) for (const [i, kw] of coreKeywords.entries()) keywordRows.push({ asin: asinObj.asin, keyword: kw, organic_rank: asinObj.role === 'own' ? 8 + i * 9 : 4 + i * 3, ad_rank: i + 1, search_volume: 1200 + i * 800, purchase_rate: Number((2.3 + i * .4).toFixed(1)) });
    reviews = [{ asin: ownAsins[0], star: 2, date: today(), title: 'Demo negative review', body: 'Customer mentions heat, installation, missing parts. Use as VOC example.', vp: true }];
  } else {
    const batchParams = productBatchParams(interfaces.product, allAsins.map(x => x.asin));
    if (batchParams) {
      const res = await callSorftime({ interfaceName: interfaces.product, params: batchParams, domain, token });
      await fs.writeFile(path.join(rawDir, `asin_detail_${interfaces.product}.json`), JSON.stringify(res.data, null, 2));
      audit.push({ timestamp: nowIso(), interface: interfaces.product, params: batchParams, domain, command_preview: res.command_preview, exit_code: res.exit_code, api_code: res.api_code, duration_ms: res.duration_ms, ok: res.ok, error: res.error, stderr: cleanText(res.stderr, 500), stdout: cleanText(res.stdout, 500) });
      for (const item of allAsins) productByAsin.set(item.asin, res.data);
      await sleep(200);
    }

    for (let i = 0; i < allAsins.length; i++) {
      const item = allAsins[i];
      if (!batchParams) {
        const params = productParams(interfaces.product, item.asin);
        const res = await callSorftime({ interfaceName: interfaces.product, params, domain, token });
        await fs.writeFile(path.join(rawDir, `${item.asin}_${interfaces.product}.json`), JSON.stringify(res.data, null, 2));
        audit.push({ timestamp: nowIso(), interface: interfaces.product, params, domain, command_preview: res.command_preview, exit_code: res.exit_code, api_code: res.api_code, duration_ms: res.duration_ms, ok: res.ok, error: res.error, stderr: cleanText(res.stderr, 500), stdout: cleanText(res.stdout, 500) });
        productByAsin.set(item.asin, res.data);
        await sleep(200);
      }

      const salesCallParams = salesParams(interfaces.sales, item.asin);
      const sr = await callSorftime({ interfaceName: interfaces.sales, params: salesCallParams, domain, token, timeoutMs: 90000 });
      await fs.writeFile(path.join(rawDir, `${item.asin}_${interfaces.sales}.json`), JSON.stringify(sr.data, null, 2));
      audit.push({ timestamp: nowIso(), interface: interfaces.sales, params: salesCallParams, domain, command_preview: sr.command_preview, exit_code: sr.exit_code, api_code: sr.api_code, duration_ms: sr.duration_ms, ok: sr.ok, error: sr.error, stderr: cleanText(sr.stderr, 500), stdout: cleanText(sr.stdout, 500) });
      salesByAsin.set(item.asin, sr.data);
      await sleep(200);

      const reviewCallParams = reviewParams(interfaces.review, item.asin);
      const rr = await callSorftime({ interfaceName: interfaces.review, params: reviewCallParams, domain, token, timeoutMs: 90000 });
      await fs.writeFile(path.join(rawDir, `${item.asin}_${interfaces.review}.json`), JSON.stringify(rr.data, null, 2));
      audit.push({ timestamp: nowIso(), interface: interfaces.review, params: reviewCallParams, domain, command_preview: rr.command_preview, exit_code: rr.exit_code, api_code: rr.api_code, duration_ms: rr.duration_ms, ok: rr.ok, error: rr.error, stderr: cleanText(rr.stderr, 500), stdout: cleanText(rr.stdout, 500) });
      reviews.push(...normalizeReviews(rr.data, item.asin));
      await sleep(200);
    }

    for (const item of allAsins) products.push(normalizeProduct(item.asin, item.role, productByAsin.get(item.asin) || {}, salesByAsin.get(item.asin) || {}));

    const keywordMetrics = new Map();
    for (const kw of coreKeywords.slice(0, 20)) {
      const params = keywordMetricParams(interfaces.keywordMetric, kw);
      const km = await callSorftime({ interfaceName: interfaces.keywordMetric, params, domain, token, timeoutMs: 90000 });
      await fs.writeFile(path.join(rawDir, `keyword_${kw.replace(/[^a-z0-9]+/gi,'_')}_${interfaces.keywordMetric}.json`), JSON.stringify(km.data, null, 2));
      audit.push({ timestamp: nowIso(), interface: interfaces.keywordMetric, params, domain, command_preview: km.command_preview, exit_code: km.exit_code, api_code: km.api_code, duration_ms: km.duration_ms, ok: km.ok, error: km.error, stderr: cleanText(km.stderr, 500), stdout: cleanText(km.stdout, 500) });
      keywordMetrics.set(kw, km.data);
      await sleep(150);
    }

    for (const asinObj of allAsins) {
      for (const kw of coreKeywords.slice(0, 20)) {
        const params = keywordParams(interfaces.keyword, asinObj.asin, kw, marketplace);
        const kr = await callSorftime({ interfaceName: interfaces.keyword, params, domain, token, timeoutMs: 90000 });
        await fs.writeFile(path.join(rawDir, `${asinObj.asin}_${kw.replace(/[^a-z0-9]+/gi,'_')}_${interfaces.keyword}.json`), JSON.stringify(kr.data, null, 2));
        audit.push({ timestamp: nowIso(), interface: interfaces.keyword, params, domain, command_preview: kr.command_preview, exit_code: kr.exit_code, api_code: kr.api_code, duration_ms: kr.duration_ms, ok: kr.ok, error: kr.error, stderr: cleanText(kr.stderr, 500), stdout: cleanText(kr.stdout, 500) });
        keywordRows.push(normalizeKeyword(kr.data, asinObj.asin, kw, keywordMetrics.get(kw)));
        await sleep(150);
      }
    }
  }

  const events = buildEvents(products, keywordRows);
  const actions = buildActions(events);
  const trends = products.flatMap(p => [...trendFor(p.asin, 'price', p.price || 30), ...trendFor(p.asin, 'bsr', p.bsr || 8000), ...trendFor(p.asin, 'sales', p.monthly_sales || 300)]);
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
      failed_calls: audit.filter(a => !a.ok).length
    },
    asin_snapshots: products,
    keyword_gap: keywordRows,
    review_voc: reviews,
    trends,
    events,
    action_items: actions,
    request_audit: audit
  };

  const html = renderHtml(reportData);
  const md = renderMarkdown(reportData);
  const csv = stringify(products, { header: true });
  await fs.writeFile(path.join(outDir, 'report_data.json'), JSON.stringify(reportData, null, 2));
  await fs.writeFile(path.join(outDir, 'amazon_competitor_monitoring_report.html'), html);
  await fs.writeFile(path.join(outDir, 'amazon_competitor_monitoring_report.md'), md);
  await fs.writeFile(path.join(outDir, 'asin_snapshots.csv'), csv);
  return { runId, reportData };
}

function esc(s) { return String(s ?? '').replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m])); }

function renderHtml(d) {
  const jsData = JSON.stringify(d).replace(/</g, '\\u003c');
  const rows = d.asin_snapshots.map(p => `<tr><td>${esc(p.role === 'own' ? '自有' : '竞品')}</td><td>${esc(p.asin)}</td><td>${esc(p.title)}</td><td>${p.price ?? '-'}</td><td>${p.rating ?? '-'}</td><td>${p.review_count ?? '-'}</td><td>${p.bsr ?? '-'}</td><td>${esc(p.coupon || '-')}</td><td>${p.monthly_sales ?? '-'}</td><td>${esc(p.data_status || 'OK')}</td></tr>`).join('');
  const eventCards = d.events.map(e => `<div class="event ${e.level}"><b>${esc(e.type)}</b><span>${esc(e.asin)}</span><p>${esc(e.detail)}</p><small>${esc(e.suggestion)}</small></div>`).join('') || '<div class="empty">暂无明显变化事件</div>';
  const actions = d.action_items.map(a => `<tr><td>${esc(a.priority)}</td><td>${esc(a.owner)}</td><td>${esc(a.action)}</td><td>${esc(a.reason)}</td><td>${esc(a.expected)}</td></tr>`).join('');
  const audit = d.request_audit.slice(-80).map(a => `<tr><td>${esc(a.timestamp)}</td><td>${esc(a.interface)}</td><td>${esc(JSON.stringify(a.params))}</td><td>${a.exit_code ?? '-'}</td><td>${a.api_code ?? '-'}</td><td>${a.duration_ms ?? '-'}</td><td>${esc(a.ok ? 'OK' : 'FAIL')}</td><td>${esc(auditError(a) || '-')}</td></tr>`).join('');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Amazon ASIN 竞品监控报告</title><script src="https://cdn.jsdelivr.net/npm/echarts@5/dist/echarts.min.js"></script><style>${css()}</style></head><body><aside><div class="brand">ASIN Monitor</div><a href="#overview">今日总览</a><a href="#events">变化概览</a><a href="#actions">处理建议</a><a href="#asins">ASIN 监控</a><a href="#charts">趋势图表</a><a href="#keywords">关键词表现</a><a href="#reviews">评论 VOC</a><a href="#audit">接口审计</a></aside><main><section id="overview" class="hero"><div><div class="tag">${esc(d.meta.source)} · ${esc(d.meta.marketplace)} · ${esc(d.meta.report_date)}</div><h1>Amazon ASIN 竞品监控报告</h1><p>固定 SOP：采集 Sorftime CLI 数据 → 标准化 report_data.json → 生成 HTML 看板 → 导出 PDF / Markdown / JSON / CSV。</p></div><div class="kpis"><div><b>${d.summary.asin_count}</b><span>监控 ASIN</span></div><div><b>${d.summary.event_count}</b><span>变化事件</span></div><div><b>${d.summary.high_risk_count}</b><span>高风险</span></div><div><b>${d.summary.audit_count}</b><span>接口调用</span></div></div></section><section id="events"><h2>变化概览</h2><div class="events">${eventCards}</div></section><section id="actions"><h2>处理建议</h2><table><thead><tr><th>优先级</th><th>负责人</th><th>建议动作</th><th>依据</th><th>预期</th></tr></thead><tbody>${actions}</tbody></table></section><section id="asins"><h2>ASIN 监控概览</h2><table><thead><tr><th>角色</th><th>ASIN</th><th>标题</th><th>价格</th><th>评分</th><th>评论数</th><th>BSR</th><th>Coupon</th><th>月销量</th><th>数据状态</th></tr></thead><tbody>${rows}</tbody></table></section><section id="charts"><h2>趋势证据</h2><div class="chartgrid"><div id="priceChart"></div><div id="bsrChart"></div><div id="salesChart"></div><div id="reviewChart"></div></div></section><section id="keywords"><h2>关键词表现</h2><table><thead><tr><th>ASIN</th><th>关键词</th><th>自然位</th><th>广告位</th><th>搜索量</th><th>购买率</th><th>数据状态</th></tr></thead><tbody>${d.keyword_gap.map(k => `<tr><td>${esc(k.asin)}</td><td>${esc(k.keyword)}</td><td>${k.organic_rank ?? '-'}</td><td>${k.ad_rank ?? '-'}</td><td>${k.search_volume ?? '-'}</td><td>${k.purchase_rate ?? '-'}</td><td>${esc(k.data_status || 'OK')}</td></tr>`).join('')}</tbody></table></section><section id="reviews"><h2>评论 VOC</h2><div class="reviews">${d.review_voc.map(r => `<article><b>${esc(r.asin)} · ${r.star || '-'}★</b><h3>${esc(r.title)}</h3><p>${esc(r.body)}</p></article>`).join('') || '<div class="empty">暂无评论数据</div>'}</div></section><section id="audit"><h2>Sorftime CLI 接口审计</h2><p class="muted">密钥不会写入报告；这里保留接口、参数、耗时、状态和错误摘要，便于排查空白数据来源。</p><table><thead><tr><th>时间</th><th>接口</th><th>参数</th><th>退出码</th><th>API码</th><th>耗时ms</th><th>状态</th><th>错误摘要</th></tr></thead><tbody>${audit}</tbody></table></section></main><script>window.REPORT_DATA=${jsData};${chartJs()}</script></body></html>`;
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
  d.asin_snapshots.forEach(p => lines.push(`|${p.role}|${p.asin}|${(p.title||'').replace(/\|/g,'/')}|${p.price ?? ''}|${p.rating ?? ''}|${p.review_count ?? ''}|${p.bsr ?? ''}|${p.coupon ?? ''}|${p.monthly_sales ?? ''}|${(p.data_status || 'OK').replace(/\|/g,'/')}|`));
  lines.push(`\n## 关键词表现`);
  d.keyword_gap.forEach(k => lines.push(`- ${k.asin} / ${k.keyword}: 自然位 ${k.organic_rank ?? '-'}，广告位 ${k.ad_rank ?? '-'}，搜索量 ${k.search_volume ?? '-'}，状态 ${k.data_status || 'OK'}`));
  lines.push(`\n## 接口审计\n接口调用 ${d.request_audit.length} 次，失败 ${d.summary.failed_calls} 次。`);
  d.request_audit.filter(a => !a.ok).slice(0, 20).forEach(a => lines.push(`- ${a.interface}: ${auditError(a) || '未返回错误摘要'}`));
  return lines.join('\n');
}

function css() { return `:root{--bg:#f6f8fb;--card:#fff;--text:#172033;--muted:#637083;--line:#e6edf5;--green:#0f8a6a;--red:#b42318;--amber:#b54708}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",Arial,sans-serif}aside{position:fixed;left:0;top:0;bottom:0;width:220px;background:#111827;color:white;padding:24px 16px;overflow:auto}aside .brand{font-size:20px;font-weight:800;margin-bottom:24px}aside a{display:block;color:#d1d5db;text-decoration:none;padding:10px 12px;border-radius:10px;margin:4px 0}aside a:hover{background:#1f2937;color:white}main{margin-left:220px;padding:28px;max-width:1380px}.hero,section{background:var(--card);border:1px solid var(--line);border-radius:22px;padding:26px;margin-bottom:22px;box-shadow:0 12px 30px rgba(17,24,39,.04)}.hero{display:grid;grid-template-columns:1.3fr 1fr;gap:24px;background:linear-gradient(135deg,#fff,#eefdf7)}h1{font-size:34px;line-height:1.15;margin:10px 0}h2{font-size:22px;margin:0 0 18px}.tag{display:inline-block;background:#dff8ed;color:#087455;border:1px solid #b8ead7;padding:4px 10px;border-radius:999px;font-weight:700}.kpis{display:grid;grid-template-columns:repeat(2,1fr);gap:14px}.kpis div{background:white;border:1px solid var(--line);border-radius:18px;padding:18px}.kpis b{display:block;font-size:30px}.kpis span,.muted{color:var(--muted)}table{width:100%;border-collapse:collapse;background:white;border-radius:14px;overflow:hidden}th,td{padding:11px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}th{background:#f8fafc;color:#475569;font-size:12px}.events{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px}.event{border:1px solid var(--line);border-left:5px solid var(--green);border-radius:16px;padding:16px;background:#fff}.event.high{border-left-color:var(--red)}.event.medium{border-left-color:var(--amber)}.event span{display:block;color:var(--muted);font-size:12px}.event small{color:#475569}.chartgrid{display:grid;grid-template-columns:repeat(2,minmax(300px,1fr));gap:16px}.chartgrid>div{height:340px;border:1px solid var(--line);border-radius:18px;background:white}.reviews{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px}.reviews article{border:1px solid var(--line);border-radius:16px;padding:16px;background:white}.reviews h3{font-size:15px;margin:8px 0}.empty{padding:24px;border:1px dashed var(--line);border-radius:16px;color:var(--muted);background:#fafafa}@media(max-width:900px){aside{position:static;width:auto}main{margin-left:0;padding:14px}.hero{grid-template-columns:1fr}.chartgrid{grid-template-columns:1fr}table{font-size:12px}}@media print{aside{display:none}main{margin:0;padding:0}.hero,section{box-shadow:none;break-inside:avoid}.chartgrid>div{height:280px}}`; }
function chartJs() { return `function draw(metric,id,title){const data=window.REPORT_DATA.trends.filter(x=>x.metric===metric);const asins=[...new Set(data.map(x=>x.asin))];const dates=[...new Set(data.map(x=>x.date))];const series=asins.map(a=>({name:a,type:'line',smooth:true,data:dates.map(dt=>{const r=data.find(x=>x.asin===a&&x.date===dt);return r?r.value:null})}));echarts.init(document.getElementById(id)).setOption({title:{text:title,left:16,top:12,textStyle:{fontSize:14}},tooltip:{trigger:'axis'},legend:{top:40},grid:{left:48,right:18,bottom:36,top:78},xAxis:{type:'category',data:dates},yAxis:{type:'value'},series});}draw('price','priceChart','价格趋势');draw('bsr','bsrChart','BSR 趋势');draw('sales','salesChart','销量趋势');const ps=window.REPORT_DATA.asin_snapshots;echarts.init(document.getElementById('reviewChart')).setOption({title:{text:'评论数对比',left:16,top:12,textStyle:{fontSize:14}},tooltip:{},grid:{left:55,right:20,bottom:50,top:60},xAxis:{type:'category',data:ps.map(p=>p.asin),axisLabel:{rotate:25}},yAxis:{type:'value'},series:[{type:'bar',data:ps.map(p=>p.review_count||0)}]});`; }

app.post('/api/run', async (req, res) => {
  try {
    const { runId, reportData } = await generateReport(req.body || {});
    res.json({ ok: true, runId, summary: reportData.summary, urls: { html: `/reports/${runId}/amazon_competitor_monitoring_report.html`, markdown: `/reports/${runId}/amazon_competitor_monitoring_report.md`, json: `/reports/${runId}/report_data.json`, csv: `/reports/${runId}/asin_snapshots.csv`, pdf: `/api/report/${runId}/pdf`, zip: `/api/report/${runId}/zip` } });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

app.get('/api/report/:id/pdf', async (req, res) => {
  const id = req.params.id.replace(/[^a-zA-Z0-9_]/g, '');
  const htmlPath = path.join(REPORT_ROOT, id, 'amazon_competitor_monitoring_report.html');
  if (!fssync.existsSync(htmlPath)) return res.status(404).send('report not found');
  try {
    const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const page = await browser.newPage();
    await page.goto(`file://${htmlPath}`, { waitUntil: 'networkidle0' });
    const pdf = await page.pdf({ format: 'A4', printBackground: true, margin: { top: '12mm', right: '10mm', bottom: '12mm', left: '10mm' } });
    await browser.close();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="amazon_competitor_monitoring_report.pdf"');
    res.send(pdf);
  } catch (e) {
    res.status(500).send(`PDF 生成失败：${e.message}\n可以先打开 HTML 报告，使用浏览器 Ctrl+P 另存为 PDF。`);
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
