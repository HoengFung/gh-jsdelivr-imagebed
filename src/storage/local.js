/**
 * 本地磁盘存储驱动。
 *
 * 存在的意义有三个：
 *  1. 无Token 也能把整条链路（上传→校验→命名→访问）跑通，方便本地开发与CI
 *  2. 单元测试不需要联网
 *  3. 迁移期的过渡方案 —— 先本地跑通，再切github 驱动，业务代码零改动
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';

/** 确保目标路径不逃逸出存储根目录（防路径穿越） */
function safeJoin(root, relative) {
  const target = path.resolve(root, relative);
  const rootResolved = path.resolve(root);
  if (target !== rootResolved && !target.startsWith(rootResolved + path.sep)) {
    throw new Error('非法路径：试图逃逸存储根目录');
  }
  return target;
}

export async function statFile(p) {
  const full = safeJoin(config.storage.local.dir, p);
  try {
    const st = await fs.stat(full);
    if (!st.isFile()) return { exists: false };
    return { exists: true, size: st.size, sha: crypto.createHash('sha1').update(p).digest('hex') };
  } catch {
    return { exists: false };
  }
}

export async function putFile(p, buffer) {
  const full = safeJoin(config.storage.local.dir, p);
  await fs.mkdir(path.dirname(full), { recursive: true });

  const existing = await statFile(p);
  if (existing.exists) {
    logger.info('本地文件已存在，跳过写入', { path: p });
    return { created: false, skipped: true, sha: existing.sha };
  }

  await fs.writeFile(full, buffer);
  logger.info('本地写入成功', { path: p, size: buffer.length });
  return { created: true, skipped: false, sha: null };
}

export async function deleteFile(p) {
  const full = safeJoin(config.storage.local.dir, p);
  try {
    await fs.unlink(full);
    return true;
  } catch {
    return false;
  }
}

export async function listFiles(dirPath = '') {
  const root = config.storage.local.dir;
  const base = safeJoin(root, dirPath);
  const out = [];

  let entries;
  try {
    entries = await fs.readdir(base, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const e of entries) {
    const rel = dirPath ? `${dirPath}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await listFiles(rel)));
    else {
      const st = await fs.stat(path.join(base, e.name));
      out.push({ name: e.name, path: rel, size: st.size });
    }
  }
  return out;
}

/** 本地驱动无需远端连通性检查 */
export async function checkConnection() {
  await fs.mkdir(config.storage.local.dir, { recursive: true });
  return { driver: 'local', dir: config.storage.local.dir };
}

export default { statFile, putFile, deleteFile, listFiles, checkConnection };