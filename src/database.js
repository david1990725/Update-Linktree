import fs from 'fs';
import crypto from 'crypto';
import { DATA_DIR, DB_FILE } from './config.js';

/**
 * 簡易 JSON 檔案資料庫，用於追蹤已處理過的貼文
 */
export class Database {
  constructor() {
    this.ensureDirectoryAndFile();
  }

  ensureDirectoryAndFile() {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    if (!fs.existsSync(DB_FILE)) {
      fs.writeFileSync(DB_FILE, JSON.stringify({ posts: [] }, null, 2), 'utf-8');
    }
  }

  read() {
    this.ensureDirectoryAndFile();
    try {
      const data = fs.readFileSync(DB_FILE, 'utf-8');
      const parsed = JSON.parse(data);
      return {
        posts: Array.isArray(parsed.posts) ? parsed.posts : [],
        plans: Array.isArray(parsed.plans) ? parsed.plans : []
      };
    } catch (err) {
      throw new Error(`無法讀取同步紀錄，已停止以免覆寫原有紀錄：${err.message}`);
    }
  }

  write(data) {
    this.ensureDirectoryAndFile();
    const temporaryFile = `${DB_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(temporaryFile, JSON.stringify(data, null, 2), 'utf-8');
    fs.renameSync(temporaryFile, DB_FILE);
  }

  /**
   * 產生貼文的唯一 hash 值
   * @param {string} text - 貼文內容
   * @returns {string} SHA-256 hash
   */
  getPostHash(text) {
    return crypto.createHash('sha256').update(text || '').digest('hex');
  }

  /**
   * 檢查貼文是否已被處理過
   * @param {string} textHash
   * @returns {boolean}
   */
  isProcessed(textHash) {
    const db = this.read();
    return db.posts.some(post => post.hash === textHash && post.status === 'processed');
  }

  /**
   * 儲存/備份貼文紀錄
   * @param {{hash: string, text: string, url: string, title: string, dateScraped?: string, month: string, status?: string}} postData
   */
  savePost({ hash, text, url, title, dateScraped, month, status = 'processed' }) {
    const db = this.read();
    const existingIndex = db.posts.findIndex(post => post.hash === hash);

    const postData = {
      hash,
      text,
      url,
      title,
      dateScraped: dateScraped || new Date().toISOString(),
      month,
      status
    };

    if (existingIndex > -1) {
      db.posts[existingIndex] = postData;
    } else {
      db.posts.push(postData);
    }

    this.write(db);
    console.log(`[Database] Saved/Updated post hash: ${hash.substring(0, 8)} (${month})`);
  }

  /** Return the latest unfinished plan for a post, if one exists. */
  getResumablePlan(postHash) {
    const db = this.read();
    return db.plans
      .filter(plan => plan.postHash === postHash && plan.status !== 'completed')
      .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))[0] || null;
  }

  /** Save an AI-approved mapping before any Linktree write occurs. */
  savePlan(plan) {
    const db = this.read();
    const index = db.plans.findIndex(entry => entry.id === plan.id);
    const record = { ...plan, updatedAt: new Date().toISOString() };
    if (index === -1) db.plans.push(record);
    else db.plans[index] = record;
    this.write(db);
    console.log(`[Database] Saved plan ${record.id.substring(0, 8)} (${record.status}).`);
    return record;
  }

  updatePlan(planId, changes) {
    const db = this.read();
    const index = db.plans.findIndex(entry => entry.id === planId);
    if (index === -1) throw new Error(`找不到同步計畫：${planId}`);
    db.plans[index] = {
      ...db.plans[index],
      ...changes,
      updatedAt: new Date().toISOString()
    };
    this.write(db);
    return db.plans[index];
  }
}
