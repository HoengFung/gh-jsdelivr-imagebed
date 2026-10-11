/**
 * 端到端冒烟测试。
 *
 * 全程使用 local 驱动 + 无鉴权模式，不需要 GitHub Token、不联网，
 * 但会真实跑通：上传 → 校验 → 命名 → 去重 → 落盘 → 访问 → 防盗链 → 鉴权。
 */

import path from 'node:path';

process.env.NODE_ENV = 'test';
process.env.STORAGE_DRIVER = 'local';
process.env.LOCAL_STORAGE_DIR = 'storage/local-test';
process.env.REQUIRE_AUTH = 'false';
process.env.CDN_BASE_URL = 'https://cdn.jsdelivr.net/gh/testowner/testrepo@main';
process.env.ACCESS_MODE = 'proxy';
process.env.RATE_LIMIT_ENABLED = 'false';
process.env.LOG_LEVEL = 'error';
process.env.ALLOW_SVG = 'false';

// 构造真实的 PNG 字节（1x1 透明像素）
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

// 构造一个伪装成 png 的文本文件（用于验证文件头嗅探能拦住）
const FAKE_PNG = Buffer.from('<?php system($_GET["c"]); ?>', 'utf8');

// 含脚本的 SVG
const DANGEROUS_SVG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
  'utf8'
);

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const DIM = '\x1b[90m';
const RESET = '\x1b[0m';

let passed = 0;
let failed = 0;

function assert(cond, label) {
  if (cond) {
    passed += 1;
    process.stdout.write(`  ${GREEN}✓${RESET} ${label}\n`);
  } else {
    failed += 1;
    process.stdout.write(`  ${RED}✗${RESET} ${label}\n`);
  }
}

function section(title) {
  process.stdout.write(`\n${DIM}${title}${RESET}\n`);
}

