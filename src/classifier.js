import { GoogleGenAI } from '@google/genai';
import fs from 'fs';
import { GEMINI_API_KEY, GEMINI_MODEL } from './config.js';

/**
 * 使用 Gemini AI 分析 Facebook 貼文內容，並對應到 Linktree 版面結構
 * @param {string} postText - Facebook 貼文文字內容
 * @param {string[]} extractedLinks - 貼文中擷取的外部連結
 * @param {Array<{title: string, url: string, type: string, active: boolean}>} linktreeStructure - 現有 Linktree 版面結構
 * @param {string|null} imagePath - 活動表圖片路徑（用於多模態分析）
 * @returns {Promise<{isMatch: boolean, month: string, closedDatesString: string, updates: Array}>}
 */
export async function classifyAndMapLinktreeUpdates(postText, extractedLinks, linktreeStructure, imagePath = null) {
  console.log('[Classifier] Running Gemini multimodal multi-item structural mapping...');

  if (!GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY is not defined in the environment variables.');
  }

  const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

  const prompt = `
You are an expert content assistant. Your job is to analyze a Facebook post from a child development center detailing their monthly activities, and dynamically map these activities to their existing Linktree admin layout.

If a calendar or activity table image is attached, you should also visually inspect it.

Here is the text of the Facebook post:
"""
${postText}
"""

Here are all the external URLs extracted from this post:
${JSON.stringify(extractedLinks, null, 2)}

Here is the current layout structure of the user's Linktree account:
${JSON.stringify(linktreeStructure, null, 2)}

Please perform the following tasks:
1. Identify which month these activities belong to (e.g., "6月").
2. **Special Closed Days Identification (特別休館日辨識)**:
   - Carefully inspect the calendar image (if provided) and the post text to find the **Special Closed Days (特別休館日)**, such as national holidays, environment waxing/cleaning, layout/theme replacement, and so on.
   - **CRITICAL RULE**: Ignore standard, fixed weekly closures (Mondays) since they are already fixed and clearly displayed on the calendar image. ONLY extract the special closed days!
   - **中文規則**：寫入 bio 的只要呈現特別的休館日，例如：國定放假日，環境打蠟，佈置更換....等。絕對不要寫入「每週一固定休館」。
   - Format them into a clean, concise string for the Linktree Bio, such as: "【休館日】 6/3(三)環境打蠟、6/10(三)佈置更換". 
   - **If there are no special closed days for this month, return an empty string "" for closedDatesString. DO NOT return "本月無特別休館日" or any placeholder text.**
3. Match and map the new activities and headers from the Facebook post to the scanned Linktree layout following these rules:
   
   - **大標題對應 (Header matching)**:
     - The scanned Linktree layout will contain items with \`type: 'header'\`. These are Linktree "Layout" blocks.
     - Match the course categories from the post (e.g., "親職講座", "外聘課程") to these existing headers.
     - Set action to \`update\` (or \`toggle_on\` if inactive) and modify their titles accordingly.
     - **CRITICAL**: 對於大標題 (Header)，新標題請**只保留**分類名稱（例如「親職講座」、「外聘課程」），**絕對不要**在標題中包含任何報名日期或時間！若舊標題有特殊符號(如⭐) 或有包含報名日期，請予以刪除，直接使用貼文中的純文字標題。若 Linktree 中有多個相同類別的 header，請**優先更新包含舊日期或被關閉(inactive)**的那一個 header，並確保它被更新與開啟。

   - **連結標題與網址更新 (Link Title & URL Sync) - 舊卡片覆蓋回收原則**:
     - **直接覆蓋舊卡片**：對於貼文中的每一個新活動，請從 Linktree 上現有的連結卡片中挑選一個「過期的舊活動」或「不需要再保留的卡片」，直接將其覆蓋更新為新活動。
     - 如果舊卡片是 active，action 設為 "update"。如果是 inactive，action 設為 "toggle_on"。
     - **禁止使用 ADD 動作**：請極力避免使用 "add"。請直接拿其他類別的過期卡片來「資源回收」覆蓋。
     
   - **強制關閉過期月份卡片 (Mandatory Toggle OFF for Past Months)**:
     - CRITICAL: After matching all new activities/headers, you MUST review ALL remaining existing cards (both \`link\` and \`header\` types).
     - If ANY remaining card's title contains a past date or past month (e.g., if the target is 7月, but the card contains 5月 or 6/23), you MUST include a \`toggle_off\` action for that card. Do not leave outdated cards active!

Provide a JSON object containing the mapping result. Ensure that "currentTitle" in the updates array EXACTLY matches the title of the card in the scanned Linktree layout so that we can find it in the DOM!

Respond ONLY with a JSON object matching the requested schema.
`;

  // 組裝多模態輸入內容
  const contents = [prompt];

  if (imagePath && fs.existsSync(imagePath)) {
    try {
      console.log(`[Classifier] Loading calendar image for multimodal analysis: ${imagePath}`);
      const imageBuffer = fs.readFileSync(imagePath);
      contents.push({
        inlineData: {
          data: imageBuffer.toString('base64'),
          mimeType: 'image/jpeg'
        }
      });
    } catch (e) {
      console.log('[Classifier] WARNING: Failed to load calendar image, falling back to text-only mode:', e.message);
    }
  }

  // 指數退避重試機制
  let retries = 5;
  let delay = 3000;
  let lastError = null;

  while (retries > 0) {
    try {
      const response = await ai.models.generateContent({
        model: GEMINI_MODEL,
        contents,
        config: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: 'OBJECT',
            properties: {
              isMatch: {
                type: 'BOOLEAN',
                description: 'True if this Facebook post contains the monthly activity table and schedules, false otherwise'
              },
              month: {
                type: 'STRING',
                description: 'The month identified in the post, e.g. "6月"'
              },
              closedDatesString: {
                type: 'STRING',
                description: 'The extracted special closed dates string formatted in Traditional Chinese. Return "" if none exist.'
              },
              updates: {
                type: 'ARRAY',
                description: 'The list of mapped updates to apply to Linktree',
                items: {
                  type: 'OBJECT',
                  properties: {
                    currentTitle: {
                      type: 'STRING',
                      description: 'The EXACT current Title of the Linktree card to locate'
                    },
                    newTitle: {
                      type: 'STRING',
                      description: 'The proposed new Title'
                    },
                    newUrl: {
                      type: 'STRING',
                      description: 'The proposed new URL. Only required for type "link" cards.'
                    },
                    type: {
                      type: 'STRING',
                      enum: ['link', 'header'],
                      description: 'The type of the Linktree card'
                    },
                    action: {
                      type: 'STRING',
                      enum: ['update', 'toggle_on', 'toggle_off', 'add'],
                      description: 'The sync action'
                    },
                    reasoning: {
                      type: 'STRING',
                      description: 'Brief explanation of mapping logic'
                    }
                  },
                  required: ['currentTitle', 'newTitle', 'type', 'action']
                }
              }
            },
            required: ['isMatch', 'month', 'closedDatesString', 'updates']
          }
        }
      });

      const resultText = response.text;
      console.log('[Classifier] Gemini raw response:', resultText);

      const jsonResult = JSON.parse(resultText);

      // ─── 確定性修正：清理 Bio 佔位文字 ─────────────────
      if (jsonResult.closedDatesString) {
        const bioText = jsonResult.closedDatesString.trim();
        if (bioText === '本月無特別休館日' || bioText === '無特別休館日' || bioText === '無') {
          console.log('[Classifier Fallback] Stripping placeholder text from Bio:', bioText);
          jsonResult.closedDatesString = '';
        }
      }

      // ─── 確定性修正：強制關閉過期月份卡片 ──────────────
      const targetMonthMatch = postText.match(/(\d+)月/);
      if (targetMonthMatch && targetMonthMatch[1]) {
        const targetMonth = parseInt(targetMonthMatch[1], 10);

        for (const card of linktreeStructure) {
          if (!card.active) continue;

          // 跳過 AI 已處理的卡片
          const isHandled = jsonResult.updates.find(u => u.currentTitle === card.title);
          if (isHandled) continue;

          // 檢查卡片標題是否以過去月份開頭（忽略前綴符號）
          const cleanTitle = card.title.replace(/^[^\d]+/, '');
          let isOld = false;
          for (let m = 1; m < targetMonth; m++) {
            const mStr = m.toString();
            const mPad = m.toString().padStart(2, '0');
            if (
              cleanTitle.startsWith(`${mStr}月`) || cleanTitle.startsWith(`${mPad}月`) ||
              cleanTitle.startsWith(`${mStr}/`) || cleanTitle.startsWith(`${mPad}/`)
            ) {
              isOld = true;
              break;
            }
          }

          if (isOld) {
            console.log(`[Classifier Fallback] Forcing TOGGLE_OFF for old card: ${card.title}`);
            jsonResult.updates.push({
              currentTitle: card.title,
              newTitle: card.title,
              type: card.type,
              action: 'toggle_off',
              newUrl: card.url,
              reasoning: 'Fallback logic: card contains past month indicator and was not updated.'
            });
          }
        }
      }

      return jsonResult;

    } catch (err) {
      lastError = err;
      retries--;
      if (retries > 0) {
        console.warn(`[Classifier] Gemini API returned error (status ${err.status || 'unknown'}): ${err.message}. Retrying in ${delay / 1000}s... (Remaining retries: ${retries})`);
        await new Promise(resolve => setTimeout(resolve, delay));
        delay *= 2;
      }
    }
  }

  console.error('[Classifier] Gemini classification and mapping failed after all retries:', lastError);
  throw lastError;
}
