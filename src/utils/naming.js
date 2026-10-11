/**
 * 文件命名策略。
 *
 * 采用「内容寻址 + 时间分片」：
 *   img/2026/10/3f9a1c2b....jpg
 *  - 内容寻址（sha256 前 32 位）：同一张图重复上传得到同一个文件名，
 *    天然去重，且 URL 一经生成内容永不变化 —— 这对 CDN 缓存命中率非常关键
 *    （若用时间戳命名，每次上传都是新 URL，边缘节点需要反复回源）
 *  - 时间分片：避免单目录文件过多导致 GitHub 目录渲染与克隆变慢
 */

import crypto from 'node:crypto';
import { config } from '../config/index.js';

export const NAMING = {
  /** 内容寻址 */
  HASH: 'hash',
  /** 原始文件名（已净化） */
  ORIGINAL: 'original',
  /** 时间戳 + 随机串 */
  TIMESTAMP: 'timestamp',
};

/**
 * 生成日期分片目录，形如 2026/10
 */
function dateShim(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  return `${y}/${m}`;
}

/**
 * 计算内容哈希（sha256 前 32 位十六进制）
 */
export function contentHash(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex').slice(0, 32);
}

/**
 * 短随机串，用于非内容寻址模式。
 */
function randomId(bytes = 6) {
  return crypto.randomBytes(bytes).toString('hex');
}

/**
 * 按配置的命名策略生成仓库内相对路径。
 *
 * @param {object} params
 * @param {Buffer} params.buffer 文件内容
 * @param {string} params.ext 真实扩展名（来自文件头嗅探）
 * @param {string} [params.originalName] 原始文件名
 * @returns {{ path:string, hash:string, dedupKey:string }}
 */
export function buildObjectPath({ buffer, ext, originalName = '' }) {
  const prefix = (config.storage.github.pathPrefix || 'img').replace(/^\/+|\/+$/g, '');
  const strategy = process.env.NAMING_STRATEGY || NAMING.HASH;
  const shard = dateShim();
  const hash = contentHash(buffer);
  // 去重键：与时间分片无关，保证跨月份重复上传仍能命中同一文件
  const dedupKey = `${hash}.${ext}`;

  let filename;
  switch (strategy) {
    case NAMING.ORIGINAL: {
      const base = String(originalName)
        .replace(/\.[^.]+$/, '')
        .replace(/[^\w\-一-龥]+/g, '_')
        .slice(0, 60) || 'image';
      // 加哈希后缀避免同名覆盖
      filename = `${base}-${hash.slice(0, 8)}.${ext}`;
      break;
    }
    case NAMING.TIMESTAMP:
      filename = `${Date.now()}-${randomId()}.${ext}`;
      break;
    case NAMING.HASH:
    default:
      filename = dedupKey;
      break;
  }

  const path = prefix
    ? `${prefix}/${shard}/${filename}`
    : `${shard}/${filename}`;

  return { path, hash, dedupKey };
}

export default buildObjectPath;