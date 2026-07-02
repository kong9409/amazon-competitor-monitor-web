const form = document.getElementById('runForm');
const btn = document.getElementById('runBtn');
const statusEl = document.getElementById('status');
const summaryEl = document.getElementById('summary');
const linksEl = document.getElementById('links');
const preview = document.getElementById('preview');

let pollTimer = null;

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
  const items = [
    ['打开 HTML 看板', urls.html, 'primary', false],
    ['下载 PDF', urls.pdf, '', false],
    ['下载 Markdown', urls.markdown, '', true],
    ['下载 JSON', urls.json, '', true],
    ['下载 CSV', urls.csv, '', true],
    ['下载全部 ZIP', urls.zip, '', true]
  ].filter(([, url]) => url);
  linksEl.classList.remove('hidden');
  linksEl.innerHTML = items.map(([label, url, cls, download]) =>
    `<a class="${cls}" href="${url}" ${download ? 'download' : 'target="_blank" rel="noopener"'}>${label}</a>`
  ).join('');
  if (urls.html) preview.src = urls.html;
}

async function readJson(resp) {
  const text = await resp.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(text || `HTTP ${resp.status}`);
  }
}

async function pollJob(jobId, startedAt = Date.now()) {
  try {
    const resp = await fetch(`/api/run/${encodeURIComponent(jobId)}`, { cache: 'no-store' });
    const data = await readJson(resp);
    if (!resp.ok || data.status === 'failed' || data.ok === false) throw new Error(data.error || '报告生成失败');
    if (data.status === 'done') {
      clearInterval(pollTimer);
      pollTimer = null;
      btn.disabled = false;
      setStatus('ok', `报告已生成：${data.runId}`);
      renderSummary(data.summary || {});
      renderLinks(data.urls || {});
      return true;
    }
    const sec = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
    setStatus('running', `报告正在后台生成，已运行 ${sec}s。请保持页面打开，生成完成后会自动显示下载链接。`);
    return false;
  } catch (err) {
    clearInterval(pollTimer);
    pollTimer = null;
    btn.disabled = false;
    setStatus('err', `生成失败：${err.message}`);
    return true;
  }
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (pollTimer) clearInterval(pollTimer);
  btn.disabled = true;
  summaryEl.classList.add('hidden');
  linksEl.classList.add('hidden');
  preview.removeAttribute('src');
  setStatus('running', '已提交任务，正在连接后端...');
  const startedAt = Date.now();
  try {
    const resp = await fetch('/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(formDataJson(form))
    });
    const data = await readJson(resp);
    if (!resp.ok || !data.ok) throw new Error(data.error || '任务提交失败');
    setStatus('running', `报告任务已开始：${data.jobId}`);
    const finished = await pollJob(data.jobId, startedAt);
    if (!finished && !pollTimer) {
      pollTimer = setInterval(() => pollJob(data.jobId, startedAt), 3000);
    }
  } catch (err) {
    btn.disabled = false;
    setStatus('err', `提交失败：${err.message}`);
  }
});
