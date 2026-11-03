import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

/** Open a single-use local review page. Only titles, URLs and the bio are editable. */
export async function reviewPlan(plan) {
  const token = crypto.randomBytes(32).toString('hex');
  const source = plan.source || {};
  const completed = new Set(plan.completedPlanKeys || []);
  const rows = plan.updates.map((update, i) => `<section><h3>${escapeHtml(update.collectionTitle || '課程')}：${escapeHtml(update.action)}</h3><p>目前：${escapeHtml(update.currentTitle || '新增卡片')}${completed.has(update.planKey) ? '（已更新，無法在此修改）' : ''}</p>${update.action === 'toggle_off' ? '<p>此卡片將停用</p>' : `<label>名稱<input name="title_${i}" required ${completed.has(update.planKey) ? 'readonly' : ''} value="${escapeHtml(update.newTitle)}"></label><label>連結<input name="url_${i}" type="url" required ${completed.has(update.planKey) ? 'readonly' : ''} value="${escapeHtml(update.newUrl)}"></label>`}</section>`).join('');
  const page = `<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>每月資訊核對</title><style>body{font:16px system-ui;margin:0;color:#202939;background:#f3f5f8}header,main{padding:20px}main{display:grid;grid-template-columns:1fr 1fr;gap:20px}article,section{background:white;border-radius:10px;padding:18px;margin-bottom:14px}img{width:100%;height:auto}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit}label{display:block;margin:12px 0}input,textarea{box-sizing:border-box;width:100%;font:inherit;padding:9px}textarea{min-height:90px}button{padding:12px 20px;font:inherit;cursor:pointer}button.primary{background:#2455ae;color:white;border:0;border-radius:6px} @media(max-width:800px){main{grid-template-columns:1fr}}</style><header><h1>每月資訊核對：${escapeHtml(plan.year || '')} 年 ${escapeHtml(plan.calendarMonth || plan.month)} 月</h1><p>請對照原文與圖片，核對課程、連結及休館資訊。確認後才會更新 Linktree。</p></header><main><div><article><h2>Facebook 原始資料</h2>${source.postUrl ? `<p><a href="${escapeHtml(source.postUrl)}" target="_blank" rel="noreferrer">開啟原貼文</a></p>` : ''}<pre>${escapeHtml(source.text || '此舊計畫沒有保存原文，請重新產生計畫。')}</pre>${source.imageData ? `<img src="data:${escapeHtml(source.imageMime || 'image/jpeg')};base64,${source.imageData}" alt="原始課表圖片">` : '<p>沒有保存原始圖片，請重新產生計畫。</p>'}</article></div><form method="post" action="/review"><input type="hidden" name="token" value="${token}"><article><h2>Linktree 休館資訊</h2><p>請逐日對照圖片；例行休館是否需要列出，請依實際公告調整。</p><label>Bio<textarea name="bio" ${plan.bioCompleted ? 'readonly' : ''}>${escapeHtml(plan.closedDatesString)}</textarea>${plan.bioCompleted ? '<p>Bio 已更新，無法在此修改。</p>' : ''}</label><p>辨識出的日期：${escapeHtml((plan.shadedDays || []).map(d => `${d.day}日 ${d.label || '例行休館'} (${d.kind})`).join('、'))}</p></article>${rows}<button class="primary" name="decision" value="approve">確認並更新 Linktree</button> <button name="decision" value="cancel" formnovalidate>取消，保留計畫</button></form></main></html>`;
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      res.setHeader('Content-Security-Policy', "default-src 'none'; img-src data:; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'");
      res.setHeader('X-Content-Type-Options', 'nosniff');
      if (req.method === 'GET' && req.url === `/${token}`) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(page); return; }
      if (req.method !== 'POST' || req.url !== '/review') { res.writeHead(404); res.end(); return; }
      let body = '';
      req.on('data', chunk => { body += chunk; if (body.length > 1024 * 1024) req.destroy(); });
      req.on('end', () => {
        const data = new URLSearchParams(body);
        if (data.get('token') !== token || !['approve', 'cancel'].includes(data.get('decision'))) { res.writeHead(403); res.end('無效的請求'); return; }
        if (data.get('decision') === 'cancel') { res.end('已取消，計畫仍保留。'); server.close(); resolve(null); return; }
        const updates = plan.updates.map((update, i) => update.action === 'toggle_off' || completed.has(update.planKey) ? update : { ...update, newTitle: (data.get(`title_${i}`) || '').trim(), newUrl: (data.get(`url_${i}`) || '').trim() });
        const valid = updates.every(update => {
          if (update.action === 'toggle_off') return true;
          try { return update.newTitle && ['http:', 'https:'].includes(new URL(update.newUrl).protocol); } catch { return false; }
        });
        if (!valid) { res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('名稱不可空白，連結必須是 HTTP 或 HTTPS 網址。請返回修改。'); return; }
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('已確認，正在更新 Linktree。請查看程式執行結果。');
        server.close(); resolve({ updates, closedDatesString: plan.bioCompleted ? plan.closedDatesString : data.get('bio') || '' });
      });
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const url = `http://127.0.0.1:${server.address().port}/${token}`;
      console.log(`\n請在瀏覽器開啟核對頁面：${url}`);
      if (process.platform === 'darwin') { const child = spawn('open', [url], { stdio: 'ignore' }); child.on('error', () => {}); child.unref(); }
    });
  });
}
