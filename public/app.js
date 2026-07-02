const DEFAULT_KEYWORDS = [
  'power bank',
  'portable charger',
  'power bank with built in cable',
  'fast charging power bank',
  'travel power bank',
  'usb c power bank',
  '10000mah portable charger',
  '20000mah power bank'
].join('\n');

const form = document.getElementById('monitorForm');
const statusBox = document.getElementById('status');
const fileList = document.getElementById('fileList');
const submitBtn = document.getElementById('submitBtn');

document.getElementById('keywords').value = DEFAULT_KEYWORDS;

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  setStatus('正在生成报告，请不要重复点击……');
  fileList.innerHTML = '';
  submitBtn.disabled = true;

  const payload = Object.fromEntries(new FormData(form).entries());

  try {
    const response = await fetch('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.message || '生成失败');

    setStatus(`生成成功：${result.reportId}`, 'success');
    fileList.innerHTML = result.files.map(file => {
      const target = file.type === 'html' ? ' target="_blank" rel="noopener"' : '';
      return `<a href="${file.url}"${target}>${file.label}</a>`;
    }).join('');
  } catch (error) {
    setStatus(error.message || '生成失败，请查看服务端日志。', 'error');
  } finally {
    submitBtn.disabled = false;
  }
});

function setStatus(message, type = '') {
  statusBox.className = `status ${type}`.trim();
  statusBox.textContent = message;
}