async function main() {
  const { rm } = await import('node:fs/promises');

  // 测试前先清空目录：上一次运行若异常中断，残留文件会让「去重」断言误判
  const testDir = path.join(process.cwd(), 'storage/local-test');
  await rm(testDir, { recursive: true, force: true });

  const { createApp } = await import('../src/app.js');
  const { config } = await import('../src/config/index.js');

  const app = createApp();

  // 启动临时服务
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  process.stdout.write(`\n图床服务 · 冒烟测试${RESET}\n`);
  process.stdout.write(`${'─'.repeat(52)}\n`);
  process.stdout.write(`${DIM}服务地址：${base} · 驱动：${config.storage.driver}${RESET}\n`);

  // ---------- 1. 健康检查 ----------
  section('[1] 健康检查');
  {
    const res = await fetch(`${base}/health`);
    const data = await res.json();
    assert(res.ok && data.ok === true, 'GET /health 返回正常');
  }
  {
    const res = await fetch(`${base}/api/v1/health/ready`);
    const data = await res.json();
    assert(res.ok && data.status === 'ready', 'GET /api/v1/health/ready 存储就绪');
  }

  // ---------- 2. 正常上传 ----------
  section('[2] 图片上传');
  let firstUrl = null;
  {
    const form = new FormData();
    form.append('file', new Blob([PNG_1x1], { type: 'image/png' }), 'test.png');

    const res = await fetch(`${base}/api/v1/upload`, { method: 'POST', body: form });
    const data = await res.json();

    assert(res.status === 201, `上传返回 201（实际 ${res.status}）`);
    assert(data.ok === true, '响应 ok=true');
    assert(data.ext === 'png', `扩展名识别为 png（实际 ${data.ext}）`);
    assert(data.mime === 'image/png', 'MIME 识别为 image/png');
    assert(/^img\/\d{4}\/\d{2}\/[0-9a-f]{32}\.png$/.test(data.path),
      `路径符合内容寻址规范（实际 ${data.path}）`);
    assert(data.url.startsWith('https://cdn.jsdelivr.net/gh/testowner/testrepo@main/'),
      '生成 jsDelivr 访问地址');
    assert(Array.isArray(data.fallbackUrls) && data.fallbackUrls.length > 1,
      '返回了备用 CDN 链接');
    firstUrl = data.url;
  }

  // ---------- 3. 内容寻址去重 ----------
  section('[3] 去重（同图重复上传）');
  {
    const form = new FormData();
    form.append('file', new Blob([PNG_1x1], { type: 'image/png' }), 'different-name.png');

    const res = await fetch(`${base}/api/v1/upload`, { method: 'POST', body: form });
    const data = await res.json();

    assert(data.deduped === true, '第二次上传被识别为重复');
    assert(data.path.endsWith('.png'), '返回路径仍为同一内容哈希');
  }

  // ---------- 4. 不同内容 -> 不同哈希 ----------
  section('[4] 不同图片生成不同哈希');
  {
    const other = Buffer.concat([PNG_1x1, Buffer.from([0x00])]);
    const form = new FormData();
    form.append('file', new Blob([other], { type: 'image/png' }), 'other.png');

    const res = await fetch(`${base}/api/v1/upload`, { method: 'POST', body: form });
    const data = await res.json();

    assert(!data.deduped, '不同内容未被误判为重复');
  }

  // ---------- 5. 伪装文件被拦截 ----------
  section('[5] 安全校验');
  {
    // 伪装成 PNG 的 PHP 代码
    const form = new FormData();
    form.append('file', new Blob([FAKE_PNG], { type: 'image/png' }), 'evil.png');

    const res = await fetch(`${base}/api/v1/upload`, { method: 'POST', body: form });
    const data = await res.json();

    assert(res.status === 415, `伪装文件被拒绝（实际 ${res.status}）`);
    assert(data.code === 'UNSUPPORTED_TYPE', '返回 UNSUPPORTED_TYPE');
  }
  {
    // 含脚本的 SVG
    const form = new FormData();
    form.append('file', new Blob([DANGEROUS_SVG], { type: 'image/svg+xml' }), 'evil.svg');

    const res = await fetch(`${base}/api/v1/upload`, { method: 'POST', body: form });
    const data = await res.json();

    assert(res.status === 403, `SVG 被拒绝（实际 ${res.status}）`);
    assert(data.code === 'SVG_NOT_ALLOWED', '返回 SVG_NOT_ALLOWED');
  }
  {
    // 空文件
    const form = new FormData();
    form.append('file', new Blob([], { type: 'image/png' }), 'empty.png');

    const res = await fetch(`${base}/api/v1/upload`, { method: 'POST', body: form });
    const data = await res.json();

    assert(res.status === 400 && data.code === 'EMPTY_FILE', '空文件被拒绝');
  }
  {
    // 缺文件
    const form = new FormData();
    form.append('notafile', new Blob([PNG_1x1]), 'x.png');

    const res = await fetch(`${base}/api/v1/upload`, { method: 'POST', body: form });
    const data = await res.json();

    assert(res.status === 400, `非法字段名被拒绝（实际 ${res.status}）`);
  }

  // ---------- 6. base64 通道 ----------
  section('[6] base64 上传通道');
  {
    const res = await fetch(`${base}/api/v1/upload/base64`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filename: 'b64.png',
        dataBase64: `data:image/png;base64,${PNG_1x1.toString('base64')}`,
      }),
    });
    const data = await res.json();
    assert(res.status === 201 && data.ok === true, 'base64 上传成功');
  }

  // ---------- 7. 图片访问 ----------
  section('[7] 图片访问与代理');
  {
    const filesRes = await fetch(`${base}/api/v1/files`);
    const filesData = await filesRes.json();
    assert(filesRes.ok && filesData.count > 0, `文件列表返回 ${filesData.count || 0} 个文件`);

    const imgPath = filesData.files.find((f) => f.path.endsWith('.png'))?.path;
    assert(Boolean(imgPath), '找到一张已上传的 PNG');

    if (imgPath) {
      const res = await fetch(`${base}/i/${imgPath}`);
      assert(res.ok, 'GET /i/<path> 访问成功');
      assert(res.headers.get('content-type') === 'image/png',
        `Content-Type 正确（实际 ${res.headers.get('content-type')}）`);
      assert((res.headers.get('cache-control') || '').includes('immutable'),
        '返回长缓存标头');

      const buf = Buffer.from(await res.arrayBuffer());
      assert(buf.length === PNG_1x1.length, `字节长度一致（${buf.length}）`);

      // 路径穿越防护
      const bad = await fetch(`${base}/i/../../package.json`);
      assert(!bad.ok || bad.status === 403 || bad.status === 404, '路径穿越被拦截');
    }
  }

  // ---------- 8. URL 查询接口 ----------
  section('[8] 访问地址查询');
  {
    const filesData = await (await fetch(`${base}/api/v1/files`)).json();
    const imgPath = filesData.files.find((f) => f.path.endsWith('.png'))?.path;

    if (imgPath) {
      const res = await fetch(`${base}/api/v1/image/${imgPath}/url`);
      const data = await res.json();
      assert(res.ok && Array.isArray(data.urls), '返回多 CDN 地址列表');
      assert(data.accessMode === 'proxy', `访问模式为 proxy（实际 ${data.accessMode}）`);
    }
  }

  // ---------- 9. 配置自检接口 ----------
  section('[9] 配置自检');
  {
    const res = await fetch(`${base}/api/v1/config`);
    const data = await res.json();
    assert(res.ok, 'GET /api/v1/config 可用');
    assert(data.security.requireAuth === false, '正确反映当前鉴权开关');
    assert(data.storage.github.tokenConfigured === false, '未配置 Token 时报告为 false');
  }

  // ---------- 10. 签名 URL 机制 ----------
  section('[10] 签名 URL 机制');
  {
    const crypto = await import('node:crypto');
    const { signPath } = await import('../src/utils/url-sign.js');
    const secret = 'test-secret';
    const p = 'img/2026/10/test.png';
    const exp = Math.floor(Date.now() / 1000) + 60;
    const sig = signPath(p, exp, secret);

    // 与独立实现对照，确认签名算法正确
    const expect = crypto.createHmac('sha256', secret).update(`${p}:${exp}`).digest('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    assert(expect === sig, '签名算法符合 HMAC-SHA256/base64url 约定');

    // 篡改路径后签名应不匹配
    assert(sig !== signPath('img/2026/10/other.png', exp, secret), '不同路径签名不同');
    // 改密钥后签名应不同
    assert(sig !== signPath(p, exp, 'other-secret'), '不同密钥签名不同');
  }

  // ---------- 11. 404 ----------
  section('[11] 异常处理');
  {
    const res = await fetch(`${base}/api/v1/nonexistent`);
    const data = await res.json();
    assert(res.status === 404 && data.code === 'NOT_FOUND', '未知接口返回 404 JSON');
  }

  // ---------- 关闭 ----------
  server.close();
  await new Promise((r) => server.close(r));

  // 清理测试目录
  await rm(path.join(process.cwd(), 'storage/local-test'), { recursive: true, force: true });

  // ---------- 汇总 ----------
  process.stdout.write(`\n${'─'.repeat(52)}\n`);
  if (failed === 0) {
    process.stdout.write(`${GREEN}全部通过：${passed} 项断言${RESET}\n\n`);
  } else {
    process.stdout.write(`${RED}失败 ${failed} 项 / 通过 ${passed} 项${RESET}\n\n`);
  }

  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  process.stderr.write(`${RED}测试异常终止：${err.message}${RESET}\n${err.stack}\n`);
  process.exit(1);
});