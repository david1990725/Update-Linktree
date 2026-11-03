import { chromium } from 'playwright';
import fs from 'fs';
import {
  BROWSER_DATA_DIR,
  BROWSER_OPTIONS,
  LINKTREE_ADMIN_URL,
  LINKTREE_HEADER_URL,
  isUrl
} from './config.js';

const NEW_UI_LINKS_PANEL = '#layout-unified-editor-panel-links';

function normalizeTitle(value) {
  return String(value || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function waitForPageReady(page) {
  await page.waitForTimeout(1500);
  try {
    await page.waitForSelector('body', { timeout: 10000 });
  } catch (_) {
    // The page may already be usable even if the body selector timed out.
  }
}

async function isNewLinktreeLinksPage(page) {
  return page.url().includes('/admin/links') &&
    !page.url().includes('/admin/links/edit/') &&
    await page.locator(NEW_UI_LINKS_PANEL).count() > 0;
}

async function waitForNewUiContent(page) {
  await page.waitForSelector(
    `${NEW_UI_LINKS_PANEL} button[data-block-id], ${NEW_UI_LINKS_PANEL} button:has-text("Add collection")`,
    { timeout: 20000 }
  );
}

/**
 * Return the top-level Collections without assuming that all of them can stay
 * open at once. The new Linktree UI behaves like an accordion: opening one
 * Collection collapses the previous one.
 */
async function getNewUiCollectionRefs(page) {
  const topLevelItems = await page.locator(`${NEW_UI_LINKS_PANEL} li[data-sortable-item]`).all();
  const refs = [];

  for (const item of topLevelItems) {
    const blockButton = item.locator('button[data-block-id]').first();
    if (await blockButton.count() === 0) continue;

    const id = await blockButton.getAttribute('data-block-id');
    if (!id) continue;

    // A normal top-level link has a matching data-link-id. A Collection does
    // not; its child links have different ids.
    if (await item.locator(`[data-link-id="${id}"]`).count() > 0) continue;
    refs.push({ id, title: normalizeTitle(await blockButton.innerText().catch(() => '')) });
  }

  return refs;
}

async function openNewUiCollection(page, id) {
  const item = page.locator(
    `${NEW_UI_LINKS_PANEL} li[data-sortable-item] button[data-block-id="${id}"]`
  ).first().locator('xpath=ancestor::li[@data-sortable-item][1]');
  if (await item.count() === 0) return null;

  if (await item.locator('input[data-testid="collection-title-input"]').count() === 0) {
    const button = item.locator('button[data-block-id]').first();
    console.log(`[Linktree] Expanding collection: ${normalizeTitle(await button.innerText().catch(() => ''))}`);
    await button.click();
    await page.waitForTimeout(450);
  }
  return item;
}

async function readNewUiCardTitle(card) {
  const titleNode = card.locator('span.truncate').first();
  if (await titleNode.count() > 0) {
    return normalizeTitle(await titleNode.innerText());
  }

  const firstLine = (await card.innerText().catch(() => '')).split('\n')[0];
  return normalizeTitle(firstLine);
}

async function readCollectionTitleForCard(card) {
  const collection = card.locator('xpath=ancestor::li[@data-sortable-item][1]');
  const titleInput = collection.locator('input[data-testid="collection-title-input"]').first();
  if (await titleInput.count() > 0) {
    return normalizeTitle(await titleInput.inputValue());
  }
  return '';
}

async function scanNewUiItems(page) {
  const items = [];

  // Scan normal top-level links before opening any Collection.
  const topLevelItems = await page.locator(`${NEW_UI_LINKS_PANEL} li[data-sortable-item]`).all();
  for (const item of topLevelItems) {
    const blockButton = item.locator('button[data-block-id]').first();
    if (await blockButton.count() === 0) continue;
    const id = await blockButton.getAttribute('data-block-id');
    if (!id || await item.locator(`[data-link-id="${id}"]`).count() === 0) continue;

    const card = item.locator(`[data-link-id="${id}"]`).first();
    const title = await readNewUiCardTitle(card);
    if (!title) continue;
    items.push({
      id,
      title,
      url: '',
      type: 'link',
      active: await card.locator('button[aria-label="Show link"]').count() === 0,
      collectionTitle: ''
    });
  }

  // Scan each Collection while it is open, because the UI only keeps one
  // Collection expanded at a time.
  const collectionRefs = await getNewUiCollectionRefs(page);
  for (const ref of collectionRefs) {
    const collection = await openNewUiCollection(page, ref.id);
    if (!collection) continue;

    const titleInput = collection.locator('input[data-testid="collection-title-input"]').first();
    const title = normalizeTitle(await titleInput.inputValue().catch(() => ref.title));
    if (title) {
      items.push({
        id: ref.id,
        title,
        url: '',
        type: 'header',
        active: true
      });
    }

    const cards = await collection.locator('[data-link-id]').all();
    for (const card of cards) {
      const cardTitle = await readNewUiCardTitle(card);
      if (!cardTitle) continue;

      const id = await card.getAttribute('data-link-id');
      items.push({
        id: id || '',
        title: cardTitle,
        url: '',
        type: 'link',
        active: await card.locator('button[aria-label="Show link"]').count() === 0,
        collectionTitle: title
      });
    }
  }

  return items;
}

async function getNewUiCollectionCards(collection) {
  const rows = await collection.locator('li[data-child-sortable="true"]').all();
  const cards = [];
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    const card = row.locator('[data-link-id]').first();
    const id = await card.getAttribute('data-link-id');
    if (!id) continue;
    cards.push({
      id,
      title: await readNewUiCardTitle(card),
      active: await card.locator('button[aria-label="Show link"]').count() === 0,
      index
    });
  }
  return cards;
}

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

  console.log('[Linktree] Navigating to Linktree Admin Links...');
  await page.goto(LINKTREE_ADMIN_URL, { waitUntil: 'domcontentloaded' });

  // Wait for a real editor signal instead of always sleeping for five seconds.
  console.log('[Linktree] Waiting for dashboard to load...');
  await Promise.race([
    page.waitForSelector(NEW_UI_LINKS_PANEL, { timeout: 15000 }),
    page.waitForSelector('input[name="title"]', { timeout: 15000 })
  ]).catch(() => null);

  if (page.url().includes('/login') || page.url().includes('login') || page.url().includes('register')) {
    await context.close();
    throw new Error('Linktree 登入憑證已過期或未登入。請先執行 "npm run setup" 登入 Linktree 與 Facebook。');
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

  // New Linktree experience: cards live inside Collections and are not inputs.
  // Scan this UI first; the old input-based scanner cannot see the real cards.
  try {
    await page.waitForSelector(NEW_UI_LINKS_PANEL, { timeout: 12000 });
    await waitForNewUiContent(page);
    const newItems = await scanNewUiItems(page);
    if (newItems.length > 0) {
      console.log(`[Linktree] New UI scan found ${newItems.length} collections/cards.`);
      console.log('[Linktree] Scanned items:', newItems);
      return newItems;
    }
  } catch (err) {
    console.log('[Linktree] New UI scan unavailable, falling back to classic editor:', err.message);
  }

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
 * 填入 Bio 後儲存 Header 草稿，重新載入確認內容已保存。
 * @param {import('playwright').Page} page
 * @param {string} closedDatesString - 休館日文字，空字串表示清空 Bio
 */
export async function updateLinktreeBio(page, closedDatesString) {
  const textToWrite = closedDatesString || '';

  console.log(`[Linktree] Updating Profile Bio with: "${textToWrite}"`);
  await page.goto(LINKTREE_HEADER_URL, { waitUntil: 'domcontentloaded' });
  await waitForPageReady(page);
  try {
    await page.waitForSelector(
      'textarea[placeholder="Add a short bio"], textarea[data-testid="ProfileBioTextArea"]',
      { timeout: 20000 }
    );
  } catch (_) {
    // The explicit count below produces the actionable error message.
  }

  // Do not use the AI chat textarea.
  let bioTextarea = page.locator('textarea[placeholder="Add a short bio"]').first();

  // Keep compatibility with the classic Linktree editor.
  if (await bioTextarea.count() === 0) {
    bioTextarea = page.locator('textarea[data-testid="ProfileBioTextArea"]').first();
  }

  if (await bioTextarea.count() === 0) {
    throw new Error('找不到 Linktree Bio 欄位，無法確認休館日是否寫入。');
  }

  const originalBio = await bioTextarea.inputValue();
  if (originalBio !== textToWrite) {
    await bioTextarea.fill(textToWrite, { force: true });
    await bioTextarea.press('Tab');
    const saveButton = page.getByRole('button', { name: 'Save design draft' });
    await saveButton.waitFor({ state: 'visible', timeout: 10000 });
    await saveButton.click();
    await page.waitForFunction(() => {
      const button = [...document.querySelectorAll('button')].find(element =>
        element.getAttribute('aria-label') === 'Save design draft' ||
        element.textContent.trim() === 'Save'
      );
      return !button || button.disabled;
    }, null, { timeout: 20000 });
  }

  // An input value alone can be an unsaved draft. Verify the persisted value.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForPageReady(page);
  await bioTextarea.waitFor({ state: 'visible', timeout: 20000 });

  const savedBio = normalizeTitle(await bioTextarea.inputValue());
  if (savedBio !== normalizeTitle(textToWrite)) {
    throw new Error(`Bio 驗證失敗：目前為「${savedBio}」，預期為「${textToWrite}」。`);
  }

  console.log('[Linktree] Profile Bio updated and verified.');
  await page.goto(LINKTREE_ADMIN_URL, { waitUntil: 'domcontentloaded' });
  await waitForPageReady(page);
  return { success: true, value: textToWrite };
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

// ─── New UI Card Updates ─────────────────────────────────

async function ensureNewUiLinksPage(page) {
  if (!(await isNewLinktreeLinksPage(page))) {
    await page.goto(LINKTREE_ADMIN_URL, { waitUntil: 'domcontentloaded' });
    await waitForPageReady(page);
  }
  await page.waitForSelector(NEW_UI_LINKS_PANEL, { timeout: 15000 });
  await waitForNewUiContent(page);
}

async function findNewUiCard(page, currentTitle, id = '', collectionTitle = '') {
  const expected = normalizeTitle(currentTitle);

  const findIn = async (scope) => {
    const cards = await scope.locator('[data-link-id]').all();
    if (id) {
      for (const card of cards) {
        if ((await card.getAttribute('data-link-id')) === String(id)) return card;
      }
    }
    for (const card of cards) {
      if ((await readNewUiCardTitle(card)) === expected) return card;
    }
    const compactExpected = expected.replace(/\s/g, '');
    for (const card of cards) {
      const title = await readNewUiCardTitle(card);
      if (title.replace(/\s/g, '') === compactExpected) return card;
    }
    return null;
  };

  const refs = await getNewUiCollectionRefs(page);

  if (collectionTitle) {
    const expectedCollection = normalizeTitle(collectionTitle);
    for (const ref of refs) {
      const collection = await openNewUiCollection(page, ref.id);
      if (!collection) continue;
      const input = collection.locator('input[data-testid="collection-title-input"]').first();
      if (await input.count() > 0 && normalizeTitle(await input.inputValue()) === expectedCollection) {
        return findIn(collection);
      }
    }
    return null;
  }

  const topLevelMatch = await findIn(page.locator(NEW_UI_LINKS_PANEL));
  if (topLevelMatch) return topLevelMatch;

  for (const ref of refs) {
    const collection = await openNewUiCollection(page, ref.id);
    if (!collection) continue;
    const match = await findIn(collection);
    if (match) return match;
  }

  return null;
}

async function findNewUiCollection(page, currentTitle, newTitle = '') {
  const candidates = [currentTitle, newTitle].map(normalizeTitle).filter(Boolean);

  const refs = await getNewUiCollectionRefs(page);
  for (const ref of refs) {
    const collection = await openNewUiCollection(page, ref.id);
    if (!collection) continue;
    const input = collection.locator('input[data-testid="collection-title-input"]').first();
    if (await input.count() === 0) continue;
    for (const candidate of candidates) {
      if (normalizeTitle(await input.inputValue()) === candidate) return input;
    }
  }
  return null;
}

async function findVisibleButton(page, selector) {
  const buttons = await page.locator(selector).all();
  for (const button of buttons) {
    if (await button.isVisible().catch(() => false)) return button;
  }
  return null;
}

async function waitForNewUiEditor(page) {
  await page.waitForSelector('input[placeholder="Enter title..."]', { timeout: 15000 });
  await page.waitForTimeout(500);
}

async function setNewUiLinkVisibility(page, action) {
  const hideButton = await findVisibleButton(page, 'button[aria-label="Hide link"]');
  const showButton = await findVisibleButton(page, 'button[aria-label="Show link"]');

  if (action === 'toggle_off') {
    if (hideButton) {
      await hideButton.click();
      await page.waitForTimeout(1200);
      console.log('[Linktree] ✅ New UI link deactivated.');
    } else if (showButton) {
      console.log('[Linktree] Link is already inactive.');
    } else {
      throw new Error('找不到新版 Linktree 的 Hide/Show link 控制。');
    }
    return;
  }

  if (action === 'toggle_on' || action === 'update') {
    if (showButton) {
      await showButton.click();
      await page.waitForTimeout(1200);
      console.log('[Linktree] ✅ New UI link activated.');
    } else if (!hideButton) {
      throw new Error('找不到新版 Linktree 的 Hide/Show link 控制。');
    }
  }
}

async function updateNewUiLinkEditor(page, update) {
  const { newTitle, newUrl, action } = update;

  await setNewUiLinkVisibility(page, action);
  if (action === 'toggle_off') return;

  if (newUrl) {
    const urlDialog = page.locator('[role="dialog"]').filter({ hasText: 'Edit URL' }).last();
    let urlInput = urlDialog.locator('input[type="text"]').first();
    if (!(await urlInput.isVisible().catch(() => false))) {
      const editUrlButton = await findVisibleButton(page, 'button[aria-label="Edit URL"]');
      if (!editUrlButton) throw new Error('找不到新版 Linktree 的 Edit URL 按鈕。');

      await editUrlButton.click();
      urlInput = urlDialog.locator('input[type="text"]').first();
      await urlInput.waitFor({ state: 'visible', timeout: 8000 });
    }

    const currentUrl = normalizeTitle(await urlInput.inputValue());
    if (currentUrl !== normalizeTitle(newUrl)) {
      await urlInput.fill(newUrl);
      const confirmButton = urlDialog.locator('button[aria-label="Confirm"]').first();
      if (await confirmButton.count() === 0) {
        throw new Error('找不到新版 Linktree URL 編輯器的確認按鈕。');
      }

      for (let i = 0; i < 10 && !(await confirmButton.isEnabled().catch(() => false)); i++) {
        await page.waitForTimeout(250);
      }
      if (!(await confirmButton.isEnabled().catch(() => false))) {
        throw new Error(`Linktree 拒絕此 URL：${newUrl}`);
      }

      await confirmButton.click();
      await page.waitForTimeout(2500);
    }
  }

  if (newTitle) {
    const titleInput = page.locator('input[placeholder="Enter title..."]').first();
    if (await titleInput.count() === 0) {
      throw new Error('找不到新版 Linktree 的標題欄位。');
    }

    await titleInput.fill(newTitle);
    await titleInput.press('Tab');
    await page.waitForTimeout(1800);

    const savedTitle = normalizeTitle(await titleInput.inputValue());
    if (savedTitle !== normalizeTitle(newTitle)) {
      throw new Error(`卡片標題驗證失敗：目前為「${savedTitle}」，預期為「${newTitle}」。`);
    }
  }
}

async function addNewUiLinkToCollection(page, update) {
  await ensureNewUiLinksPage(page);
  const refs = await getNewUiCollectionRefs(page);
  let collection = null;
  for (const ref of refs) {
    const candidate = await openNewUiCollection(page, ref.id);
    const titleInput = candidate?.locator('input[data-testid="collection-title-input"]').first();
    if (titleInput && await titleInput.count() > 0 && normalizeTitle(await titleInput.inputValue()) === update.collectionTitle) {
      collection = candidate;
      break;
    }
  }
  if (!collection) throw new Error(`找不到新增卡片所需的 Collection「${update.collectionTitle}」。`);

  const beforeIds = new Set((await getNewUiCollectionCards(collection)).map(card => card.id));
  const addButton = collection.getByRole('button', { name: 'Add' }).last();
  if (await addButton.count() === 0) throw new Error(`找不到 Collection「${update.collectionTitle}」的 Add 按鈕。`);
  await addButton.click();

  const addDialog = page.locator('[role="dialog"]').filter({ has: page.locator('input[placeholder="Paste a link or search…"]') }).last();
  const searchInput = addDialog.locator('input[placeholder="Paste a link or search…"]').first();
  await searchInput.waitFor({ state: 'visible', timeout: 8000 });
  await searchInput.fill(update.newUrl);
  await searchInput.press('Enter');
  await page.waitForTimeout(1200);

  const afterCards = await getNewUiCollectionCards(collection);
  const newCard = afterCards.find(card => !beforeIds.has(card.id));
  if (!newCard) throw new Error(`Linktree 未建立「${update.newTitle}」的新卡片。`);

  const cardButton = collection.locator(`[data-link-id="${newCard.id}"] button[data-block-id]`).first();
  await cardButton.click();
  await waitForNewUiEditor(page);
  await updateNewUiLinkEditor(page, { ...update, action: 'update' });
}

async function applyNewUiUpdates(page, updates, onProgress) {
  const actionOrder = { toggle_off: 0, update: 1, toggle_on: 2, add: 3 };
  const sortedUpdates = [...updates].sort(
    (a, b) => (actionOrder[a.action] ?? 1) - (actionOrder[b.action] ?? 1)
  );
  const applied = [];
  const failed = [];

  for (const update of sortedUpdates) {
    try {
      console.log(`\n[Linktree] ─── New UI [${String(update.action).toUpperCase()}] ───`);
      console.log(` 👉 Current Title: "${update.currentTitle}"`);
      console.log(` 👉 New Title    : "${update.newTitle || ''}"`);

      if (update.action === 'add') {
        if (update.collectionTitle !== '特別活動') {
          throw new Error('新版集合模式只允許在「特別活動」新增卡片。');
        }
        await addNewUiLinkToCollection(page, update);
        applied.push(update);
        await onProgress?.({ success: true, update });
        continue;
      }

      if (update.type === 'header') {
        await ensureNewUiLinksPage(page);
        const collectionInput = await findNewUiCollection(page, update.currentTitle, update.newTitle);
        if (!collectionInput) throw new Error(`找不到 Collection「${update.currentTitle}」。`);

        if (update.newTitle && normalizeTitle(await collectionInput.inputValue()) !== normalizeTitle(update.newTitle)) {
          await collectionInput.fill(update.newTitle);
          await collectionInput.press('Tab');
          await page.waitForTimeout(1200);
        }

        const savedTitle = normalizeTitle(await collectionInput.inputValue());
        if (update.newTitle && savedTitle !== normalizeTitle(update.newTitle)) {
          throw new Error(`Collection 標題驗證失敗：目前為「${savedTitle}」。`);
        }
      } else {
        if (update.id) {
          // The scanner owns this stable Linktree ID. Going straight to the
          // editor avoids repeatedly expanding every Collection for each card.
          await page.goto(`${LINKTREE_ADMIN_URL}/edit/${encodeURIComponent(update.id)}`, {
            waitUntil: 'domcontentloaded'
          });
        } else {
          await ensureNewUiLinksPage(page);
          const card = await findNewUiCard(
            page,
            update.currentTitle,
            '',
            update.collectionTitle
          );
          if (!card) throw new Error(`找不到卡片「${update.currentTitle}」。`);
          await card.locator('button[data-block-id]').first().click();
        }
        await waitForNewUiEditor(page);
        await updateNewUiLinkEditor(page, update);
      }

      applied.push(update);
      await onProgress?.({ success: true, update });
    } catch (err) {
      console.error(`[Linktree] ❌ Update failed for "${update.currentTitle}":`, err.message);
      failed.push({ update, error: err.message });
      await onProgress?.({ success: false, update, error: err.message });
      // Reopen the list before attempting the next update; a failed editor
      // must never leave the next update operating on the wrong card.
      await page.goto(LINKTREE_ADMIN_URL, { waitUntil: 'domcontentloaded' }).catch(() => null);
      await waitForPageReady(page).catch(() => null);
    }
  }

  console.log(`\n[Linktree] New UI updates finished: ${applied.length} applied, ${failed.length} failed.`);
  return { success: failed.length === 0, applied, failed };
}

// ─── Card Updates ───────────────────────────────────────

/**
 * 將更新清單套用至 Linktree（標題/URL 變更、Toggle 開關、新增卡片）
 * @param {import('playwright').Page} page
 * @param {Array<{currentTitle: string, newTitle: string, newUrl?: string, type: string, action: string}>} updates
 */
export async function applyLinktreeUpdates(page, updates, onProgress = null) {
  console.log(`[Linktree] Applying ${updates.length} updates...`);

  // The redesigned Linktree editor has no input[name="title"] list. Route
  // the whole batch through the collection-aware implementation instead of
  // silently skipping cards that the old editor cannot see.
  if (await isNewLinktreeLinksPage(page)) {
    return applyNewUiUpdates(page, updates, onProgress);
  }

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
      await onProgress?.({ success: true, update });
      continue;
    }

    // ─── 尋找現有卡片 ────────────────────────────────
    const titleInputs = await page.locator('input[name="title"]').all();
    let card = null;
    let cardTitleInput = null;
    let cardUrlInput = null;

    if (titleInputs.length === 0) {
      if (type === 'header') {
        console.log(`[Linktree] Header "${newTitle}" confirmed in list structure.`);
        await onProgress?.({ success: true, update });
        continue;
      }

      // Expand collection list (e.g., 館內活動)
      const listNames = ['館內活動', '親職講座', '外聘課程', '育兒資源'];
      for (const name of listNames) {
        const btn = page.getByRole('button', { name: new RegExp(name) }).first();
        if (await btn.count() > 0) {
          await btn.click().catch(() => {});
          await page.waitForTimeout(500);
        }
      }

      // Find card in new UI
      let cardBtn = page.getByText(currentTitle).first();
      if (await cardBtn.count() === 0) {
        cardBtn = page.getByText(/活動表/).first();
      }

      if (await cardBtn.count() > 0) {
        console.log('[Linktree] Found card in new UI. Opening editor...');
        await cardBtn.click();
        await page.waitForTimeout(1500);

        // 1. Update URL first
        if (newUrl) {
          const editUrlBtn = page.getByRole('button', { name: 'Edit URL' }).first();
          if (await editUrlBtn.count() > 0) {
            console.log('[Linktree] Editing URL in new UI...');
            await editUrlBtn.click();
            await page.waitForTimeout(800);

            const urlInp = page.locator('input[placeholder="Enter URL..."]').first();
            if (await urlInp.count() > 0) {
              await urlInp.fill(newUrl);
              await page.waitForTimeout(500);

              const confirmBtn = page.locator('button[aria-label="Confirm"]').first();
              if (await confirmBtn.count() > 0) {
                await confirmBtn.click();
                console.log('[Linktree] Waiting 3s for Linktree auto-fetch...');
                await page.waitForTimeout(3000);
              }
            }
          }
        }

        // 2. Update Title second (to overwrite auto-fetched webpage title)
        if (newTitle) {
          const titleInp = page.locator('input[placeholder*="title"]').first();
          if (await titleInp.count() > 0) {
            console.log(`[Linktree] Setting title in new UI: "${newTitle}"...`);
            await titleInp.click();
            await titleInp.fill(newTitle);
            await titleInp.press('Enter');
            await titleInp.press('Tab');
            await page.waitForTimeout(2000);
            console.log('[Linktree] ✅ Card title updated in new UI.');
          }
        }

        await page.goto('https://linktr.ee/admin/links', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(2000);
        await onProgress?.({ success: true, update });
        continue;
      } else {
        console.log(`[Linktree] ⚠️ WARNING: Could not find card for "${currentTitle}" in new UI.`);
        await onProgress?.({ success: false, update, error: '找不到卡片' });
        continue;
      }
    }

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
      await onProgress?.({ success: false, update, error: '找不到卡片' });
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
      await onProgress?.({ success: true, update });
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
    await onProgress?.({ success: true, update });
  }

  await page.waitForTimeout(2000);
  console.log('\n[Linktree] ═══ All card updates finished. ═══');
  return { success: true, applied: sortedUpdates, failed: [] };
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
