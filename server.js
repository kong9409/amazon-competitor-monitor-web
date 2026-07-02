const express = require('express');
const fs = require('fs');
const path = require('path');
const archiver = require('archiver');
const PDFDocument = require('pdfkit');
const sanitize = require('sanitize-filename');

const app = express();
const PORT = process.env.PORT || 3000;
const REPORT_OUTPUT_DIR = process.env.REPORT_OUTPUT_DIR || (
  process.platform === 'win32'
    ? 'D:\\amazon-competitor-monitor-reports'
    : path.join(__dirname, 'reports')
);

const META = {
  author: 'kong',
  title: 'Amazon 竞品监控报告工具 by kong',
  frameworkAttribution: '复刻 Jax 丰哥在跨境写代码的 ASIN 竞品监控报告框架',
  referenceName: 'Jax 丰哥在跨境写代码',
  referenceUrl: 'https://mp.weixin.qq.com/s?__biz=MzY5MTMyNTQ3Mg%3D%3D&chksm=f525c7bd3ba225a68fd0636cb24b43d67ce2a374315b5a9ecd43dc16baca5953332b9626109b&clicktime=1782973450&enterid=1782973450&idx=1&mid=2247483693&scene=126&sessionid=1782973447&sn=439089733fc16d941b2f413ab5c33453&subscene=227'
};

const DEFAULT_KEYWORDS = [
  'power bank',
  'portable charger',
  'power bank with built in cable',
  'fast charging power bank',
  'travel power bank',
  'usb c power bank',
  '10000mah portable charger',
  '20000mah power bank'
];

fs.mkdirSync(REPORT_OUTPUT_DIR, { recursive: true });

