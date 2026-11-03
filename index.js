import crypto from 'crypto';
import fs from 'fs';
import { Database } from './src/database.js';
import { scrapeFacebookPosts } from './src/scraper.js';
import { classifyAndMapLinktreeUpdates, PROMPT_VERSION } from './src/classifier.js';
import { reviewPlan } from './src/review.js';
import {
  launchLinktreeSession,
  scanLinktreeItems,
  applyLinktreeUpdates,
  updateLinktreeBio
} from './src/linktree.js';
import {
  FB_PAGE_URL,
  REQUIRE_REVIEW,
  RETRY_PROCESSED_POSTS,
  RUN_MODE,
  getTargetMonthAndKeyword
} from './src/config.js';

const { keyword: FB_KEYWORD, targetMonth, targetYear } = getTargetMonthAndKeyword();

function makePlanId(postHash) {
  return crypto.createHash('sha256').update(`${postHash}:${PROMPT_VERSION}`).digest('hex');
}

function printPlan(plan) {
  console.log('\n[SYNC PLAN]');
  console.log(`Month: ${plan.month || 'Unknown'} | updates: ${plan.updates.length}`);
  console.log(`Bio: "${plan.closedDatesString || ''}"`);
  if (Array.isArray(plan.shadedDays)) {
    const special = plan.shadedDays.filter(day => day.kind === 'special');
    const weekly = plan.shadedDays.filter(day => day.kind === 'weekly');
    console.log(`深色格：特殊休館 ${special.length} 天；星期一例行休館 ${weekly.length} 天`);
    const month = plan.calendarMonth || Number.parseInt(plan.month, 10) || targetMonth;
    const weekdays = { Mon: '一', Tue: '二', Wed: '三', Thu: '四', Fri: '五', Sat: '六', Sun: '日' };
    for (const day of [...plan.shadedDays].sort((a, b) => a.day - b.day)) {
      const kind = day.kind === 'weekly' ? '例行休館' : day.kind === 'special' ? '特殊休館' : '待確認';
      console.log(`   ${month}/${day.day}（週${weekdays[day.weekday] || day.weekday}）${kind}：${day.label || '休館'}`);
    }
  }
  for (const [index, update] of plan.updates.entries()) {
    console.log(`${index + 1}. ${update.action}: "${update.currentTitle}" → "${update.newTitle}"`);
    if (update.newUrl) console.log(`   ${update.newUrl}`);
  }
}

