/**
 * Centralized configuration for the Update Linktree project.
 * All constants, paths, and environment variables are managed here.
 */
import * as dotenv from 'dotenv';
import path from 'path';

dotenv.config();

// ─── Paths ───────────────────────────────────────────────
export const BROWSER_DATA_DIR = './browser_data';
export const DATA_DIR = './data';
export const TEMP_IMAGE_PATH = path.join(DATA_DIR, 'temp_calendar.jpg');
export const DB_FILE = path.join(DATA_DIR, 'backup_posts.json');

// ─── Environment Variables ───────────────────────────────
export const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
export const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
export const FB_PAGE_URL = process.env.FB_PAGE_URL;
export const FB_BASE_KEYWORD = process.env.FB_KEYWORD || '館內活動表';
export const REQUIRE_REVIEW = process.env.REQUIRE_REVIEW !== 'false';
export const HEADLESS = process.env.HEADLESS === 'true';

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
  const now = new Date();
  let targetMonth = now.getMonth() + 2; // getMonth() is 0-indexed, +1 for human, +1 for next month
  if (targetMonth > 12) targetMonth -= 12;
  const keyword = `${targetMonth}月${FB_BASE_KEYWORD}`;
  return { targetMonth, keyword };
}
