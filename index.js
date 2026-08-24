import readline from 'readline';
import { Database } from './src/database.js';
import { scrapeFacebookPosts } from './src/scraper.js';
import { classifyAndMapLinktreeUpdates } from './src/classifier.js';
import {
  launchLinktreeSession,
  scanLinktreeItems,
  applyLinktreeUpdates,
  updateLinktreeBio
} from './src/linktree.js';
import { FB_PAGE_URL, REQUIRE_REVIEW, getTargetMonthAndKeyword } from './src/config.js';

const { keyword: FB_KEYWORD } = getTargetMonthAndKeyword();

async function main() {
  console.log('==================================================');
  console.log('   Starting Facebook to Linktree Update Process   ');
  console.log(`   Time: ${new Date().toLocaleString()}   `);
  console.log('==================================================\n');

  if (!FB_PAGE_URL) {
    console.error('[Error] FB_PAGE_URL is not defined in .env');
    process.exit(1);
  }

  const db = new Database();
  let browserSession = null;

  try {
    // Step 1: 爬取 Facebook 頁面，擷取最新貼文（含圖片下載）
    console.log('[Status] Scrape Phase: Scraping Facebook page...');
    const scrapedPosts = await scrapeFacebookPosts(FB_PAGE_URL, FB_KEYWORD);

    if (!scrapedPosts || scrapedPosts.length === 0) {
      console.log(`[Status] No posts containing "${FB_KEYWORD}" were found on the page.`);
      console.log('[Status] Process completed (nothing to update).');
      return;
    }

    console.log(`[Status] Found ${scrapedPosts.length} post(s) matching keyword "${FB_KEYWORD}".`);

    // 找出最新的、尚未處理過的貼文
    let targetPost = null;
    let targetHash = null;

    for (const post of scrapedPosts) {
      const hash = db.getPostHash(post.text);
      const alreadyProcessed = db.isProcessed(hash);

      if (!alreadyProcessed) {
        targetPost = post;
        targetHash = hash;
        break;
      } else {
        console.log(`[Status] Post hash ${hash.substring(0, 8)} already processed. Skipping.`);
      }
    }

    if (!targetPost) {
      console.log('\n[Status] All matching posts have already been processed previously.');
      console.log('[Status] Linktree is up to date. Exiting.');
      return;
    }

    console.log('\n[Status] Processing the latest new post...');

    // Step 2: 開啟 Linktree Admin 並掃描現有版面結構
    console.log('\n[Status] Scanning Phase: Launching Linktree Admin session...');
    browserSession = await launchLinktreeSession();
    const currentLinktreeStructure = await scanLinktreeItems(browserSession.page);

    if (!currentLinktreeStructure || currentLinktreeStructure.length === 0) {
      console.log('[Status] WARNING: No existing items scanned from your Linktree profile. Aborting.');
      await browserSession.context.close();
      return;
    }

    // Step 3: 透過 Gemini AI 進行多模態分析與對應
    console.log('\n[Status] Analysis Phase: Running Gemini multimodal mapping...');
    const allLinks = [...(targetPost.links || []), FB_PAGE_URL];
    const geminiResult = await classifyAndMapLinktreeUpdates(
      targetPost.text,
      allLinks,
      currentLinktreeStructure,
      targetPost.imagePath
    );

    console.log('\n[Gemini Multimodal Mapping Result]:');
    console.log(JSON.stringify(geminiResult, null, 2));

    if (!geminiResult.isMatch || !geminiResult.updates || geminiResult.updates.length === 0) {
      console.log('[Status] Gemini determined this post is not a match or no updates mapped. Skipping.');
      db.savePost({
        hash: targetHash,
        text: targetPost.text,
        url: '',
        title: '',
        month: 'None',
        status: 'ignored'
      });
      await browserSession.context.close();
      return;
    }

    // Step 4: 使用者確認
    if (REQUIRE_REVIEW) {
      console.log('\n==================================================');
      console.log('            🔔 PENDING USER REVIEW 🔔             ');
      console.log('==================================================');
      console.log(`[FB Post Text Preview]:\n"${targetPost.text.substring(0, 200).replace(/\n/g, ' ')}..."`);
      console.log('--------------------------------------------------');
      console.log(`👉 Proposed Profile Bio (Special Closed Dates):\n   "${geminiResult.closedDatesString}"`);
      console.log('--------------------------------------------------');
      console.log('[PROPOSED LINKTREE CHANGES]:');

      geminiResult.updates.forEach((update, idx) => {
        console.log(`\n ${idx + 1}. [Action: ${update.action.toUpperCase()}] [Type: ${update.type.toUpperCase()}]`);
        console.log(`   👉 Current Title : "${update.currentTitle}"`);
        console.log(`   👉 New Title     : "${update.newTitle}"`);
        if (update.type === 'link' && (update.action === 'update' || update.action === 'toggle_on')) {
          console.log(`   👉 New URL       : "${update.newUrl}"`);
        }
        console.log(`   👉 Matching Rule : ${update.reasoning}`);
      });
      console.log('==================================================\n');

      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
      });

      const approved = await new Promise((resolve) => {
        rl.question('是否同意套用並寫入以上所有更新到您的 Linktree？ (y/n): ', (answer) => {
          rl.close();
          const ans = answer.toLowerCase().trim();
          resolve(ans === 'y' || ans === 'yes');
        });
      });

      if (!approved) {
        console.log('\n[Status] Update rejected by user. Aborting updates.');
        await browserSession.context.close();
        return;
      }
      console.log('\n[Status] Update approved by user! Writing to Linktree...');
    }

    // Step 5: 寫入 Profile Bio 與更新卡片
    console.log('[Status] Writing Profile Bio closed dates...');
    await updateLinktreeBio(browserSession.page, geminiResult.closedDatesString);

    console.log('[Status] Updating Linktree cards layout...');
    await applyLinktreeUpdates(browserSession.page, geminiResult.updates);

    // 儲存處理紀錄
    db.savePost({
      hash: targetHash,
      text: targetPost.text,
      url: geminiResult.updates[0].newUrl || FB_PAGE_URL,
      title: geminiResult.updates[0].newTitle,
      month: geminiResult.month,
      status: 'processed'
    });

    console.log('\n==================================================');
    console.log('   Process Completed Successfully!               ');
    console.log('   Linktree Profile Bio and card layout are fully updated.');
    console.log('==================================================');

  } catch (err) {
    console.error('\n[Fatal Error] The sync workflow failed:', err);
  } finally {
    if (browserSession) {
      try {
        await browserSession.context.close();
        console.log('[Status] Browser session closed.');
      } catch (_) {
        // Browser already closed
      }
    }
  }
}

main();
