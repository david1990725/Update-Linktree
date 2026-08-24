import { chromium } from 'playwright';
import fs from 'fs';
import https from 'https';
import path from 'path';
import { BROWSER_DATA_DIR, BROWSER_OPTIONS, TEMP_IMAGE_PATH } from './config.js';

/**
 * 下載圖片到本地
 * @param {string} url - 圖片 URL
 * @param {string} filepath - 儲存路徑
 * @returns {Promise<boolean>} 是否成功下載（大於 10KB 的有效圖片）
 */
function downloadImage(url, filepath) {
  return new Promise((resolve, reject) => {
    const dir = path.dirname(filepath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    https.get(url, (res) => {
      if (res.statusCode === 200) {
        const fileStream = fs.createWriteStream(filepath);
        res.pipe(fileStream);
        fileStream.on('finish', () => {
          fileStream.close();
          try {
            const stats = fs.statSync(filepath);
            if (stats.size < 10240) {
              try { fs.unlinkSync(filepath); } catch (_) {}
              resolve(false); // 太小（如表情符號圖示）
            } else {
              resolve(true); // 有效的大圖（如活動表圖片）
            }
          } catch (_) {
            resolve(false);
          }
        });
        fileStream.on('error', (err) => {
          try { fs.unlinkSync(filepath); } catch (_) {}
          reject(err);
        });
      } else {
        res.resume();
        reject(new Error(`Request Failed. Status: ${res.statusCode}`));
      }
    }).on('error', reject);
  });
}

/**
 * 爬取 Facebook 專頁貼文，搜尋符合關鍵字的貼文
 * @param {string} pageUrl - Facebook 專頁 URL
 * @param {string} keyword - 搜尋關鍵字（如「7月館內活動表」）
 * @returns {Promise<Array<{text: string, links: string[], imagePath: string, scrapedAt: string}>>}
 */
export async function scrapeFacebookPosts(pageUrl, keyword) {
  console.log(`[Scraper] Starting Facebook scraping for: ${pageUrl}`);
  console.log(`[Scraper] Filtering posts with keyword: "${keyword}"`);

  if (!fs.existsSync(BROWSER_DATA_DIR)) {
    throw new Error('Browser session data not found. Please run "npm run setup" first to log in.');
  }

  const context = await chromium.launchPersistentContext(BROWSER_DATA_DIR, BROWSER_OPTIONS);
  const page = await context.newPage();

  try {
    // 導航至 Facebook 專頁
    console.log('[Scraper] Navigating to Facebook page...');
    await page.goto(pageUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(5000);

    // 等待 React 渲染貼文
    console.log('[Scraper] Waiting for React to render posts...');
    await page.waitForTimeout(5000);

    // 動態捲動並搜尋貼文，防止 React Virtual DOM 卸載頂部貼文
    console.log('[Scraper] Dynamically scrolling and searching for posts...');
    let targetArticle = null;
    const foundPostsText = new Set();

    for (let i = 0; i < 10; i++) {
      const articles = await page.$$('div[data-ad-preview="message"]');
      console.log(`[Scraper] Loop ${i}: Found ${articles.length} message blocks`);

      for (const article of articles) {
        // 展開「顯示更多」按鈕
        const seeMoreSelectors = [
          'div[role="button"]:has-text("See more")',
          'div[role="button"]:has-text("顯示更多")',
          'div[role="button"]:has-text("查看更多")',
          'span:has-text("See more")',
          'span:has-text("顯示更多")',
          'span:has-text("查看更多")',
          'text="See more"',
          'text="顯示更多"',
          'text="查看更多"'
        ];
        for (const selector of seeMoreSelectors) {
          const button = await article.$(selector);
          if (button) {
            await button.evaluate(el => el.click()).catch(() => null);
            await page.waitForTimeout(1000);
            break;
          }
        }

        const textContent = await article.innerText();
        if (!textContent) continue;

        if (!foundPostsText.has(textContent)) {
          console.log(`[Scraper] Excerpt: ${textContent.substring(0, 100).replace(/\n/g, ' ')}`);
        }
        foundPostsText.add(textContent);

        // 比對月份與基礎關鍵字
        const monthPrefix = keyword.split('月')[0] + '月';
        const baseKeywordStr = keyword.replace(monthPrefix, '');

        if (textContent.includes(monthPrefix) && textContent.includes(baseKeywordStr)) {
          console.log('[Scraper Debug] Post accepted! Matching month and base keyword.');
          targetArticle = article;
          break;
        }
      }

      if (targetArticle) break;

      // 向下捲動繼續搜尋
      await page.evaluate(() => window.scrollBy(0, 1000));
      await page.waitForTimeout(2000);

      // 嘗試關閉新出現的遮罩
      await page.evaluate(() => {
        const banner = Array.from(document.querySelectorAll('div'))
          .find(el => el.innerText && el.innerText.includes('建立新帳號'));
        if (banner) banner.style.display = 'none';
      });
    }

    const foundPosts = [];
    const articlesToProcess = targetArticle ? [targetArticle] : [];

    for (const article of articlesToProcess) {
      const textContent = await article.innerText();
      console.log(`[Scraper] Found matching post containing keyword: "${keyword}"`);

      // 擷取貼文中的外部連結
      const linkElements = await article.$$('a');
      const links = [];

      for (const linkEl of linkElements) {
        const href = await linkEl.getAttribute('href');
        if (!href) continue;

        if (href.includes('l.facebook.com/l.php')) {
          try {
            const urlObj = new URL(href);
            const rawUrl = urlObj.searchParams.get('u');
            if (rawUrl && !links.includes(rawUrl)) {
              links.push(rawUrl);
            }
          } catch (e) {
            console.error('[Scraper] Failed to parse FB redirect link:', href, e);
          }
        } else if (
          href.startsWith('http') &&
          !href.includes('facebook.com') &&
          !links.includes(href)
        ) {
          links.push(href);
        }
      }

      console.log('[Scraper] Extracted links:', links);

      // 下載活動表圖片（多模態分析用）
      let imagePath = '';
      try {
        // 先在貼文容器內搜尋大圖
        const imgElements = await page.locator(`div[data-ad-preview="message"] img`).all();
        console.log(`[Scraper] Scanning ${imgElements.length} images inside post container...`);

        for (const img of imgElements) {
          const src = await img.getAttribute('src') || '';
          const alt = await img.getAttribute('alt') || '';

          if (
            (src.includes('fbcdn.net') || src.includes('scontent')) &&
            !alt.includes('profile') && !alt.includes('頭像') && !alt.includes('icon')
          ) {
            const w = await img.evaluate(el => el.naturalWidth).catch(() => 0);
            const h = await img.evaluate(el => el.naturalHeight).catch(() => 0);
            if (w > 400 && h > 400) {
              console.log(`[Scraper] Found large content image in post: ${w}x${h}`);
              const success = await downloadImage(src, TEMP_IMAGE_PATH).catch(() => false);
              if (success) {
                imagePath = TEMP_IMAGE_PATH;
                break;
              }
            }
          }
        }

        // 備援：搜尋整個頁面的大圖
        if (!imagePath) {
          console.log('[Scraper] Image not found in article container. Falling back to whole-page search...');
          const allImgs = await page.locator('img').all();
          for (const img of allImgs) {
            const src = await img.getAttribute('src') || '';
            const alt = await img.getAttribute('alt') || '';

            if (
              (src.includes('fbcdn.net') || src.includes('scontent')) &&
              !alt.includes('profile') && !alt.includes('頭像') && !alt.includes('icon')
            ) {
              const w = await img.evaluate(el => el.naturalWidth).catch(() => 0);
              const h = await img.evaluate(el => el.naturalHeight).catch(() => 0);
              if (w > 400 && h > 400) {
                console.log(`[Scraper] Found large image on the page: ${w}x${h}`);
                const success = await downloadImage(src, TEMP_IMAGE_PATH).catch(() => false);
                if (success) {
                  imagePath = TEMP_IMAGE_PATH;
                  break;
                }
              }
            }
          }
        }
      } catch (imgErr) {
        console.log('[Scraper] Non-critical error downloading calendar image:', imgErr.message);
      }

      foundPosts.push({
        text: textContent,
        links,
        imagePath,
        scrapedAt: new Date().toISOString()
      });
    }

    await context.close();
    return foundPosts;

  } catch (err) {
    console.error('[Scraper] Fatal error during scraping:', err);
    await context.close().catch(() => null);
    throw err;
  }
}
