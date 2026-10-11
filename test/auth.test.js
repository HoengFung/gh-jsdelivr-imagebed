/**
 * 鉴权与防盗链测试。
 *
 * 与 smoke.js 一样需要独立的进程：鉴权与防盗链配置是模块级单例，
 * 必须在导入 config 之前设定环境变量。
 */

process.env.NODE_ENV = 'test';
process.env.STORAGE_DRIVER = 'local';
process.env.LOCAL_STORAGE_DIR = 'storage/local-auth';
process.env.CDN_BASE_URL = 'https://cdn.jsdelivr.net/gh/testowner/testrepo@main';
process.env.RATE_LIMIT_ENABLED = 'false';
process.env.LOG_LEVEL = 'error';
process.env.ACCESS_MODE = 'proxy';

process.env.REQUIRE_AUTH = 'true';
process.env.UPLOAD_TOKENS = 'token_aaa111,token_bbb222';

process.env.ALLOWED_REFERERS = 'blog.example.com,*.allowed.com';
process.env.ALLOWED_ORIGINS = 'https://app.example.com';
process.env.ALLOW_EMPTY_REFERER = 'false';
process.env.BLOCK_DIRECT_HOTLINK = 'true';

import path from 'node:path';
import { rm } from 'node:fs/promises';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

let passed = 0;
let failed = 0;

function assert(cond, label) {
  if (cond) { passed += 1; process.stdout.write(`  \x1b[32m✓\x1b[0m ${label}\n`); }
  else { failed += 1; process.stdout.write(`  \x1b[31m✗\x1b[0m ${label}\n`); }
}

const section = (t) => process.stdout.write(`\n\x1b[90m${t}\x1b[0m\n`);

async function upload(base, token, extraHeaders = {}) {
  const form = new FormData();
  form.append('file', new Blob([PNG], { type: 'image/png' }), 'a.png');
  const headers = { ...extraHeaders };
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(`${base}/api/v1/upload`, { method: 'POST', headers, body: form });
}

const testDir = path.join(process.cwd(), 'storage/local-auth');
await rm(testDir, { recursive: true, force: true });

const { createApp } = await import('../src/app.js');
const app = createApp();
const server = app.listen(0);
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;

process.stdout.write('\n鉴权与防盗链测试\n');
process.stdout.write(`${'─'.repeat(52)}\n`);

// ---------- 上传鉴权 ----------
section('[1] 上传鉴权');
{
  const res = await upload(base, null);
  const d = await res.json();
  assert(res.status === 401, `无 Token 被拒绝（实际 ${res.status}）`);
  assert(d.code === 'MISSING_TOKEN', `返回 MISSING_TOKEN（实际 ${d.code}）`);
}
{
  const res = await upload(base, 'wrong_token');
  const d = await res.json();
  assert(res.status === 403, `错误 Token 被拒绝（实际 ${res.status}）`);
  assert(d.code === 'INVALID_TOKEN', `返回 INVALID_TOKEN（实际 ${d.code}）`);
}
{
  const res = await upload(base, 'token_aaa111');
  assert(res.status === 201, '第一个 Token 上传成功');
}
{
  const res = await upload(base, 'token_bbb222');
  assert(res.status === 201, '第二个 Token 上传成功（多 Token 支持）');
}
{
  const res = await upload(base, null, { 'X-Upload-Token': 'token_aaa111' });
  assert(res.status === 201, 'X-Upload-Token 头部方式可用');
}
{
  const res = await upload(base, null, { 'X-API-Key': 'token_bbb222' });
  assert(res.status === 201, 'X-API-Key 头部方式可用');
}
{
  // 令牌近似值攻击：前缀相同但整体不同
  const res = await upload(base, 'token_aaa11');
  assert(res.status === 403, '前缀相近的 Token 被拒绝');
}

// ---------- 防盗链 ----------
section('[2] 防盗链（Referer / Origin）');
const imgPath = 'img/2026/10/test.png';
{
  let res = await fetch(`${base}/i/${imgPath}`, {
    headers: { Referer: 'https://blog.example.com/post/1' },
  });
  assert(res.ok === true || res.status === 404, '白名单 Referer 通过（文件可能未写入，状态非 403 即为通过）');

  res = await fetch(`${base}/i/${imgPath}`, {
    headers: { Referer: 'https://evil.com/hack' },
  });
  assert(res.status === 403, `非白名单 Referer 被拦截（实际 ${res.status}）`);

  res = await fetch(`${base}/i/${imgPath}`, {
    headers: { Referer: 'https://sub.allowed.com/x' },
  });
  assert(res.status !== 403, '通配符子域 *.allowed.com 通过');

  res = await fetch(`${base}/i/${imgPath}`);
  assert(res.status === 403, '无 Referer 且 ALLOW_EMPTY_REFERER=false 时被拦截');
}
{
  const res = await fetch(`${base}/i/${imgPath}`, {
    headers: { Referer: 'https://blog.example.com/x', Origin: 'https://evil.com' },
  });
  assert(res.status === 403, 'Origin 不在白名单时即便 Referer 合法也拦截');
}
{
  const res = await fetch(`${base}/i/${imgPath}`, {
    headers: { Referer: 'https://blog.example.com/x', Origin: 'https://app.example.com' },
  });
  assert(res.status !== 403, 'Origin 在白名单时通过');
}

// ---------- 上传接口不受防盗链影响 ----------
section('[3] 上传接口与防盗链正交');
{
  const res = await upload(base, 'token_aaa111', { Referer: 'https://evil.com' });
  assert(res.status === 201, '防盗链规则不影响上传接口（上传靠 Token 鉴权）');
}

server.close();
await new Promise((r) => server.close(r));
await rm(testDir, { recursive: true, force: true });

process.stdout.write(`${'─'.repeat(52)}\n`);
process.stdout.write(
  failed === 0
    ? `\x1b[32m全部通过：${passed} 项断言\x1b[0m\n\n`
    : `\x1b[31m失败 ${failed} 项 / 通过 ${passed} 项\x1b[0m\n\n`
);
process.exit(failed === 0 ? 0 : 1);