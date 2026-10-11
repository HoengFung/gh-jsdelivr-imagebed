#!/usr/bin/env node
/**
 * 命令行上传工具。
 *
 * 用于验证服务链路，以及在没有图形界面的环境（服务器 / SSH / CI）里上传图片。
 * 如果你用 PicGo 或 Typora，这个脚本不是必需的 —— 但它能帮你确认服务端配置正确。
 *
 * 用法：
 *   node scripts/upload-cli.js ./a.png ./b.jpg
 *   node scripts/upload-cli.js --url https://example.com/x.png   （需服务端开启 URL_FETCH）
 *   UPLOAD_TOKEN=xxx node scripts/upload-cli.js ./a.png           （指定 Token）
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { config } from '../src/config/index.js';

const RESET = '\x1b[0m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const DIM = '\x1b[90m';

const BASE = process.env.IMAGEBED_URL || `http://127.0.0.1:${config.server.port}`;
const TOKEN =
  process.env.UPLOAD_TOKEN ||
  config.auth.uploadTokens[0] ||
  '';

function parseArgs(argv) {
  const files = [];
  let useUrl = false;

  for (const arg of argv) {
    if (arg === '--url') { useUrl = true; continue; }
    if (arg.startsWith('--')) continue;
    files.push(arg);
  }
  return { files, useUrl };
}

async function uploadOne(filePath) {
  const abs = path.resolve(filePath);

  try {
    await fs.access(abs);
  } catch {
    throw new Error(`文件不存在：${abs}`);
  }

  const stat = await fs.stat(abs);
  const buffer = await fs.readFile(abs);

  const form = new FormData();
  form.append('file', new Blob([buffer]), path.basename(abs));

  const res = await fetch(`${BASE}/api/v1/upload`, {
    method: 'POST',
    headers: TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {},
    body: form,
  });

  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`响应不是合法 JSON（HTTP ${res.status}）：${text.slice(0, 200)}`);
  }

  if (!res.ok) {
    throw new Error(`${data.code || res.status}: ${data.message || text.slice(0, 200)}`);
  }

  return data;
}

async function main() {
  const { files, useUrl } = parseArgs(process.argv.slice(2));

  if (files.length === 0) {
    process.stdout.write('用法：node scripts/upload-cli.js <文件...> | --url <远程地址>\n');
    process.exit(1);
  }

  if (!TOKEN && config.auth.requireAuth) {
    process.stderr.write(
      `${RED}缺少上传 Token${RESET}\n请设置环境变量 UPLOAD_TOKEN，或在 .env 中配置 UPLOAD_TOKENS\n`
    );
    process.exit(1);
  }

  process.stdout.write(`\n目标服务：${BASE}\n\n`);

  let failed = 0;

  for (const f of files) {
    try {
      let result;

      if (useUrl || /^https?:\/\//i.test(f)) {
        result = await (
          await fetch(`${BASE}/api/v1/url`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
            },
            body: JSON.stringify({ url: f }),
          })
        ).json();
      } else {
        result = await uploadOne(f);
      }

      if (!result.ok) {
        failed += 1;
        process.stdout.write(`${RED}✗${RESET} ${f}\n  ${result.code}: ${result.message}\n\n`);
        continue;
      }

      const mark = result.deduped ? `${DIM}(命中去重，未重复写入)${RESET}` : '';
      process.stdout.write(`${GREEN}✓${RESET} ${path.basename(f)} ${DIM}${result.sizeText}${RESET} ${mark}\n`);
      process.stdout.write(`  URL: ${result.url}\n`);
      if (result.fallbackUrls?.length > 1) {
        process.stdout.write(`  备用: ${result.fallbackUrls.slice(1).join('\n        ')}\n`);
      }
      process.stdout.write('\n');
    } catch (err) {
      failed += 1;
      process.stdout.write(`${RED}✗${RESET} ${f}\n  ${err.message}\n\n`);
    }
  }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  process.stderr.write(`${RED}${err.message}${RESET}\n`);
  process.exit(1);
});