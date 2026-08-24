import { chromium } from 'playwright';
import fs from 'fs';
import { BROWSER_DATA_DIR, BROWSER_OPTIONS, isUrl } from './config.js';

// ─── Browser Session ────────────────────────────────────

/**
 * 啟動瀏覽器並開啟 Linktree Admin 後台
 * @returns {Promise<{page: import('playwright').Page, context: import('playwright').BrowserContext}>}
 */
export async function launchLinktreeSession() {
  console.log('[Linktree] Launching browser session...');
  if (!fs.existsSync(BROWSER_DATA_DIR)) {
    throw new Error('Browser session data not found. Please run "npm run setup" first.');
  }

  const context = await chromium.launchPersistentContext(BROWSER_DATA_DIR, BROWSER_OPTIONS);
  const page = await context.newPage();

  console.log('[Linktree] Navigating to Linktree Admin...');
  await page.goto('https://linktr.ee/admin', { waitUntil: 'domcontentloaded' });

  // 等待 React hydration
  console.log('[Linktree] Waiting for dashboard to load...');
  await page.waitForTimeout(5000);

  if (page.url().includes('linktr.ee/login') || page.url().includes('linktr.ee/register')) {
    await context.close();
    throw new Error('Session expired. Please run "npm run setup" to re-authenticate.');
  }

  return { page, context };
}

// ─── Page Scanning ──────────────────────────────────────

/**
 * 掃描 Linktree 後台所有卡片（Header 與 Link），含啟用/停用狀態
 * @param {import('playwright').Page} page
 * @returns {Promise<Array<{title: string, url: string, type: string, active: boolean}>>}
 */
export async function scanLinktreeItems(page) {
  console.log('[Linktree] Scanning existing profile structure...');

  // 等待表單元素出現（確保 React 已完成載入）
  console.log('[Linktree] Waiting for dashboard inputs to render...');
  try {
    await page.waitForSelector('input[name="title"]', { timeout: 15000 });
  } catch (_) {
    console.log('[Linktree] Timeout waiting for input[name="title"]. Trying fallback input wait...');
    try {
      await page.waitForSelector('input', { timeout: 5000 });
    } catch (_) {}
  }

  // 額外緩衝，確保所有卡片渲染完成
  console.log('[Linktree] Safe rendering buffer...');
  await page.waitForTimeout(3000);

  const items = [];
  const titleInputs = await page.locator('input[name="title"]').all();
  console.log(`[Linktree] Found ${titleInputs.length} card title inputs on dashboard.`);

  for (const titleInput of titleInputs) {
    try {
      const title = (await titleInput.inputValue() || '').trim();
      if (!title) continue;

      let cardContainer = titleInput.locator('xpath=ancestor::div[contains(@data-testid, "LinkEditor") or contains(@class, "Card")][1]');
      if (await cardContainer.count() === 0) {
        cardContainer = titleInput.locator('xpath=ancestor::div[4]');
      }

      const urlInput = cardContainer.locator('input[name="url"]').first();
      let url = '';
      let type = 'header';
      if (await urlInput.count() > 0) {
        url = (await urlInput.inputValue() || '').trim();
        type = 'link';
      }

      const toggle = cardContainer.locator('button[role="switch"], input[name="active"], input[type="checkbox"]').first();
      let active = true;
      if (await toggle.count() > 0) {
        const ariaChecked = await toggle.getAttribute('aria-checked');
        const isChecked = await toggle.evaluate(el => el.checked).catch(() => null);
        if (ariaChecked !== null) {
          active = ariaChecked === 'true';
        } else if (isChecked !== null) {
          active = isChecked;
        } else {
          const checkedAttr = await toggle.getAttribute('checked');
          active = checkedAttr !== null;
        }
      }

      items.push({ title, url, type, active });
    } catch (_) {
      // 忽略單一卡片解析錯誤
    }
  }

  console.log(`[Linktree] Successfully scanned ${items.length} items:`, items);
  return items;
}

// ─── Bio Update ─────────────────────────────────────────

