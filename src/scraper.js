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

function normalizeExternalUrl(value) {
  try {
    const url = new URL(value);
    url.searchParams.delete('fbclid');
    return url.toString();
  } catch (_) {
    return value;
  }
}

function extractTextUrls(textContent) {
  return [...String(textContent || '').matchAll(/https?:\/\/[^\s<>"）)]+/g)]
    .map(match => normalizeExternalUrl(match[0]))
    .filter(url => !url.includes('facebook.com'));
}

export function selectCalendarImageCandidate(images, month) {
  const plausible = images
    .filter(image => {
      const ratio = image.width / image.height;
      return /(?:fbcdn\.net|scontent)/.test(image.src || '') &&
        image.width >= 500 && image.height >= 280 &&
        ratio >= 1.5 && ratio <= 2.05 &&
        !/profile|頭像|icon/i.test(image.alt || '');
    })
    .map(image => ({
      ...image,
      score: new RegExp(`${month}月`).test(image.alt || '') ? 2 :
        /活動表|課程表|行事曆/.test(image.alt || '') ? 1 : 0
    }))
    .sort((a, b) => b.score - a.score);

  if (plausible.length > 1 && plausible[0].score === plausible[1].score) return null;
  return plausible[0] || null;
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
    // Wait for actual post content instead of a fixed ten-second delay.
    console.log('[Scraper] Waiting for React to render posts...');
    await page.waitForSelector('div[data-ad-preview="message"]', { timeout: 15000 });

    // 動態捲動並搜尋貼文，防止 React Virtual DOM 卸載頂部貼文
    console.log('[Scraper] Dynamically scrolling and searching for posts...');
    let targetArticle = null;
    const foundPostsText = new Set();
    const monthPrefix = keyword.split('月')[0] + '月';
    const baseKeywordStr = keyword.replace(monthPrefix, '');

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
            await page.waitForTimeout(250);
            break;
          }
        }

        const textContent = await article.innerText();
        if (!textContent) continue;

        if (!foundPostsText.has(textContent)) {
          console.log(`[Scraper] Excerpt: ${textContent.substring(0, 100).replace(/\n/g, ' ')}`);
        }
        foundPostsText.add(textContent);

        if (textContent.includes(monthPrefix) && textContent.includes(baseKeywordStr)) {
          console.log('[Scraper Debug] Post accepted! Matching month and base keyword.');
          targetArticle = article;
          break;
        }
      }

      if (targetArticle) break;

      // 向下捲動繼續搜尋
      await page.evaluate(() => window.scrollBy(0, 1000));
      await page.waitForTimeout(800);

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
      const links = extractTextUrls(textContent);

      for (const linkEl of linkElements) {
        const href = await linkEl.getAttribute('href');
        if (!href) continue;

        if (href.includes('l.facebook.com/l.php')) {
          try {
            const urlObj = new URL(href);
            const rawUrl = urlObj.searchParams.get('u');
            const normalizedUrl = normalizeExternalUrl(rawUrl);
            if (normalizedUrl && !links.includes(normalizedUrl)) {
              links.push(normalizedUrl);
            }
          } catch (e) {
            console.error('[Scraper] Failed to parse FB redirect link:', href, e);
          }
        } else if (
          href.startsWith('http') &&
          !href.includes('facebook.com')
        ) {
          const normalizedUrl = normalizeExternalUrl(href);
          if (!links.includes(normalizedUrl)) links.push(normalizedUrl);
        }
      }

      console.log('[Scraper] Extracted links:', links);

      // Only inspect images belonging to the matched post. The message block
      // itself normally contains no image. Facebook's current DOM does not
      // always add role="article", so fall back to the nearest ancestor that
      // owns an image (which also keeps the image scoped to this post).
      let imagePath = '';
      let postUrl = '';
      try {
        const postData = await article.evaluate(element => {
          let post = element.closest('[role="article"]');
          if (!post || !post.querySelector('img')) {
            let ancestor = element.parentElement;
            while (ancestor) {
              if (ancestor.querySelector('img')) {
                post = ancestor;
                break;
              }
              ancestor = ancestor.parentElement;
            }
          }
          post ||= element.parentElement;

          const images = [...(post?.querySelectorAll('img') || [])].map(img => ({
            src: img.currentSrc || img.src || '',
            alt: img.alt || '',
            width: img.naturalWidth,
            height: img.naturalHeight
          }));
          let postUrl = '';
          let ancestor = post;
          while (ancestor) {
            const anchor = [...(ancestor.querySelectorAll('a[href]') || [])].find(link =>
              /\/posts\/|permalink\.php|story_fbid=/.test(link.href)
            );
            if (anchor) {
              postUrl = anchor.href;
              break;
            }
            ancestor = ancestor.parentElement;
          }
          return { postUrl, images };
        });
        postUrl = postData.postUrl;
        const { images } = postData;
        const month = Number.parseInt(keyword, 10);
        const candidate = selectCalendarImageCandidate(images, month);
        if (candidate) {
          console.log(`[Scraper] Calendar candidate in matched post: ${candidate.width}x${candidate.height}`);
          if (await downloadImage(candidate.src, TEMP_IMAGE_PATH).catch(() => false)) {
            imagePath = TEMP_IMAGE_PATH;
          }
        } else {
          console.warn(`[Scraper] No unique calendar image found among ${images.length} images in matched post.`);
        }
      } catch (imgErr) {
        console.warn('[Scraper] Calendar image unavailable:', imgErr.message);
      }

      foundPosts.push({
        text: textContent,
        links,
        postUrl,
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