async function main() {
  console.log('==================================================');
  console.log(`Facebook → Linktree sync | mode: ${RUN_MODE}`);
  console.log(`Target: ${targetYear}年${targetMonth}月 | ${new Date().toLocaleString()}`);
  console.log('==================================================\n');

  if (!['interactive', 'plan', 'auto', 'dashboard'].includes(RUN_MODE)) {
    throw new Error(`RUN_MODE 必須是 interactive、plan 或 auto，目前為：${RUN_MODE}`);
  }
  if (!FB_PAGE_URL) throw new Error('FB_PAGE_URL is not defined in .env');

  const db = new Database();
  let browserSession = null;
  let targetPost = null;
  let targetHash = null;
  let activePlan = null;

  try {
    const scrapedPosts = await scrapeFacebookPosts(FB_PAGE_URL, FB_KEYWORD);
    if (!scrapedPosts?.length) {
      console.log(`[Status] 找不到包含「${FB_KEYWORD}」的貼文。`);
      return;
    }

    for (const post of scrapedPosts) {
      if (!post.imagePath || !fs.existsSync(post.imagePath)) throw new Error('無法取得課表圖片，請確認 Facebook 登入狀態與貼文圖片。');
      const imageData = fs.readFileSync(post.imagePath).toString('base64');
      const hash = db.getPostHash(JSON.stringify({ year: targetYear, month: targetMonth, text: post.text, links: [...(post.links || [])].sort(), imageData }));
      if (!db.isProcessed(hash) || RETRY_PROCESSED_POSTS) {
        targetPost = post;
        targetPost.imageData = imageData;
        targetHash = hash;
        break;
      }
    }
    if (!targetPost) {
      console.log('[Status] 所有符合的貼文都已完成。');
      return;
    }

    const interrupted = db.read().plans.find(plan =>
      plan.postHash !== targetHash && plan.year === targetYear &&
      Number(plan.calendarMonth) === targetMonth && plan.status !== 'completed' &&
      ((plan.completedPlanKeys || []).length > 0 || plan.bioCompleted)
    );
    if (interrupted) {
      throw new Error('來源內容已變更，但同月份的舊計畫已部分發布；請先檢查 Linktree 與舊計畫，避免重複或遺漏更新。');
    }

    activePlan = db.getResumablePlan(targetHash);
    if (activePlan && activePlan.promptVersion !== PROMPT_VERSION) {
      throw new Error('找到舊版未完成計畫；其休館資訊未經圖片格子驗證，請先檢查已寫入的卡片與 Bio。');
    }
    if (activePlan) {
      console.log(`[Status] 找到未完成計畫 ${activePlan.id.substring(0, 8)}；不重新呼叫 AI。`);
      printPlan(activePlan);
    } else {
      browserSession = await launchLinktreeSession();
      const structure = await scanLinktreeItems(browserSession.page);
      if (!structure?.length) throw new Error('Linktree 沒有掃描到任何項目，已停止以避免空白寫入。');

      // Only actual post links are candidates. The Facebook page itself must
      // never be silently used as a course registration URL.
      const aiResult = await classifyAndMapLinktreeUpdates(
        targetPost.text,
        targetPost.links || [],
        structure,
        targetPost.imagePath,
        targetMonth,
        targetPost.postUrl
      );
      if (!aiResult.isMatch || !aiResult.updates?.length) {
        db.savePost({
          hash: targetHash,
          text: targetPost.text,
          url: '',
          title: '',
          month: aiResult.month || `${targetMonth}月`,
          status: 'ignored'
        });
        console.log('[Status] 此貼文沒有可安全套用的變更，已標記為 ignored。');
        return;
      }

      activePlan = db.savePlan({
        id: makePlanId(targetHash),
        postHash: targetHash,
        promptVersion: PROMPT_VERSION,
        month: aiResult.month || `${targetMonth}月`,
        year: targetYear,
        modelSelection: aiResult.modelSelection,
        source: { text: targetPost.text, postUrl: targetPost.postUrl, imageData: targetPost.imageData, imageMime: 'image/jpeg', links: targetPost.links || [] },
        calendarMonth: aiResult.calendarMonth,
        closedDatesString: aiResult.closedDatesString,
        shadedDays: aiResult.shadedDays,
        updates: aiResult.updates,
        completedPlanKeys: [],
        bioCompleted: false,
        status: 'planned',
        createdAt: new Date().toISOString()
      });
      printPlan(activePlan);
    }

    if (RUN_MODE === 'plan') {
      console.log('[Status] Plan mode：計畫已儲存，未呼叫寫入程序。');
      return;
    }

    if ((RUN_MODE === 'interactive' && REQUIRE_REVIEW) || RUN_MODE === 'dashboard') {
      const reviewed = RUN_MODE === 'dashboard' ? await new Promise((resolve, reject) => {
        if (!process.send || !process.connected) return reject(new Error('控制頁面連線已中斷。'));
        process.send({ type: 'review', plan: activePlan });
        process.once('message', message => resolve(message?.type === 'review-result' ? message.reviewed : null));
        process.once('disconnect', () => reject(new Error('控制頁面連線已中斷，已停止更新。')));
      }) : await reviewPlan(activePlan);
      if (!reviewed) {
        console.log('[Status] 使用者未核准；保留計畫供下次續跑。');
        return;
      }
      activePlan = db.updatePlan(activePlan.id, reviewed);
    }

    if (!browserSession) browserSession = await launchLinktreeSession();
    // A scan is an inexpensive preflight that verifies the current redesigned
    // UI is available before applying a cached plan.
    const preflightItems = await scanLinktreeItems(browserSession.page);
    if (!preflightItems.length) throw new Error('Linktree 預檢失敗：找不到現有卡片。');

    const completed = new Set(activePlan.completedPlanKeys || []);
    const pendingUpdates = activePlan.updates.filter(update => !completed.has(update.planKey));
    db.updatePlan(activePlan.id, { status: 'applying', lastError: '' });

    if (pendingUpdates.length) {
      const updateResult = await applyLinktreeUpdates(browserSession.page, pendingUpdates, async result => {
        if (result.success) {
          completed.add(result.update.planKey);
          db.updatePlan(activePlan.id, { completedPlanKeys: [...completed] });
        } else {
          db.updatePlan(activePlan.id, { lastError: result.error || '未知卡片寫入錯誤' });
        }
      });
      if (!updateResult.success) {
        throw new Error(`有 ${updateResult.failed.length} 張 Linktree 卡片更新失敗。`);
      }
    }

    // Write the bio last so a card failure cannot leave a misleading partial
    // monthly announcement behind.
    if (!activePlan.bioCompleted) {
      const bioResult = await updateLinktreeBio(browserSession.page, activePlan.closedDatesString);
      if (!bioResult?.success) throw new Error('Linktree Bio 更新未完成。');
      activePlan = db.updatePlan(activePlan.id, { bioCompleted: true });
    }

    db.updatePlan(activePlan.id, { status: 'completed', completedAt: new Date().toISOString(), lastError: '' });
    db.savePost({
      hash: targetHash,
      text: targetPost.text,
      url: '',
      title: `${activePlan.updates.length} updates`,
      month: activePlan.month,
      status: 'processed'
    });
    console.log('[Status] 同步完成，且已通過逐卡與 Bio 寫入驗證。');
  } catch (error) {
    console.error('[Fatal Error] 同步失敗：', error);
    if (activePlan) {
      db.updatePlan(activePlan.id, { status: 'failed', lastError: error.message });
    }
    if (targetPost && targetHash) {
      db.savePost({ hash: targetHash, text: targetPost.text, url: '', title: '', month: activePlan?.month || `${targetMonth}月`, status: 'failed' });
    }
    process.exitCode = 1;
  } finally {
    await browserSession?.context.close().catch(() => null);
    // Dashboard launches this file with an IPC channel. Disconnect it after
    // the sync finishes so the dashboard receives the child exit event.
    if (process.connected) process.disconnect();
  }
}

main().catch(error => {
  console.error('[Fatal Error] 無法啟動同步程序：', error);
  process.exitCode = 1;
});