/**
 * 更新 Profile Bio（簡介）的特別休館日資訊
 * 流程：點選 Bio → 清空 → 填入新內容（若有）→ 點選 Save → 等待 5 秒
 * @param {import('playwright').Page} page
 * @param {string} closedDatesString - 休館日文字，空字串表示清空 Bio
 */
export async function updateLinktreeBio(page, closedDatesString) {
  const textToWrite = closedDatesString || '';

  console.log(`[Linktree] Updating Profile Bio with: "${textToWrite}"`);
  try {
    // 1. 點選 Bio 區域以開啟編輯器
    const profileTextSelectors = [
      page.getByText('@kcindaan').first(),
      page.getByText('Profile Preview').first(),
      page.getByText('休館日').first()
    ];

    for (const selector of profileTextSelectors) {
      if (await selector.count() > 0 && await selector.isVisible().catch(() => false)) {
        console.log('[Linktree] Found profile area text, clicking to open Bio editor...');
        await selector.click();
        await page.waitForTimeout(1500);
        break;
      }
    }

    // 2. 定位 Bio textarea
    const bioTextarea = page.locator('textarea[data-testid="ProfileBioTextArea"]').first();

    if (await bioTextarea.count() > 0) {
      // 3. 清空 Bio 內容
      await bioTextarea.click();
      await page.waitForTimeout(500);

      // 全選文字
      await bioTextarea.click({ clickCount: 3 });
      await page.waitForTimeout(200);
      await bioTextarea.press('Meta+A').catch(() => null);
      await bioTextarea.press('Control+A').catch(() => null);
      await page.waitForTimeout(200);

      // 刪除文字
      await bioTextarea.press('Backspace');
      await page.waitForTimeout(500);

      // 透過 React 原生 setter 強制清空狀態
      await bioTextarea.evaluate(el => {
        const nativeSetter = Object.getOwnPropertyDescriptor(
          window.HTMLTextAreaElement.prototype, 'value'
        ).set;
        if (nativeSetter) {
          nativeSetter.call(el, '');
        } else {
          el.value = '';
        }
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await page.waitForTimeout(500);

      // 4. 填入新內容（若有）
      if (textToWrite) {
        await bioTextarea.fill(textToWrite, { force: true });
        await page.waitForTimeout(500);
      }

      // 5. 點選 Save 按鈕
      const saveBtn = page.locator('button').filter({ hasText: /^(Save|儲存)$/ }).last();

      if (await saveBtn.isVisible().catch(() => false)) {
        console.log('[Linktree] Found "Save/儲存" button, clicking...');
        await saveBtn.click();
      } else {
        console.log('[Linktree] Could not find Save button, pressing Tab + Enter as fallback...');
        await bioTextarea.press('Tab');
        await page.waitForTimeout(200);
        await page.keyboard.press('Enter');
      }

      // 6. 等待 hover 消失並儲存完成
      console.log('[Linktree] Waiting 5 seconds for save to complete...');
      await page.waitForTimeout(5000);
      console.log('[Linktree] Profile Bio successfully updated and saved.');
    } else {
      console.log('[Linktree] WARNING: Could not locate Bio textarea (data-testid="ProfileBioTextArea"). Skipped.');
    }
  } catch (err) {
    console.log('[Linktree] Non-critical error updating Profile Bio:', err.message);
  }
}

// ─── Card Input Helpers ─────────────────────────────────

/**
 * 可靠地清除 React 控制的 input 並輸入新文字
 * Linktree 的 UI 有 <p> 標籤元素覆蓋在 <input> 上方，攔截指標事件。
 * 解法：使用 JavaScript 強制 focus，再用鍵盤操作。
 * @param {import('playwright').Page} page
 * @param {import('playwright').Locator} inputLocator
 * @param {string} newText
 */
async function clearAndType(page, inputLocator, newText) {
  // 嘗試點擊覆蓋在 input 上方的 label 元素
  try {
    const parentContainer = inputLocator.locator('..');
    const label = parentContainer.locator('p[data-testid="title_Input_V1Label"], p[data-testid*="Label"]').first();
    if (await label.count() > 0 && await label.isVisible().catch(() => false)) {
      await label.click();
      await page.waitForTimeout(500);
    }
  } catch (_) {
    // label 點擊失敗，使用備援方案
  }

  // 透過 JavaScript 強制 focus input（繞過指標事件攔截）
  await inputLocator.evaluate(el => {
    el.focus();
    el.click();
  });
  await page.waitForTimeout(500);

  // 全選文字
  await inputLocator.evaluate(el => el.select());
  await page.waitForTimeout(200);

  // 刪除選取的文字
  await inputLocator.press('Backspace');
  await page.waitForTimeout(300);

  // 驗證是否清空；若未清空，透過 React 原生 setter 強制清除
  const remaining = await inputLocator.inputValue();
  if (remaining && remaining.trim().length > 0) {
    await inputLocator.evaluate(el => {
      const nativeSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype, 'value'
      ).set;
      nativeSetter.call(el, '');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.waitForTimeout(300);
  }

  // 逐字輸入新文字，確保 React state 同步
  await inputLocator.type(newText, { delay: 10 });
  await page.waitForTimeout(300);

  // 觸發 blur/save
  await inputLocator.press('Tab');
  await page.waitForTimeout(2000);
}

/**
 * 在卡片表單中找到 title input 和 URL input
 * @param {import('playwright').Locator} form
 * @returns {Promise<{titleInput: import('playwright').Locator|null, urlInput: import('playwright').Locator|null}>}
 */
async function findCardInputs(form) {
  const inputs = await form.locator('input, textarea').all();
  let titleInput = null;
  let urlInput = null;

  for (const input of inputs) {
    const inputType = (await input.getAttribute('type') || 'text').toLowerCase();
    if (['number', 'hidden', 'email', 'password', 'checkbox', 'radio', 'file'].includes(inputType)) {
      continue;
    }

    const val = (await input.inputValue() || '').trim();

    if (isUrl(val)) {
      urlInput = input;
    } else if (val.length > 0) {
      titleInput = input;
    }
  }

  return { titleInput, urlInput };
}

// ─── Card Updates ───────────────────────────────────────

/**
 * 將更新清單套用至 Linktree（標題/URL 變更、Toggle 開關、新增卡片）
 * @param {import('playwright').Page} page
 * @param {Array<{currentTitle: string, newTitle: string, newUrl?: string, type: string, action: string}>} updates
 */
export async function applyLinktreeUpdates(page, updates) {
  console.log(`[Linktree] Applying ${updates.length} updates...`);

  // 排序：TOGGLE_OFF → UPDATE → TOGGLE_ON → ADD
  const actionOrder = { 'toggle_off': 0, 'update': 1, 'toggle_on': 2, 'add': 3 };
  const sortedUpdates = [...updates].sort((a, b) => {
    return (actionOrder[a.action] || 1) - (actionOrder[b.action] || 1);
  });

  console.log(`[Linktree] Processing order: ${sortedUpdates.map(u => u.action.toUpperCase()).join(' → ')}`);

  for (const update of sortedUpdates) {
    const { currentTitle, newTitle, newUrl, type, action } = update;
    console.log(`\n[Linktree] ─── Applying [${action.toUpperCase()}] ───`);
    console.log(` 👉 Current Title: "${currentTitle}"`);
    console.log(` 👉 New Title    : "${newTitle}"`);
    if (newUrl) console.log(` 👉 New URL      : "${newUrl}"`);

    // ─── ADD：建立全新卡片 ────────────────────────────
    if (action === 'add') {
      await handleAddCard(page, newTitle, newUrl, type);
      continue;
    }

    // ─── 尋找現有卡片 ────────────────────────────────
    const titleInputs = await page.locator('input[name="title"]').all();
    let card = null;
    let cardTitleInput = null;
    let cardUrlInput = null;

    for (const titleInput of titleInputs) {
      const val = (await titleInput.inputValue() || '').trim();
      if (!val || val.length < 2) continue;

      // 精確匹配或部分匹配
      if (
        val === currentTitle ||
        (val.length >= 4 && currentTitle.includes(val)) ||
        (currentTitle.length >= 4 && val.includes(currentTitle))
      ) {
        cardTitleInput = titleInput;
        card = titleInput.locator('xpath=ancestor::div[contains(@data-testid, "LinkEditor") or contains(@class, "Card")][1]');
        if (await card.count() === 0) {
          card = titleInput.locator('xpath=ancestor::div[4]');
        }
        const urlInp = card.locator('input[name="url"]').first();
        if (await urlInp.count() > 0) {
          cardUrlInput = urlInp;
        }
        break;
      }
    }

    if (!card || !cardTitleInput) {
      console.log(`[Linktree] ⚠️ WARNING: Could not locate card with Title "${currentTitle}". Skipping.`);
      continue;
    }

    console.log('[Linktree] ✅ Found matching card.');
    const toggle = card.locator('button[role="switch"], input[name="active"], input[type="checkbox"]').first();

    // ─── TOGGLE_OFF：停用卡片 ─────────────────────────
    if (action === 'toggle_off') {
      if (await toggle.count() > 0) {
        const isActive = await toggle.evaluate(
          el => el.checked || el.getAttribute('aria-checked') === 'true'
        ).catch(() => false);

        if (isActive) {
          console.log('[Linktree] Clicking toggle to deactivate...');
          await toggle.evaluate(el => el.click());
          await page.waitForTimeout(1500);
          console.log('[Linktree] ✅ Card deactivated.');
        } else {
          console.log('[Linktree] Card is already inactive.');
        }
      }
      continue;
    }

    // ─── TOGGLE_ON / UPDATE：啟用卡片（若已停用）──────
    if (action === 'toggle_on' || action === 'update') {
      if (await toggle.count() > 0) {
        const isActive = await toggle.evaluate(
          el => el.checked || el.getAttribute('aria-checked') === 'true'
        ).catch(() => false);

        if (!isActive) {
          console.log(`[Linktree] Card is currently off. Clicking toggle to activate for ${action}...`);
          await toggle.evaluate(el => el.click());
          await page.waitForTimeout(1500);
          console.log('[Linktree] ✅ Card activated.');
        }
      }
    }

    // ─── 1. 先更新 URL（若有），讓 Linktree 先完成網頁標題自動抓取 ────────
    if (type === 'link' && newUrl) {
      const targetUrlInput = card.locator('input[name="url"]').first();

      if (await targetUrlInput.count() > 0) {
        const currentUrl = (await targetUrlInput.inputValue() || '').trim();
        if (currentUrl !== newUrl) {
          console.log(`[Linktree] Clearing old URL "${currentUrl}" and typing new URL...`);
          await clearAndType(page, targetUrlInput, newUrl);

          const updatedUrl = await targetUrlInput.inputValue();
          if (updatedUrl && updatedUrl.trim() === newUrl.trim()) {
            console.log('[Linktree] ✅ URL updated successfully.');
          } else {
            console.log(`[Linktree] ⚠️ URL verification: got "${updatedUrl}", expected "${newUrl}"`);
            try {
              await targetUrlInput.click({ clickCount: 3 });
              await page.waitForTimeout(200);
              await targetUrlInput.fill(newUrl);
              await targetUrlInput.press('Tab');
              await page.waitForTimeout(1500);
              console.log('[Linktree] Retried URL update with fill().');
            } catch (e) {
              console.log('[Linktree] URL retry also failed:', e.message);
            }
          }
          console.log('[Linktree] Waiting 2.5s for Linktree auto-title fetch buffer...');
          await page.waitForTimeout(2500);
        } else {
          console.log('[Linktree] URL unchanged. Skipping URL update.');
        }
      } else {
        console.log('[Linktree] ⚠️ Could not find URL input in this card.');
      }
    }

    // ─── 2. 再更新標題（徹底覆蓋 Linktree 自動抓取的網頁標題，確保維護 FB 貼文標題）───
    if (newTitle) {
      const targetTitleInput = card.locator('input[name="title"]').first();
      if (await targetTitleInput.count() > 0) {
        console.log(`[Linktree] Clearing title and typing FB post title: "${newTitle}"...`);
        await clearAndType(page, targetTitleInput, newTitle);

        const updatedTitle = await targetTitleInput.inputValue();
        if (updatedTitle && updatedTitle.trim() === newTitle.trim()) {
          console.log('[Linktree] ✅ Title updated successfully to FB post title.');
        } else {
          console.log(`[Linktree] ⚠️ Title verification: got "${updatedTitle}", expected "${newTitle}"`);
          // 備援重試
          try {
            await targetTitleInput.click({ clickCount: 3 });
            await page.waitForTimeout(200);
            await targetTitleInput.fill(newTitle);
            await targetTitleInput.press('Tab');
            await page.waitForTimeout(1500);
            console.log('[Linktree] Retried title update with fill().');
          } catch (e) {
            console.log('[Linktree] Retry also failed:', e.message);
          }
        }
      }
    } else {
      console.log('[Linktree] No new title provided. Skipping title update.');
    }

    console.log('[Linktree] ✅ Card update complete.');
  }

  await page.waitForTimeout(2000);
  console.log('\n[Linktree] ═══ All card updates finished. ═══');
}

// ─── Private: Add Card ──────────────────────────────────

/**
 * 新增一張全新的 Linktree 卡片
 * @param {import('playwright').Page} page
 * @param {string} newTitle
 * @param {string} newUrl
 * @param {string} type
 */
async function handleAddCard(page, newTitle, newUrl, type) {
  console.log('[Linktree] Creating new card...');
  try {
    const addButtonSelectors = [
      'button:has-text("Add link")',
      'button:has-text("Add Link")',
      'button:has-text("新增連結")',
      'button:has-text("Add")',
      'a:has-text("Add link")',
      'button:has-text("Add new link")',
      '[data-testid="LinkAddButton"]',
      '[data-testid="add-link-button"]'
    ];

    let addClicked = false;
    for (const selector of addButtonSelectors) {
      const btn = page.locator(selector).first();
      if (await btn.isVisible().catch(() => false)) {
        await btn.click();
        addClicked = true;
        console.log(`[Linktree] Clicked add button: "${selector}"`);
        await page.waitForTimeout(3000);
        break;
      }
    }

    if (!addClicked) {
      console.log('[Linktree] WARNING: Could not find "Add Link" button. Skipping ADD action.');
      return;
    }

    // 新卡片通常出現在最上方
    const forms = await page.locator('form').all();
    let newCard = null;

    for (const form of forms) {
      const { titleInput } = await findCardInputs(form);
      if (titleInput) {
        const val = (await titleInput.inputValue() || '').trim();
        if (!val || val === 'Title' || val === '標題') {
          newCard = form;
          break;
        }
      }
    }

    if (newCard) {
      const { titleInput, urlInput } = await findCardInputs(newCard);

      if (titleInput) {
        console.log('[Linktree] Filling new card title...');
        await clearAndType(page, titleInput, newTitle);
        console.log('[Linktree] ✅ New card title set.');
      }

      if (type === 'link' && newUrl) {
        await page.waitForTimeout(1000);
        const updatedInputs = await findCardInputs(newCard);
        const targetUrlInput = updatedInputs.urlInput || urlInput;

        if (targetUrlInput) {
          console.log('[Linktree] Filling new card URL...');
          await clearAndType(page, targetUrlInput, newUrl);
          console.log('[Linktree] ✅ New card URL set.');
        } else {
          // 嘗試尋找空的 URL placeholder input
          const allInputs = await newCard.locator('input').all();
          for (const inp of allInputs) {
            const inputType = (await inp.getAttribute('type') || 'text').toLowerCase();
            if (['number', 'hidden', 'checkbox', 'radio', 'file'].includes(inputType)) continue;
            const val = (await inp.inputValue() || '').trim();
            const placeholder = (await inp.getAttribute('placeholder') || '').toLowerCase();
            if (!val && (placeholder.includes('url') || placeholder.includes('link') || placeholder.includes('http'))) {
              console.log('[Linktree] Found URL placeholder input. Filling...');
              await clearAndType(page, inp, newUrl);
              console.log('[Linktree] ✅ New card URL set via placeholder match.');
              break;
            }
          }
        }
      }

      console.log('[Linktree] ✅ New card created successfully!');
    } else {
      console.log('[Linktree] WARNING: Could not find the newly created card form. Skipping.');
    }
  } catch (addErr) {
    console.log('[Linktree] Error creating new card:', addErr.message);
  }
}
