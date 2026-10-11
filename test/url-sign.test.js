/**
 * 签名 URL 校验测试。
 *
 * 单独成文件的原因：verifySignedPath 依赖 config.auth.urlSigningSecret，
 * 而 config 是模块级单例，环境变量必须在导入 config 之前设置。
 * 放在独立进程里跑才能避免与 smoke.js 的配置互相污染。
 */

process.env.NODE_ENV = 'test';
process.env.URL_SIGNING_SECRET = 'unit-test-signing-secret';
process.env.REQUIRE_SIGNED_URL = 'true';

const { buildSignedUrl, signPath, verifySignedPath } = await import('../src/utils/url-sign.js');

let passed = 0;
let failed = 0;

function assert(cond, label) {
  if (cond) { passed += 1; process.stdout.write(`  \x1b[32m✓\x1b[0m ${label}\n`); }
  else { failed += 1; process.stdout.write(`  \x1b[31m✗\x1b[0m ${label}\n`); }
}

process.stdout.write('\n签名 URL 校验测试\n');
process.stdout.write(`${'─'.repeat(52)}\n`);

const PATH = 'img/2026/10/abc.png';

// 正常通过
{
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const sig = signPath(PATH, exp);
  const r = verifySignedPath(PATH, { e: String(exp), s: sig });
  assert(r.ok === true, '有效签名通过校验');
}

// 过期拒绝
{
  const exp = Math.floor(Date.now() / 1000) - 10;
  const sig = signPath(PATH, exp);
  const r = verifySignedPath(PATH, { e: String(exp), s: sig });
  assert(r.ok === false && /过期/.test(r.reason), `过期签名被拒绝（${r.reason}）`);
}

// 路径篡改拒绝
{
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const sig = signPath(PATH, exp);
  const r = verifySignedPath('img/2026/10/hacked.png', { e: String(exp), s: sig });
  assert(r.ok === false, '篡改路径后签名失效');
}

// 缺少签名参数
{
  const r = verifySignedPath(PATH, { e: String(Math.floor(Date.now() / 1000) + 3600) });
  assert(r.ok === false && /签名/.test(r.reason), '缺少签名字段被拒绝');
}

// 非法的过期时间
{
  const r = verifySignedPath(PATH, { e: 'abc', s: 'x' });
  assert(r.ok === false, '非法过期时间被拒绝');
}

// 长度不一的签名不会抛异常
{
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const r = verifySignedPath(PATH, { e: String(exp), s: 'short' });
  assert(r.ok === false, '长度不符的签名被安全拒绝（未抛异常）');
}

// 链接生成
{
  const url = buildSignedUrl('https://img.example.com', PATH, 600);
  assert(url.startsWith('https://img.example.com/i/'), '签名链接包含正确的访问路径');
  assert(/[?&]e=\d+/.test(url) && /[?&]s=/.test(url), '签名链接包含 e 与 s 参数');

  const u = new URL(url);
  const r = verifySignedPath(u.pathname.replace(/^\/i\//, ''), {
    e: u.searchParams.get('e'),
    s: u.searchParams.get('s'),
  });
  assert(r.ok === true, '生成的签名链接可被校验通过');
}

// 跨签名不可用
{
  const url1 = buildSignedUrl('https://img.example.com', 'img/a.png', 600);
  const url2 = buildSignedUrl('https://img.example.com', 'img/b.png', 600);
  assert(url1 !== url2, '不同图片生成不同签名链接');
}

process.stdout.write(`${'─'.repeat(52)}\n`);
process.stdout.write(
  failed === 0
    ? `\x1b[32m全部通过：${passed} 项断言\x1b[0m\n\n`
    : `\x1b[31m失败 ${failed} 项 / 通过 ${passed} 项\x1b[0m\n\n`
);

process.exit(failed === 0 ? 0 : 1);