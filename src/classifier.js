import { GoogleGenAI } from '@google/genai';
import fs from 'fs';
import path from 'path';
import { GEMINI_API_KEY } from './config.js';
import { chooseCheapestModel } from './model-selection.js';

export const PROMPT_VERSION = '2026-09-calendar-closure-v2';

function normalizeTitle(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function isProtectedLink(item) {
  const title = normalizeTitle(item.title);
  const collection = normalizeTitle(item.collectionTitle);
  return collection === '育兒資源' ||
    /^(歡迎加入|官方LINE|LINE官方)/i.test(title) ||
    /育兒資源|交通|聯絡我們|預約/.test(title);
}

function monthFromTitle(title) {
  const match = normalizeTitle(title).replace(/^[^\d]+/, '').match(/^(\d{1,2})(?:月|\/)/);
  return match ? Number.parseInt(match[1], 10) : null;
}

function isPastMonth(cardMonth, targetMonth) {
  if (!cardMonth || !targetMonth || cardMonth === targetMonth) return false;
  // In January, 2–12 represent the prior calendar year. Otherwise smaller
  // month numbers are the past months in the current year.
  return targetMonth === 1 ? cardMonth >= 2 : cardMonth < targetMonth;
}

function getMimeType(imagePath) {
  const extension = path.extname(imagePath).toLowerCase();
  if (extension === '.png') return 'image/png';
  if (extension === '.webp') return 'image/webp';
  return 'image/jpeg';
}

/** Build a compact safe candidate list with locally owned stable keys. */
export function buildAiCandidates(linktreeStructure) {
  return linktreeStructure
    .filter(item => item.type === 'link' && item.id && !isProtectedLink(item))
    .map((item, index) => ({
      key: `C${index + 1}`,
      id: item.id,
      title: normalizeTitle(item.title),
      collectionTitle: normalizeTitle(item.collectionTitle),
      active: Boolean(item.active),
      month: monthFromTitle(item.title)
    }));
}

function normalizeUpdates(rawUpdates, candidates) {
  const byKey = new Map(candidates.map(candidate => [candidate.key, candidate]));
  const used = new Set();
  const updates = [];

  for (const raw of rawUpdates || []) {
    const candidate = byKey.get(raw.sourceKey);
    const action = raw.action;
    if (action === 'add') {
      if (raw.section !== 'special' || !normalizeTitle(raw.newTitle)) continue;
      const addUrl = normalizeTitle(raw.newUrl) || normalizeTitle(raw.sourcePostUrl);
      if (!addUrl) continue;
      updates.push({
        planKey: `NEW-SPECIAL-${updates.filter(update => update.action === 'add').length + 1}`,
        id: '',
        currentTitle: '',
        collectionTitle: '特別活動',
        type: 'link',
        action: 'add',
        newTitle: normalizeTitle(raw.newTitle),
        newUrl: addUrl
      });
      continue;
    }
    if (!candidate || used.has(candidate.key)) continue;
    if (raw.section === 'special' && candidate.collectionTitle !== '特別活動') continue;
    if (!['update', 'toggle_on', 'toggle_off'].includes(action)) continue;
    if (action !== 'toggle_off' && !normalizeTitle(raw.newTitle)) continue;
    const url = normalizeTitle(raw.newUrl) || (raw.section === 'special' ? normalizeTitle(raw.sourcePostUrl) : '');
    if (action !== 'toggle_off' && !url) continue;

    used.add(candidate.key);
    updates.push({
      planKey: candidate.key,
      id: candidate.id,
      currentTitle: candidate.title,
      collectionTitle: candidate.collectionTitle,
      type: 'link',
      action,
      newTitle: action === 'toggle_off' ? candidate.title : normalizeTitle(raw.newTitle),
      newUrl: action === 'toggle_off' ? '' : url
    });
  }
  return updates;
}

function activityDateKey(title) {
  const match = normalizeTitle(title).replace(/^[^\d]+/, '').match(/^(\d{1,2})(?:月|\/)(\d{1,2})?/);
  if (!match) return null;
  const month = Number(match[1]);
  const day = Number(match[2] || 0);
  return month >= 1 && month <= 12 && day >= 0 && day <= 31 ? month * 100 + day : null;
}

/**
 * Assign dated activities to existing card positions from top to bottom.
 * Linktree's nested drag targets can move a card outside its Collection, so
 * reuse the stable positions instead of moving the cards themselves.
 */
export function assignUpdatesToDateSlots(updates, candidates, targetMonth) {
  const collections = new Set(updates
    .filter(update => update.collectionTitle && update.action !== 'toggle_off' && activityDateKey(update.newTitle) !== null)
    .map(update => update.collectionTitle));
  const result = updates.filter(update => !collections.has(update.collectionTitle));

  for (const collectionTitle of collections) {
    const slots = candidates.filter(candidate => candidate.collectionTitle === collectionTitle);
    const desired = updates
      .filter(update => update.collectionTitle === collectionTitle && update.action !== 'toggle_off')
      .map((update, index) => ({ update, index, date: activityDateKey(update.newTitle) }));
    if (desired.some(item => item.date === null)) {
      throw new Error(`Collection「${collectionTitle}」有無法辨識日期的活動。`);
    }
    if (targetMonth && desired.some(item => Math.floor(item.date / 100) !== targetMonth)) {
      throw new Error(`Collection「${collectionTitle}」包含非目標月份的活動。`);
    }
    desired.sort((left, right) => left.date - right.date || left.index - right.index);

    if (desired.length > slots.length && collectionTitle !== '特別活動') {
      throw new Error(`Collection「${collectionTitle}」只有 ${slots.length} 張卡片，無法依日期容納 ${desired.length} 項活動。`);
    }

    const selectedIds = new Set();
    for (let index = 0; index < desired.length; index++) {
      const slot = slots[index];
      const source = desired[index].update;
      if (!slot) {
        result.push({ ...source, planKey: `NEW-SPECIAL-SLOT-${index + 1}`, id: '', currentTitle: '', action: 'add' });
        continue;
      }
      selectedIds.add(slot.id);
      result.push({
        ...source,
        planKey: slot.key,
        id: slot.id,
        currentTitle: slot.title,
        collectionTitle,
        action: 'update'
      });
    }

    const explicitOffIds = new Set(updates
      .filter(update => update.collectionTitle === collectionTitle && update.action === 'toggle_off')
      .map(update => update.id));
    for (const slot of slots) {
      if (selectedIds.has(slot.id) || !slot.active) continue;
      if (!explicitOffIds.has(slot.id) && !isPastMonth(slot.month, targetMonth)) {
        throw new Error(`Collection「${collectionTitle}」仍有未對應的有效卡片「${slot.title}」，已停止以免漏掉活動。`);
      }
      result.push({
        planKey: slot.key,
        id: slot.id,
        currentTitle: slot.title,
        collectionTitle,
        type: 'link',
        action: 'toggle_off',
        newTitle: slot.title,
        newUrl: ''
      });
    }
  }

  return result;
}

export function closureBioFromCalendar(result, targetMonth) {
  if (!result.isCalendarImage || Number(result.calendarMonth) !== targetMonth) {
    throw new Error(`圖片不是 ${targetMonth} 月課表，已停止以免漏寫休館資訊。`);
  }
  const cells = result.shadedDays;
  if (!Array.isArray(cells)) throw new Error('AI 未回報課表的深色日期格。');
  const seenDays = new Set();
  const closures = [];
  let weeklyCount = 0;
  for (const cell of cells) {
    const day = Number(cell.day);
    const label = normalizeTitle(cell.label);
    if (!Number.isInteger(day) || day < 1 || day > 31 || seenDays.has(day)) {
      throw new Error(`課表深色日期格有重複或無效日期：${cell.day}`);
    }
    seenDays.add(day);
    if (cell.kind === 'weekly') {
      if (cell.weekday !== 'Mon') throw new Error(`${targetMonth}/${day} 被誤判為星期一固定休館。`);
      weeklyCount++;
    } else if (cell.kind === 'special') {
      if (['Mon', 'Sun'].includes(cell.weekday) || !label) {
        throw new Error(`${targetMonth}/${day} 的特殊休館證據不足。`);
      }
      closures.push({ day, label });
    } else if (cell.kind === 'uncertain') {
      throw new Error(`${targetMonth}/${day}「${label || '深色日期格'}」是否休館不明，需人工確認後才能寫入 Bio。`);
    } else {
      throw new Error(`${targetMonth}/${day} 的深色日期格分類無效。`);
    }
  }
  if (weeklyCount < 3) {
    throw new Error('課表未辨識出足夠的星期一灰色格，可能抓錯圖片或漏讀日期。');
  }
  return closures.sort((a, b) => a.day - b.day)
    .map(({ day, label }) => `${targetMonth}/${day} ${/(?:休館|補休|補假)/.test(label) ? label : `${label}（休館）`}`)
    .join('、');
}

/**
 * Use Gemini only for ambiguous content extraction and candidate selection.
 * The returned plan is normalised against locally scanned Linktree IDs.
 */
export async function classifyAndMapLinktreeUpdates(
  postText,
  extractedLinks,
  linktreeStructure,
  imagePath = null,
  targetMonth = null,
  sourcePostUrl = ''
) {
  console.log('[Classifier] Running compact Gemini mapping plan...');
  if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is not defined in the environment variables.');
  if (!imagePath || !fs.existsSync(imagePath)) {
    throw new Error('找不到此貼文的月課表圖片；休館日可能只在圖片中，已停止產生計畫。');
  }

  const candidates = buildAiCandidates(linktreeStructure);
  const compactCandidates = candidates.map(({ key, title, collectionTitle, active, month }) => ({
    key, title, collection: collectionTitle, active, month
  }));

  const prompt = `
Return JSON only. Analyze this monthly child-development-center Facebook post.
Target month: ${targetMonth ? `${targetMonth}月` : 'infer from the post'}.

Tasks:
1. Set isMatch true only if this is the target monthly activity post.
2. Inspect the attached calendar image cell by cell. Report isCalendarImage, calendarMonth, and shadedDays. The monthly calendars use pale/light cells for ordinary activities and darker gray/blue-gray blocks for CLOSED days, often with large white text. Every dark date cell means closed, regardless of whether its label says 休館: a dark cell labelled 聯合參訪 is also a special closure. Calendar theme/background art is not evidence; compare individual date cells. List every dark Monday of the target month as kind "weekly". List every dark Tue-Sat cell as kind "special", with its exact date and label. Use "uncertain" only when the cell shade or date is genuinely unreadable. Also include an explicit closure from post text even if its image cell is not dark. Exclude Sundays, adjacent-month dates, registration reminders, and white activity boxes. Do not omit a dark Tue-Sat cell just because the post text does not mention it.
3. For every new activity that needs a Linktree card, choose exactly one candidate key and return update or toggle_on. Reuse existing cards whenever a matching section has a spare card.
4. **特別活動 is mandatory**: find every dated item beneath the 「特別活動」 heading. For each one set section to "special" and choose a candidate whose collection is exactly 「特別活動」. If there are more special activities than reusable special candidates, return action "add" with an empty sourceKey for the extra cards. If it has no registration URL, use this source post URL: ${sourcePostUrl || 'unavailable'}.
5. Before responding, make sure every beclass.com registration URL in the post is included once in an update. Do not omit a course merely because it appears after other courses.
6. For obsolete monthly activity cards, return toggle_off. Permanent resources are not candidates.

Post text:
${postText}

Extracted URLs:
${JSON.stringify(extractedLinks)}

Reusable Linktree candidates:
${JSON.stringify(compactCandidates)}
`;

  const imageBuffer = fs.readFileSync(imagePath);
  const contents = [prompt, { inlineData: { data: imageBuffer.toString('base64'), mimeType: getMimeType(imagePath) } }];

  const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
  const selection = await chooseCheapestModel(ai);
  console.log(`[Classifier] 已選用 ${selection.model}；標準費率每百萬輸入 $${selection.input}、輸出 $${selection.output} 美元（以 10,000 輸入／2,000 輸出 token 估算）。`);
  let modelIndex = 0;
  let retries = 3;
  let delay = 1500;
  let lastError;

  while (retries > 0) {
    try {
      const response = await ai.models.generateContent({
        model: selection.candidates[modelIndex].model,
        contents,
        config: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: 'OBJECT',
            properties: {
              isMatch: { type: 'BOOLEAN' },
              month: { type: 'STRING' },
              isCalendarImage: { type: 'BOOLEAN' },
              calendarMonth: { type: 'INTEGER' },
              shadedDays: {
                type: 'ARRAY',
                items: {
                  type: 'OBJECT',
                  properties: {
                    day: { type: 'INTEGER' },
                    weekday: { type: 'STRING', enum: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] },
                    label: { type: 'STRING' },
                    kind: { type: 'STRING', enum: ['weekly', 'special', 'uncertain'] }
                  },
                  required: ['day', 'weekday', 'label', 'kind']
                }
              },
              updates: {
                type: 'ARRAY',
                items: {
                  type: 'OBJECT',
                  properties: {
                    sourceKey: { type: 'STRING' },
                    action: { type: 'STRING', enum: ['update', 'toggle_on', 'toggle_off', 'add'] },
                    section: { type: 'STRING', enum: ['regular', 'special'] },
                    newTitle: { type: 'STRING' },
                    newUrl: { type: 'STRING' }
                  },
                  required: ['sourceKey', 'action']
                }
              }
            },
            required: ['isMatch', 'month', 'isCalendarImage', 'calendarMonth', 'shadedDays', 'updates']
          }
        }
      });

      const rawResult = JSON.parse(response.text);
      const closedDatesString = closureBioFromCalendar(rawResult, targetMonth);
      const updates = normalizeUpdates(
        (rawResult.updates || []).map(update => ({ ...update, sourcePostUrl })),
        candidates
      );

      const expectedBeclassUrls = new Set(
        [...String(postText).matchAll(/https:\/\/www\.beclass\.com\/rid=[^\s<>"）)]+/g)]
          .map(match => match[0])
      );
      const plannedUrls = new Set(updates.map(update => update.newUrl));
      const missingBeclassUrls = [...expectedBeclassUrls].filter(url => !plannedUrls.has(url));
      if (missingBeclassUrls.length) {
        throw new Error(`AI 未完整對應 ${missingBeclassUrls.length} 個 BeClass 報名連結。`);
      }

      const specialText = String(postText).match(/特別活動([\s\S]*?)(?:外聘課程|親職講座|育兒資源|請留意|$)/)?.[1] || '';
      const expectedSpecialCount = [...specialText.matchAll(/\d{1,2}\/\d{1,2}/g)].length;
      const plannedSpecialCount = updates.filter(update => update.collectionTitle === '特別活動' && update.action !== 'toggle_off').length;
      if (expectedSpecialCount > plannedSpecialCount) {
        throw new Error(`AI 未完整對應特別活動：預期 ${expectedSpecialCount} 項，目前 ${plannedSpecialCount} 項。`);
      }

      // This deterministic cleanup costs no model output tokens.
      const handledIds = new Set(updates.map(update => update.id));
      for (const candidate of candidates) {
        if (candidate.active && !handledIds.has(candidate.id) && isPastMonth(candidate.month, targetMonth)) {
          updates.push({
            planKey: candidate.key,
            id: candidate.id,
            currentTitle: candidate.title,
            collectionTitle: candidate.collectionTitle,
            type: 'link',
            action: 'toggle_off',
            newTitle: candidate.title,
            newUrl: ''
          });
        }
      }

      const orderedUpdates = assignUpdatesToDateSlots(updates, candidates, targetMonth);
      console.log(`[Classifier] Generated ${orderedUpdates.length} validated updates from ${candidates.length} reusable candidates.`);
      return {
        isMatch: Boolean(rawResult.isMatch),
        month: rawResult.month,
        calendarMonth: Number(rawResult.calendarMonth),
        closedDatesString,
        shadedDays: rawResult.shadedDays,
        modelSelection: { ...selection, ...selection.candidates[modelIndex] },
        updates: orderedUpdates
      };
    } catch (error) {
      lastError = error;
      const modelUnavailable = Number(error?.status) === 404 && /not found|not available|no longer available/i.test(String(error?.message || ''));
      if (modelUnavailable && modelIndex + 1 < selection.candidates.length) {
        modelIndex++;
        const next = selection.candidates[modelIndex];
        console.warn(`[Classifier] 模型不可用，改用 ${next.model}；標準費率每百萬輸入 $${next.input}、輸出 $${next.output} 美元。`);
        continue;
      }
      retries--;
      const status = Number(error?.status);
      const retryable = status === 429 || status >= 500 ||
        /ECONNRESET|ETIMEDOUT|ENOTFOUND|fetch failed/i.test(String(error?.message || error?.cause?.message || ''));
      if (!retryable || retries === 0) break;
      console.warn(`[Classifier] Retryable Gemini error; retrying in ${delay}ms (${retries} remaining).`);
      await new Promise(resolve => setTimeout(resolve, delay));
      delay *= 2;
    }
  }

  throw lastError;
}
