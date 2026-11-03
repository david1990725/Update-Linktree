/**
 * Centralized configuration for the Update Linktree project.
 * All constants, paths, and environment variables are managed here.
 */
import * as dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

// ─── Paths ───────────────────────────────────────────────
// Resolve paths from the project, not from the shell's working directory.
const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const BROWSER_DATA_DIR = path.join(PROJECT_DIR, 'browser_data');
export const DATA_DIR = path.join(PROJECT_DIR, 'data');
export const TEMP_IMAGE_PATH = path.join(DATA_DIR, 'temp_calendar.jpg');
export const DB_FILE = path.join(DATA_DIR, 'backup_posts.json');
export const LINKTREE_ADMIN_URL = 'https://linktr.ee/admin/links';
export const LINKTREE_HEADER_URL = 'https://linktr.ee/admin/header';

// ─── Environment Variables ───────────────────────────────
export const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
export const FB_PAGE_URL = process.env.FB_PAGE_URL;
export const FB_BASE_KEYWORD = process.env.FB_KEYWORD || '館內活動表';
export const REQUIRE_REVIEW = process.env.REQUIRE_REVIEW !== 'false';
export const HEADLESS = process.env.HEADLESS === 'true';
// interactive: show the plan and wait for approval; plan: save a plan only;
// auto: apply a saved/new plan without stdin (use only after validation).
export const RUN_MODE = process.env.RUN_MODE || (REQUIRE_REVIEW ? 'interactive' : 'auto');
export const TARGET_MONTH_OVERRIDE = process.env.TARGET_MONTH || '';
// Only enable this when recovering a post that was incorrectly marked as processed.
export const RETRY_PROCESSED_POSTS = process.env.RETRY_PROCESSED_POSTS === 'true';

// ─── Browser Launch Options ─────────────────────────────
export const BROWSER_OPTIONS = {
  headless: HEADLESS,
  viewport: { width: 1280, height: 800 },
  args: ['--disable-blink-features=AutomationControlled'],
};

// ─── Utility Functions ──────────────────────────────────

/**
 * 判斷一個字串是否為 URL
 * @param {string} value - 要判斷的字串
 * @returns {boolean}
 */
export function isUrl(value) {
  if (!value) return false;
  const v = value.trim();
  return (
    v.startsWith('http://') ||
    v.startsWith('https://') ||
    v.includes('forms.gle') ||
    v.includes('beclass.com') ||
    v.includes('line.me')
  );
}

/**
 * 計算目標月份（下個月）
 * JavaScript 的 getMonth() 返回 0-11，所以需要 +1 得到人類月份，再 +1 得到下個月。
 * 例：6月(getMonth()=5) → 5+2=7 → 搜尋「7月」
 *    12月(getMonth()=11) → 11+2=13 → 13>12 → 13-12=1 → 搜尋「1月」
 * @returns {{ targetMonth: number, keyword: string }}
 */
export function getTargetMonthAndKeyword() {
  const requestedMonth = Number.parseInt(TARGET_MONTH_OVERRIDE, 10);
  if (Number.isInteger(requestedMonth) && requestedMonth >= 1 && requestedMonth <= 12) {
    const now = new Date();
    const requestedYear = Number.parseInt(process.env.TARGET_YEAR, 10);
    const targetYear = Number.isInteger(requestedYear) && requestedYear >= 2000 && requestedYear <= 2100 ? requestedYear : now.getFullYear();
    return { targetMonth: requestedMonth, targetYear, keyword: `${requestedMonth}月${FB_BASE_KEYWORD}` };
  }

  const now = new Date();
  let targetMonth = now.getMonth() + 2; // getMonth() is 0-indexed, +1 for human, +1 for next month
  if (targetMonth > 12) targetMonth -= 12;
  const keyword = `${targetMonth}月${FB_BASE_KEYWORD}`;
  return { targetMonth, targetYear: now.getFullYear() + (now.getMonth() === 11 ? 1 : 0), keyword };
}