app.use(express.json({ limit: '3mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (_req, res) => res.json({ ok: true, author: META.author }));

app.post('/api/generate', async (req, res) => {
  try {
    const input = normalizeInput(req.body || {});
    const reportId = makeReportId(input);
    const reportDir = path.join(REPORT_OUTPUT_DIR, reportId);
    fs.mkdirSync(reportDir, { recursive: true });

    const reportData = buildReportData(input, reportId);
    const html = renderHtmlReport(reportData);
    const markdown = renderMarkdownReport(reportData);
    const asinCsv = renderAsinCsv(reportData);
    const keywordCsv = renderKeywordCsv(reportData);
    const json = JSON.stringify(reportData, null, 2);

    const files = {
      html: `${reportId}.html`,
      markdown: `${reportId}.md`,
      json: `${reportId}.json`,
      asinCsv: `${reportId}_asin.csv`,
      keywordCsv: `${reportId}_keywords.csv`,
      pdf: `${reportId}.pdf`,
      zip: `${reportId}.zip`
    };

    fs.writeFileSync(path.join(reportDir, files.html), html, 'utf8');
    fs.writeFileSync(path.join(reportDir, files.markdown), markdown, 'utf8');
    fs.writeFileSync(path.join(reportDir, files.json), json, 'utf8');
    fs.writeFileSync(path.join(reportDir, files.asinCsv), asinCsv, 'utf8');
    fs.writeFileSync(path.join(reportDir, files.keywordCsv), keywordCsv, 'utf8');
    await renderPdfReport(reportData, path.join(reportDir, files.pdf));
    await renderZip(reportDir, files, path.join(reportDir, files.zip));

    res.json({
      ok: true,
      reportId,
      outputDir: REPORT_OUTPUT_DIR,
      meta: META,
      files: [
        { type: 'html', label: '打开 HTML 报告', url: `/download/${encodeURIComponent(reportId)}/${encodeURIComponent(files.html)}` },
        { type: 'pdf', label: '下载 PDF', url: `/download/${encodeURIComponent(reportId)}/${encodeURIComponent(files.pdf)}` },
        { type: 'markdown', label: '下载 Markdown', url: `/download/${encodeURIComponent(reportId)}/${encodeURIComponent(files.markdown)}` },
        { type: 'json', label: '下载 JSON', url: `/download/${encodeURIComponent(reportId)}/${encodeURIComponent(files.json)}` },
        { type: 'asinCsv', label: '下载 ASIN CSV', url: `/download/${encodeURIComponent(reportId)}/${encodeURIComponent(files.asinCsv)}` },
        { type: 'keywordCsv', label: '下载关键词 CSV', url: `/download/${encodeURIComponent(reportId)}/${encodeURIComponent(files.keywordCsv)}` },
        { type: 'zip', label: '下载全部 ZIP', url: `/download/${encodeURIComponent(reportId)}/${encodeURIComponent(files.zip)}` }
      ]
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ ok: false, message: error.message || '生成报告失败' });
  }
});

app.get('/download/:reportId/:fileName', (req, res) => {
  const reportId = sanitize(req.params.reportId || '');
  const fileName = sanitize(req.params.fileName || '');
  const filePath = path.join(REPORT_OUTPUT_DIR, reportId, fileName);
  if (!filePath.startsWith(path.join(REPORT_OUTPUT_DIR, reportId)) || !fs.existsSync(filePath)) {
    return res.status(404).send('文件不存在，请重新生成报告。');
  }

  if (fileName.endsWith('.html')) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.sendFile(filePath);
  }
  if (fileName.endsWith('.pdf')) {
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`);
    return res.sendFile(filePath);
  }
  return res.download(filePath, fileName);
});

app.get('/api/defaults', (_req, res) => {
  res.json({ keywords: DEFAULT_KEYWORDS, meta: META });
});

app.listen(PORT, () => {
  console.log(`${META.title} started on port ${PORT}`);
  console.log(`Report output dir: ${REPORT_OUTPUT_DIR}`);
});

function normalizeInput(body) {
  const ownAsins = parseLines(body.ownAsins || body.own_asins || body.selfAsins);
  const competitorAsins = parseLines(body.competitorAsins || body.competitor_asins);
  const keywords = parseLines(body.keywords).length ? parseLines(body.keywords) : DEFAULT_KEYWORDS;
  return {
    site: String(body.site || 'US').trim().toUpperCase(),
    tokenProvided: Boolean(String(body.token || body.sorftimeToken || '').trim()),
    ownAsins,
    competitorAsins,
    keywords,
    note: String(body.note || '').trim()
  };
}

function parseLines(value) {
  return String(value || '')
    .split(/\r?\n|,|，|;/)
    .map(v => v.trim())
    .filter(Boolean)
    .filter((v, i, arr) => arr.indexOf(v) === i);
}

function makeReportId(input) {
  const now = new Date();
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const main = input.ownAsins[0] || 'asin-monitor';
  return sanitize(`${input.site}_${main}_${stamp}`);
}

function buildReportData(input, reportId) {
  const now = new Date();
  const allAsins = [
    ...input.ownAsins.map(asin => ({ asin, role: '自有' })),
    ...input.competitorAsins.map(asin => ({ asin, role: '竞品' }))
  ];

  const asinRows = allAsins.map((item, index) => ({
    index: index + 1,
    asin: item.asin,
    role: item.role,
    amazonUrl: `https://www.amazon.com/dp/${encodeURIComponent(item.asin)}`,
    price: '待采集',
    bsr: '待采集',
    estimatedSales: '待采集',
    rating: '待采集',
    reviews: '待采集',
    keywordCoverage: input.keywords.length,
    status: index === 0 ? '首次基线' : '纳入监控',
    action: item.role === '自有'
      ? '补齐关键词排名、广告词与转化数据，作为后续竞品变化对照。'
      : '复核价格、Coupon、BSR、卖家数、Review 与 Listing 变更。'
  }));

  const keywordRows = input.keywords.map((keyword, index) => ({
    index: index + 1,
    keyword,
    intent: inferKeywordIntent(keyword),
    selfRank: '待采集',
    competitorRank: '待采集',
    action: index < 3 ? '优先进入日监控词包' : '进入周监控词包'
  }));

  return {
    reportId,
    generatedAt: now.toISOString(),
    snapshotDate: now.toISOString().slice(0, 10),
    site: input.site,
    title: `${input.site} 站 ASIN 竞品监控报告`,
    meta: META,
    inputSummary: {
      ownAsinCount: input.ownAsins.length,
      competitorAsinCount: input.competitorAsins.length,
      keywordCount: input.keywords.length,
      tokenProvided: input.tokenProvided,
      note: input.note
    },
    status: '首次基线',
    dataPolicy: [
      '首次基线只建立监控对象，不下真实变化结论。',
      '跨日变化必须基于当前快照与上一期快照差异判断。',
      'Sorftime 估算销量、BSR、关键词排名等均属于第三方估算或采集口径，不等同 Amazon 后台真实订单。',
      'Token 只用于本次调用，不写入报告和下载文件。'
    ],
    asinRows,
    keywordRows,
    actions: buildActions(input, asinRows, keywordRows)
  };
}

function inferKeywordIntent(keyword) {
  const k = keyword.toLowerCase();
  if (k.includes('fast') || k.includes('charging')) return '充电速度/功率诉求';
  if (k.includes('travel') || k.includes('portable')) return '便携/旅行诉求';
  if (k.includes('built in') || k.includes('cable')) return '内置线/多接口诉求';
  if (/\d{4,5}mah/.test(k)) return '容量规格诉求';
  return '核心品类词';
}

function buildActions(input, asinRows, keywordRows) {
  const actions = [];
  if (!input.ownAsins.length) {
    actions.push({ priority: 'P0', topic: '自有 ASIN', action: '请至少输入 1 个自有 ASIN，便于和竞品做差距判断。' });
  }
  if (!input.competitorAsins.length) {
    actions.push({ priority: 'P1', topic: '竞品 ASIN', action: '建议输入 3-10 个直接竞品，覆盖同容量、同价格带和同卖点。' });
  }
  if (keywordRows.length < 5) {
    actions.push({ priority: 'P1', topic: '关键词', action: '核心关键词建议不少于 5 个，至少包含品类词、容量词、功能词和场景词。' });
  }
  actions.push({ priority: 'P1', topic: '数据采集', action: '跑完 Sorftime 后保存 raw、manifest、snapshot，下一期才能做价格、BSR、Review、关键词覆盖差异。' });
  actions.push({ priority: 'P2', topic: '报告归档', action: 'HTML/PDF/Markdown/JSON/CSV/ZIP 均已带作者 kong 和 Jax 框架来源说明，便于对外共享。' });
  return actions;
}

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function renderHtmlReport(data) {
  const asinCards = data.asinRows.map(row => `
    <article class="card asin-card">
      <div class="row-between"><strong>${esc(row.role)} · <a href="${esc(row.amazonUrl)}" target="_blank" rel="noopener">${esc(row.asin)}</a></strong><span>${esc(row.status)}</span></div>
      <p>${esc(row.action)}</p>
      <div class="metric-grid">
        <div><b>${esc(row.price)}</b><small>价格</small></div>
        <div><b>${esc(row.bsr)}</b><small>BSR</small></div>
        <div><b>${esc(row.estimatedSales)}</b><small>估算销量</small></div>
        <div><b>${esc(row.reviews)}</b><small>Review</small></div>
      </div>
    </article>`).join('');

  const keywordRows = data.keywordRows.map(row => `
    <tr><td>${row.index}</td><td>${esc(row.keyword)}</td><td>${esc(row.intent)}</td><td>${esc(row.action)}</td></tr>`).join('');

  const asinRows = data.asinRows.map(row => `
    <tr><td>${row.index}</td><td>${esc(row.role)}</td><td><a href="${esc(row.amazonUrl)}" target="_blank" rel="noopener">${esc(row.asin)}</a></td><td>${esc(row.price)}</td><td>${esc(row.bsr)}</td><td>${esc(row.estimatedSales)}</td><td>${esc(row.rating)}</td><td>${esc(row.reviews)}</td><td>${esc(row.action)}</td></tr>`).join('');

  const actions = data.actions.map(item => `<li><b>${esc(item.priority)} · ${esc(item.topic)}</b>：${esc(item.action)}</li>`).join('');

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(data.title)} - by kong</title>
<style>
:root{--ink:#17202a;--muted:#667085;--brand:#0f766e;--line:#d9e1ea;--bg:#f7f9fc;--card:#fff;--soft:#f1f5f9}
*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 18% 0%,rgba(15,118,110,.08),transparent 26rem),linear-gradient(180deg,#f7f9fc 0%,#eef3f7 100%);color:var(--ink);font-family:"PingFang SC","Microsoft YaHei UI","Microsoft YaHei",Arial,sans-serif;line-height:1.65}a{color:#2563eb;text-decoration:none}a:hover{text-decoration:underline}.wrap{max-width:1480px;margin:0 auto;padding:24px}.topbar{position:sticky;top:0;z-index:5;background:rgba(255,255,255,.92);backdrop-filter:blur(12px);border-bottom:1px solid var(--line)}.topbar-inner{max-width:1480px;margin:0 auto;padding:14px 24px;display:flex;justify-content:space-between;gap:16px;align-items:center}.brand{font-weight:800}.tag{border:1px solid var(--line);border-radius:999px;padding:4px 10px;font-size:12px;color:var(--muted);background:#fff}.hero{display:grid;grid-template-columns:1.1fr .9fr;gap:0;border:1px solid var(--line);border-radius:14px;overflow:hidden;background:#fff;box-shadow:0 12px 30px rgba(16,24,40,.05)}.hero-main{padding:34px}.hero-side{padding:34px;background:var(--ink);color:#fff}.eyebrow{display:inline-flex;border:1px solid #a7f3d0;background:#ecfdf5;color:#047857;border-radius:999px;padding:4px 12px;font-size:12px;font-weight:700}h1{font-size:40px;line-height:1.15;margin:14px 0 12px}h2{font-size:24px;margin:0 0 8px}.muted{color:var(--muted)}.side-muted{color:#cbd5e1}.grid{display:grid;gap:16px}.grid-4{grid-template-columns:repeat(4,minmax(0,1fr))}.grid-2{grid-template-columns:repeat(2,minmax(0,1fr))}.card{border:1px solid var(--line);border-radius:12px;background:#fff;padding:18px;box-shadow:0 1px 2px rgba(16,24,40,.04)}.soft{background:var(--soft)}.metric-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin-top:14px}.metric-grid div{background:#f8fafc;border-radius:10px;padding:10px}.metric-grid b{display:block;font-size:18px}.metric-grid small{color:var(--muted)}.section{margin-top:20px}.row-between{display:flex;justify-content:space-between;gap:12px;align-items:center}table{width:100%;border-collapse:collapse;background:#fff;border:1px solid var(--line);border-radius:12px;overflow:hidden}th,td{border-bottom:1px solid #e6ebf1;padding:12px 14px;text-align:left;vertical-align:top;font-size:13px}th{background:#f3f6f9;color:#344054;white-space:nowrap}.footer{margin:24px 0 8px;padding:18px;border:1px dashed var(--line);border-radius:12px;background:#fff;color:var(--muted);font-size:13px}.watermark{position:fixed;inset:0;pointer-events:none;display:grid;place-items:center;color:rgba(23,32,42,.05);font-size:38px;font-weight:800;transform:rotate(-24deg);z-index:0}.content{position:relative;z-index:1}@media(max-width:900px){.hero{grid-template-columns:1fr}.grid-4,.grid-2,.metric-grid{grid-template-columns:1fr}h1{font-size:30px}.topbar-inner{align-items:flex-start;flex-direction:column}}
@media print{.topbar{position:static}.wrap{padding:10px}.hero{break-inside:avoid}.card,table{break-inside:avoid}.watermark{display:none}}
</style>
</head>
<body>
<div class="watermark">by kong · ${esc(data.meta.frameworkAttribution)}</div>
<header class="topbar"><div class="topbar-inner"><div><div class="brand">${esc(data.meta.title)}</div><div class="muted">${esc(data.meta.frameworkAttribution)}｜参考：${esc(data.meta.referenceName)}</div></div><span class="tag">${esc(data.site)} ｜ ${esc(data.snapshotDate)} ｜ ${esc(data.status)}</span></div></header>
<div class="wrap content">
  <section class="hero">
    <div class="hero-main">
      <span class="eyebrow">Sorftime CLI · ASIN Monitor · HTML/PDF/Markdown</span>
      <h1>${esc(data.title)}</h1>
      <p class="muted">本报告用于建立自有 ASIN 与竞品 ASIN 的监控基线。首次基线只记录纳入监控，不输出真实变化结论；跨日变化需在下一次采集后判断。</p>
      <div class="grid grid-4 section">
        <div class="card soft"><b>${data.inputSummary.ownAsinCount}</b><br><span class="muted">自有 ASIN</span></div>
        <div class="card soft"><b>${data.inputSummary.competitorAsinCount}</b><br><span class="muted">竞品 ASIN</span></div>
        <div class="card soft"><b>${data.inputSummary.keywordCount}</b><br><span class="muted">核心关键词</span></div>
        <div class="card soft"><b>${esc(data.status)}</b><br><span class="muted">监控状态</span></div>
      </div>
    </div>
    <div class="hero-side">
      <h2>今日处理建议</h2>
      <p class="side-muted">建议结合库存、广告、订单和利润数据复核；本页只回答竞品监控层面的变化与差距。</p>
      <ul>${actions}</ul>
    </div>
  </section>

  <section class="section card">
    <h2>ASIN 监控概览</h2>
    <p class="muted">按 ASIN 汇总当前状态。接入 Sorftime 后可补齐价格、BSR、估算销量、评分、评论、卖家数、Coupon 和关键词覆盖。</p>
    <div class="grid grid-2 section">${asinCards || '<p class="muted">暂无 ASIN，请返回工具页输入自有 ASIN 和竞品 ASIN。</p>'}</div>
  </section>

  <section class="section card">
    <h2>ASIN 明细表</h2>
    <div style="overflow:auto"><table><thead><tr><th>#</th><th>角色</th><th>ASIN</th><th>价格</th><th>BSR</th><th>估算销量</th><th>评分</th><th>Review</th><th>处理建议</th></tr></thead><tbody>${asinRows}</tbody></table></div>
  </section>

  <section class="section card">
    <h2>关键词表现</h2>
    <p class="muted">默认核心关键词已改为 power bank 方向，不再内置旧品类关键词。</p>
    <div style="overflow:auto"><table><thead><tr><th>#</th><th>关键词</th><th>搜索意图</th><th>动作</th></tr></thead><tbody>${keywordRows}</tbody></table></div>
  </section>

  <section class="section card">
    <h2>数据口径与审计</h2>
    <ul>${data.dataPolicy.map(x => `<li>${esc(x)}</li>`).join('')}</ul>
  </section>

  <footer class="footer">
    <b>作者：</b>${esc(data.meta.author)}<br>
    <b>框架来源说明：</b>${esc(data.meta.frameworkAttribution)}。参考：<a href="${esc(data.meta.referenceUrl)}" target="_blank" rel="noopener">${esc(data.meta.referenceName)}</a><br>
    <b>报告 ID：</b>${esc(data.reportId)} ｜ <b>生成时间：</b>${esc(data.generatedAt)}
  </footer>
</div>
</body>
</html>`;
}

function renderMarkdownReport(data) {
  const lines = [];
  lines.push(`# ${data.title}`);
  lines.push('');
  lines.push(`- 作者：${data.meta.author}`);
  lines.push(`- 框架来源说明：${data.meta.frameworkAttribution}`);
  lines.push(`- 参考链接：${data.meta.referenceUrl}`);
  lines.push(`- 站点：${data.site}`);
  lines.push(`- 快照日期：${data.snapshotDate}`);
  lines.push(`- 状态：${data.status}`);
  lines.push('');
  lines.push('## 1. 总览');
  lines.push(`自有 ASIN：${data.inputSummary.ownAsinCount}；竞品 ASIN：${data.inputSummary.competitorAsinCount}；核心关键词：${data.inputSummary.keywordCount}。`);
  lines.push('');
  lines.push('## 2. 处理建议');
  data.actions.forEach(a => lines.push(`- **${a.priority} · ${a.topic}**：${a.action}`));
  lines.push('');
  lines.push('## 3. ASIN 明细');
  lines.push('| # | 角色 | ASIN | 价格 | BSR | 估算销量 | 评分 | Review | 建议 |');
  lines.push('|---:|---|---|---|---|---|---|---|---|');
  data.asinRows.forEach(r => lines.push(`| ${r.index} | ${r.role} | ${r.asin} | ${r.price} | ${r.bsr} | ${r.estimatedSales} | ${r.rating} | ${r.reviews} | ${r.action} |`));
  lines.push('');
  lines.push('## 4. 关键词');
  lines.push('| # | 关键词 | 搜索意图 | 动作 |');
  lines.push('|---:|---|---|---|');
  data.keywordRows.forEach(r => lines.push(`| ${r.index} | ${r.keyword} | ${r.intent} | ${r.action} |`));
  lines.push('');
  lines.push('## 5. 数据口径');
  data.dataPolicy.forEach(x => lines.push(`- ${x}`));
  return lines.join('\n');
}

function csvEscape(value) {
  const s = String(value ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function renderAsinCsv(data) {
  const header = ['author', 'framework_attribution', 'reference_link', 'report_id', 'snapshot_date', 'site', 'index', 'role', 'asin', 'amazon_url', 'price', 'bsr', 'estimated_sales', 'rating', 'reviews', 'keyword_coverage', 'status', 'action'];
  const rows = data.asinRows.map(r => [
    data.meta.author,
    data.meta.frameworkAttribution,
    data.meta.referenceUrl,
    data.reportId,
    data.snapshotDate,
    data.site,
    r.index,
    r.role,
    r.asin,
    r.amazonUrl,
    r.price,
    r.bsr,
    r.estimatedSales,
    r.rating,
    r.reviews,
    r.keywordCoverage,
    r.status,
    r.action
  ]);
  return [header, ...rows].map(row => row.map(csvEscape).join(',')).join('\n');
}

function renderKeywordCsv(data) {
  const header = ['author', 'framework_attribution', 'reference_link', 'report_id', 'snapshot_date', 'site', 'index', 'keyword', 'intent', 'self_rank', 'competitor_rank', 'action'];
  const rows = data.keywordRows.map(r => [
    data.meta.author,
    data.meta.frameworkAttribution,
    data.meta.referenceUrl,
    data.reportId,
    data.snapshotDate,
    data.site,
    r.index,
    r.keyword,
    r.intent,
    r.selfRank,
    r.competitorRank,
    r.action
  ]);
  return [header, ...rows].map(row => row.map(csvEscape).join(',')).join('\n');
}

function findChineseFont() {
  const candidates = [
    'C:/Windows/Fonts/msyh.ttc',
    'C:/Windows/Fonts/simhei.ttf',
    '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
    '/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc',
    '/usr/share/fonts/truetype/wqy/wqy-microhei.ttc',
    '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc',
    '/usr/share/fonts/truetype/arphic/uming.ttc'
  ];
  return candidates.find(p => fs.existsSync(p));
}

async function renderPdfReport(data, outputPath) {
  await new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 42, info: { Title: `${data.title} by kong`, Author: META.author } });
    const stream = fs.createWriteStream(outputPath);
    stream.on('finish', resolve);
    stream.on('error', reject);
    doc.pipe(stream);

    const fontPath = findChineseFont();
    if (fontPath) {
      doc.registerFont('CN', fontPath);
      doc.font('CN');
    }

    doc.fontSize(18).text(data.title, { align: 'left' });
    doc.moveDown(0.35);
    doc.fontSize(9).fillColor('#667085').text(`作者：${data.meta.author}`);
    doc.text(`框架来源说明：${data.meta.frameworkAttribution}`);
    doc.text(`参考链接：${data.meta.referenceUrl}`);
    doc.text(`站点：${data.site} ｜ 快照：${data.snapshotDate} ｜ 状态：${data.status}`);
    doc.moveDown();

    doc.fillColor('#17202a').fontSize(13).text('一、总览');
    doc.fontSize(10).fillColor('#17202a').text(`自有 ASIN：${data.inputSummary.ownAsinCount}；竞品 ASIN：${data.inputSummary.competitorAsinCount}；核心关键词：${data.inputSummary.keywordCount}。`);
    doc.moveDown(0.7);

    doc.fontSize(13).text('二、处理建议');
    doc.fontSize(10);
    data.actions.forEach(a => doc.text(`• ${a.priority} · ${a.topic}：${a.action}`));
    doc.moveDown(0.7);

    doc.fontSize(13).text('三、ASIN 明细');
    doc.fontSize(9);
    data.asinRows.forEach(r => {
      doc.text(`${r.index}. ${r.role} · ${r.asin}`);
      doc.text(`   价格：${r.price}｜BSR：${r.bsr}｜估算销量：${r.estimatedSales}｜评分：${r.rating}｜Review：${r.reviews}`);
      doc.text(`   建议：${r.action}`);
      doc.moveDown(0.25);
    });
    doc.moveDown(0.5);

    doc.fontSize(13).text('四、核心关键词');
    doc.fontSize(9);
    data.keywordRows.forEach(r => doc.text(`${r.index}. ${r.keyword}｜${r.intent}｜${r.action}`));
    doc.moveDown(0.7);

    doc.fontSize(13).text('五、数据口径');
    doc.fontSize(9);
    data.dataPolicy.forEach(x => doc.text(`• ${x}`));

    doc.moveDown();
    doc.fontSize(8).fillColor('#667085').text(`报告 ID：${data.reportId} ｜ 生成时间：${data.generatedAt}`, { align: 'center' });
    doc.end();
  });
}

async function renderZip(reportDir, files, outputPath) {
  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(outputPath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    output.on('close', resolve);
    archive.on('error', reject);
    archive.pipe(output);
    Object.entries(files).forEach(([key, name]) => {
      if (key !== 'zip') archive.file(path.join(reportDir, name), { name });
    });
    archive.append(`作者：${META.author}\n框架来源说明：${META.frameworkAttribution}\n参考链接：${META.referenceUrl}\n`, { name: 'README_作者与来源说明.txt' });
    archive.finalize();
  });
}
