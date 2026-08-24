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
      return JSON.parse(data);
    } catch (err) {
      console.error('Error reading database file, resetting database:', err);
      return { posts: [] };
    }
  }

  write(data) {
    this.ensureDirectoryAndFile();
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf-8');
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
}
