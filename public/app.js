const $ = selector => document.querySelector(selector);
let token = sessionStorage.getItem('sync-token') || '';
let backend = sessionStorage.getItem('sync-backend') || '';
const fragment = location.hash.slice(1);
if (/^[a-f0-9]{64}$/.test(fragment) && ['127.0.0.1', 'localhost'].includes(location.hostname)) {
  token = fragment; backend = location.origin;
  sessionStorage.setItem('sync-token', token); sessionStorage.setItem('sync-backend', backend);
  history.replaceState(null, '', location.pathname);
}
let reviewId = null;
let busy = false;
let currentPlan = null;
let monthInitialized = false;
function element(tag, value, className) { const node = document.createElement(tag); if (value != null) node.textContent = value; if (className) node.className = className; return node; }
async function api(path, options = {}) {
  const response = await fetch(`${backend}${path}`, { ...options, headers: { 'X-Dashboard-Token': token, ...(options.body ? { 'Content-Type': 'application/json' } : {}) } });
  const json = await response.json();
  if (!response.ok) throw new Error(json.error || '操作失敗');
  return json;
}
function setError(message) { $('#status').textContent = '需要處理'; $('#status-detail').textContent = message; $('#status-dot').style.background = '#d68b6b'; }
$('#connect-form').addEventListener('submit', async event => {
  event.preventDefault();
  try {
    const url = new URL($('#connect-url').value.trim());
    if (url.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(url.hostname) || !/^[a-f0-9]{64}$/.test(url.hash.slice(1))) throw Error('請輸入啟動程式時顯示的完整本機網址。');
    backend = url.origin; token = url.hash.slice(1);
    await api('/api/status');
    sessionStorage.setItem('sync-token', token); sessionStorage.setItem('sync-backend', backend);
    $('#connect-url').value = ''; $('#connection').hidden = true; await refresh();
  } catch (error) { setError(`無法連線：${error.message}`); }
});
$('#start').addEventListener('click', async () => {
  try {
    const match = /^(\d{4})-(\d{2})$/.exec($('#month').value);
    if (!match || !$('#month').checkValidity()) throw new Error('請選擇有效的年和月份。');
    $('#start').disabled = true;
    await api('/api/start', { method: 'POST', body: JSON.stringify({ year: Number(match[1]), month: Number(match[2]) }) });
    reviewId = null; await refresh();
  } catch (error) { setError(error.message); $('#start').disabled = false; }
});
function renderPlan(plan) {
  currentPlan = plan;
  $('#review').hidden = false;
  $('#review-month').textContent = `目標：${plan.year || '未記錄年份'} 年 ${plan.calendarMonth || plan.month} 月`;
  $('#source-text').textContent = plan.source?.text || '沒有保存原始貼文。';
  const image = $('#source-image');
  image.hidden = !plan.source?.imageData;
  if (!image.hidden) image.src = `data:${plan.source.imageMime || 'image/jpeg'};base64,${plan.source.imageData}`;
  const link = $('#source-link');
  try { const source = new URL(plan.source?.postUrl); if (!['https:', 'http:'].includes(source.protocol)) throw Error(); link.href = source.href; link.hidden = false; } catch { link.hidden = true; }
  $('#bio').value = plan.closedDatesString || ''; $('#bio').readOnly = Boolean(plan.bioCompleted);
  $('#shaded').textContent = `辨識的日期：${(plan.shadedDays || []).map(d => `${d.day}日 ${d.label || '例行休館'}（${{ weekly: '例行', special: '特殊', uncertain: '待確認' }[d.kind] || d.kind}）`).join('、') || '無'}`;
  const list = $('#updates'); list.replaceChildren();
  const completed = new Set(plan.completedPlanKeys || []);
  plan.updates.forEach((update, i) => {
    const box = element('article', null, 'panel update'); const head = element('div', null, 'update-head');
    head.append(element('h3', update.collectionTitle || '課程'), element('span', ({ update: '更新', toggle_on: '啟用', toggle_off: '停用', add: '新增' }[update.action] || update.action) + (completed.has(update.planKey) ? '・已完成' : ''), 'tag'));
    box.append(head, element('p', `目前：${update.currentTitle || '新增卡片'}`, 'old'));
    if (update.action === 'toggle_off') box.append(element('p', '此卡片將停用。', 'muted'));
    else {
      const titleLabel = element('label', '課程名稱'); titleLabel.htmlFor = `title-${i}`;
      const title = element('input'); title.id = `title-${i}`; title.value = update.newTitle || ''; title.required = true; title.readOnly = completed.has(update.planKey);
      const urlLabel = element('label', '報名或活動連結'); urlLabel.htmlFor = `url-${i}`;
      const url = element('input'); url.id = `url-${i}`; url.type = 'url'; url.value = update.newUrl || ''; url.required = true; url.readOnly = completed.has(update.planKey);
      box.append(titleLabel, title, urlLabel, url);
    }
    list.append(box);
  });
}
async function decide(decision) {
  if (busy || !currentPlan) return;
  busy = true;
  const updates = currentPlan.updates.map((update, i) => ({ title: $(`#title-${i}`)?.value || '', url: $(`#url-${i}`)?.value || '' }));
  try {
    await api('/api/review', { method: 'POST', body: JSON.stringify({ decision, bio: $('#bio').value, updates }) });
    $('#review').hidden = true; currentPlan = null; await refresh();
  } catch (error) { setError(error.message); }
  finally { busy = false; }
}
$('#review-form').addEventListener('submit', event => { event.preventDefault(); decide('approve'); });
$('#cancel').addEventListener('click', () => decide('cancel'));
async function refresh() {
  if (!token || !backend) { $('#connection').hidden = false; $('#start').disabled = true; setError('請先連接執行服務。'); return; }
  try {
    const state = await api('/api/status');
    $('#connection').hidden = true;
    const active = ['running', 'review', 'publishing'].includes(state.phase);
    if (!monthInitialized || (active && state.selectedTarget)) {
      const year = active && state.selectedTarget ? state.selectedTarget.year : state.target.targetYear;
      const month = active && state.selectedTarget ? state.selectedTarget.month : state.target.targetMonth;
      $('#month').value = `${year}-${String(month).padStart(2, '0')}`;
      monthInitialized = true;
    }
    $('#month').disabled = active;
    const labels = { idle: '準備就緒', running: '正在整理', review: '等待核對', publishing: '正在更新', done: '工作完成', cancelled: '已取消', error: '需要處理' };
    $('#status').textContent = labels[state.phase] || state.phase;
    $('#status-detail').textContent = state.message;
    $('#status-dot').style.background = state.phase === 'error' ? '#d68b6b' : '#7ea998';
    $('#logs').textContent = state.logs.join('\n') || '尚無紀錄';
    $('#start').disabled = active;
    if (state.phase === 'review' && state.plan && reviewId !== state.plan.id) { reviewId = state.plan.id; renderPlan(state.plan); }
    if (state.phase !== 'review') { $('#review').hidden = true; currentPlan = null; }
  } catch (error) { $('#connection').hidden = false; $('#start').disabled = true; setError('無法連接本機服務，請重新開啟 App。'); }
}
refresh(); setInterval(refresh, 2500);
