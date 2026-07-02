const form = document.getElementById('runForm');
const btn = document.getElementById('runBtn');
const statusEl = document.getElementById('status');
const summaryEl = document.getElementById('summary');
const linksEl = document.getElementById('links');
const preview = document.getElementById('preview');

function setStatus(type, text) {
  statusEl.className = `status ${type}`;
  statusEl.textContent = text;
}
function formDataJson(form) {
  const fd = new FormData(form);
  const obj = Object.fromEntries(fd.entries());
  obj.demoMode = fd.get('demoMode') === 'on';
  return obj;
}
function fmtMs(ms) {
  if (!Number.isFinite(Number(ms))) return '-';
  const sec = Math.round(Number(ms) / 1000);
  if (sec < 60) return `${sec}s`;
  return `${Math.floor(sec / 60)}m ${sec % 60}s`;
}
function renderSummary(s) {
  summaryEl.classList.remove('hidden');
  summaryEl.innerHTML = `
    <div><b>${s.asin_count ?? 0}</b><span>监控 ASIN</span></div>
    <div><b>${s.event_count ?? 0}</b><span>变化事件</span></div>
    <div><b>${s.high_risk_count ?? 0}</b><span>高风险</span></div>
    <div><b>${s.audit_count ?? 0}</b><span>接口调用</span></div>
    <div><b>${s.total_request_consumed ?? '-'}</b><span>消耗次数</span></div>
    <div><b>${fmtMs(s.total_duration_ms)}</b><span>CLI 总运行时间</span></div>`;
}
function renderLinks(urls) {
  linksEl.classList.remove('hidden');
  linksEl.innerHTML = `
    <a class="primary" href="${urls.html}" target="_blank">打开 HTML 看板</a>
    <a href="${urls.pdf}">下载 PDF</a>
    <a href="${urls.markdown}">下载 Markdown</a>
    <a href="${urls.json}">下载 JSON</a>
    <a href="${urls.csv}">下载 CSV</a>
    <a href="${urls.zip}">下载全部 ZIP</a>`;
  preview.src = urls.html;
}
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  btn.disabled = true;
  summaryEl.classList.add('hidden');
  linksEl.classList.add('hidden');
  preview.removeAttribute('src');
  setStatus('running', '正在调用 Sorftime CLI 并生成报告，请稍等。ASIN 和关键词越多，耗时越长。');
  try {
    const resp = await fetch('/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(formDataJson(form))
    });
    const data = await resp.json();
    if (!data.ok) throw new Error(data.error || '生成失败');
    setStatus('ok', `报告已生成：${data.runId}`);
    renderSummary(data.summary || {});
    renderLinks(data.urls || {});
  } catch (err) {
    setStatus('err', `生成失败：${err.message}`);
  } finally {
    btn.disabled = false;
  }
});
