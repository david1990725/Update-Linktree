import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fork, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getTargetMonthAndKeyword } from './src/config.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const lock = path.join(root, '.linktree-sync.lock');
const token = crypto.randomBytes(32).toString('hex');
const port = Number(process.env.DASHBOARD_PORT || 4317);
const stateFile = path.join(root, 'data', 'dashboard-url');
let child = null;
let state = { phase: 'idle', message: '準備就緒', logs: [], plan: null };
function log(data) {
  state.logs.push(...String(data).split('\n').filter(Boolean));
  state.logs = state.logs.slice(-160);
}
function reply(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 1024 * 1024) { reject(new Error('資料過大')); req.destroy(); } });
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch { reject(new Error('資料格式不正確')); } });
    req.on('error', reject);
  });
}
function begin(target) {
  if (child) throw new Error('已有工作執行中。');
  if (!Number.isInteger(target?.year) || target.year < 2000 || target.year > 2100 || !Number.isInteger(target?.month) || target.month < 1 || target.month > 12) throw new Error('請選擇有效的年和月份。');
  try { fs.mkdirSync(lock); } catch (error) {
    if (error.code === 'EEXIST') throw new Error('另一個同步工作正在執行，請稍後再試；如果上次異常中斷，請先確認沒有其他工作後檢查鎖定檔。');
    throw error;
  }
  state = { phase: 'running', message: `正在尋找 ${target.year} 年 ${target.month} 月的貼文並整理更新內容…`, logs: [], plan: null, selectedTarget: target };
  try {
    child = fork(path.join(root, 'index.js'), [], { cwd: root, env: { ...process.env, TARGET_YEAR: String(target.year), TARGET_MONTH: String(target.month), RUN_MODE: 'dashboard', REQUIRE_REVIEW: 'true', HEADLESS: 'true' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  } catch (error) { fs.rmdirSync(lock); throw error; }
  child.stdout.on('data', log);
  child.stderr.on('data', log);
  child.on('message', message => {
    if (message?.type === 'review') {
      state.phase = 'review'; state.message = '請核對來源及更新內容'; state.plan = message.plan;
    }
  });
  child.on('error', error => { log(error.message); state.phase = 'error'; state.message = '無法啟動更新工作'; });
  child.on('exit', (code, signal) => {
    try { fs.rmdirSync(lock); } catch {}
    child = null;
    if (state.phase === 'cancelled') state.message = '已取消，計畫已保留。';
    else if (code !== 0 || signal) { state.phase = 'error'; state.message = '更新未完成，請查看執行紀錄。'; }
    else if (state.phase === 'publishing') { state.phase = 'done'; state.message = '更新完成，請查看執行紀錄確認結果。'; }
    else { state.phase = 'done'; state.message = '檢查完成；可能沒有需要更新的內容，請查看執行紀錄。'; }
    state.plan = null;
  });
}
function validateReview(body, plan) {
  if (!Array.isArray(body.updates) || body.updates.length !== plan.updates.length || typeof body.bio !== 'string' || body.bio.length > 5000) throw new Error('核對資料不完整。');
  const completed = new Set(plan.completedPlanKeys || []);
  const updates = plan.updates.map((original, i) => {
    if (original.action === 'toggle_off' || completed.has(original.planKey)) return original;
    const title = String(body.updates[i]?.title || '').trim();
    const url = String(body.updates[i]?.url || '').trim();
    let parsed; try { parsed = new URL(url); } catch { throw new Error(`第 ${i + 1} 項網址無效。`); }
    if (!title || title.length > 500 || !['http:', 'https:'].includes(parsed.protocol)) throw new Error(`第 ${i + 1} 項名稱或網址無效。`);
    return { ...original, newTitle: title, newUrl: url };
  });
  return { updates, closedDatesString: plan.bioCompleted ? plan.closedDatesString : body.bio };
}
const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'");
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'GET' && ['/', '/app.js', '/style.css'].includes(url.pathname)) {
    const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const contentType = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html';
    res.writeHead(200, { 'Content-Type': `${contentType}; charset=utf-8`, 'Cache-Control': 'no-store' });
    fs.createReadStream(path.join(root, 'public', file)).pipe(res); return;
  }
  if (req.headers['x-dashboard-token'] !== token) return reply(res, 403, { error: '驗證失敗，請使用啟動時顯示的網址。' });
  if (req.method === 'GET' && url.pathname === '/api/status') return reply(res, 200, { ...state, target: getTargetMonthAndKeyword() });
  if (req.method !== 'POST') return reply(res, 404, { error: '找不到頁面' });
  try {
    if (url.pathname === '/api/start') { const body = await readBody(req); begin({ year: body.year, month: body.month }); return reply(res, 200, { ok: true }); }
    if (url.pathname === '/api/review') {
      if (!child || state.phase !== 'review' || !state.plan) throw new Error('目前沒有可核對的計畫。');
      const body = await readBody(req);
      if (body.decision === 'cancel') { state.phase = 'cancelled'; child.send({ type: 'review-result', reviewed: null }); }
      else if (body.decision === 'approve') { const reviewed = validateReview(body, state.plan); state.phase = 'publishing'; state.message = '正在更新 Linktree，請勿關閉程式…'; child.send({ type: 'review-result', reviewed }); }
      else throw new Error('無效操作。');
      return reply(res, 200, { ok: true });
    }
    return reply(res, 404, { error: '找不到頁面' });
  } catch (error) { return reply(res, 400, { error: error.message }); }
});
server.listen(port, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${server.address().port}/#${token}`;
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, url, { mode: 0o600 });
  fs.chmodSync(stateFile, 0o600);
  console.log(`控制頁面：${url}`);
  if (process.platform === 'darwin' && process.env.DASHBOARD_NO_OPEN !== 'true') { const opener = spawn('open', [url], { stdio: 'ignore' }); opener.on('error', () => {}); opener.unref(); }
});
server.on('close', () => { try { fs.unlinkSync(stateFile); } catch {} });
server.on('error', error => { console.error(`無法開啟控制頁面：${error.message}`); process.exitCode = 1; });
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    if (child) child.kill('SIGTERM');
    server.close(() => { if (!child) process.exit(0); });
    if (child) child.once('exit', () => process.exit(0));
  });
}
