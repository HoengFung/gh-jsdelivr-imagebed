#!/usr/bin/env node
/**
 * 仓库初始化脚本。
 *
 * 用途：
 *  1. 校验 .env 配置是否正确（Token 权限、仓库是否存在、是否可写）
 *  2. 在仓库中创建 .nojekyll 与 README占位，让仓库「看起来像一个正经项目」
 *     —— 这既是jsDelivr ToS 对使用者项目的建议，也能降低被判定为纯存储滥用
 *     的风险（ToS 明确提到有意义的仓库名、公开文档、许可证属于良好实践）
 *  3. 预建图片目录（GitHub API 不会自动创建空目录）
 *
 * 用法：npm run init:repo
 */

import process from 'node:process';
import { config, buildCdnUrl } from '../src/config/index.js';
import * as storage from '../src/storage/index.js';
import { logger } from '../src/utils/logger.js';

const RESET = '\x1b[0m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const DIM = '\x1b[90m';

const ok = (m) => process.stdout.write(`${GREEN}✓${RESET} ${m}\n`);
const warn = (m) => process.stdout.write(`${YELLOW}!${RESET} ${m}\n`);
const fail = (m) => process.stdout.write(`${RED}✗${RESET} ${m}\n`);
const info = (m) => process.stdout.write(`${DIM}  ${m}${RESET}\n`);

async function main() {
  process.stdout.write('\n图床服务 · 仓库初始化与配置自检\n');
  process.stdout.write(`${'─'.repeat(52)}\n`);

  // ---------- 1. 配置检查 ----------
  process.stdout.write('\n[1/4] 检查配置\n');

  if (config.storage.driver !== 'github') {
    warn(`当前 STORAGE_DRIVER="${config.storage.driver}"，初始化仓库仅在 github 驱动下有意义`);
    process.exit(0);
  }

  const g = config.storage.github;
  const problems = [];

  if (!g.token) problems.push('GITHUB_TOKEN 未配置');
  if (!g.owner || g.owner === 'CHANGE_ME') problems.push('GITHUB_OWNER 未配置');
  if (!g.repo || g.repo === 'CHANGE_ME') problems.push('GITHUB_REPO 未配置');

  if (problems.length) {
    problems.forEach(fail);
    process.stdout.write('\n请先复制并填写 .env：cp .env.example .env\n\n');
    process.exit(1);
  }
  ok(`仓库目标：${g.owner}/${g.repo} @ ${g.branch}`);
  ok(`存储路径：${g.pathPrefix}/<yyyy>/<mm>/`);

  // ---------- 2. 连通性与权限 ----------
  process.stdout.write('\n[2/4] 校验 Token 与仓库访问\n');

  let repoInfo;
  try {
    repoInfo = await storage.checkConnection();
    ok(`仓库可达：${repoInfo.fullName}`);
    info(`可见性：${repoInfo.private ? '私有（jsDelivr 无法访问私有仓库！）' : '公开'}`);

    if (repoInfo.private) {
      fail('仓库是私有的，jsDelivr 无法访问私有仓库 —— 必须改为公开仓库');
      process.exit(1);
    }

    if (repoInfo.permissions && !repoInfo.permissions.push) {
      fail('Token 没有仓库写权限（push），请在 Token 设置中勾选 repo 或 Contents: Read and write');
      process.exit(1);
    }
    ok('Token 具备写权限');
    info(`仓库当前大小：${(repoInfo.sizeKb / 1024).toFixed(2)} MB`);
    info(`仓库默认分支：${repoInfo.defaultBranch}（本服务配置为 ${repoInfo.configuredBranch}）`);

    if (repoInfo.defaultBranch !== repoInfo.configuredBranch) {
      warn(`分支不一致：仓库默认分支是 ${repoInfo.defaultBranch}，但配置写的是 ${repoInfo.configuredBranch}`);
      warn('若上传报 404，请修正 .env 中的 GITHUB_BRANCH');
    }
  } catch (err) {
    fail(`仓库访问失败：${err.message}`);
    info('排查方向：');
    info('  1. Token 是否过期或被撤销');
    info('  2. 仓库名拼写是否正确（区分 owner/repo）');
    info('  3. 网络是否能访问 api.github.com');
    process.exit(1);
  }

  // ---------- 3. 仓库初始化文件 ----------
  process.stdout.write('\n[3/4] 初始化仓库辅助文件\n');

  const year = new Date().getFullYear();
  const month = String(new Date().getMonth() + 1).padStart(2, '0');

  const files = [
    {
      path: '.nojekyll',
      content: Buffer.from('', 'utf8'),
      note: '禁用 Jekyll 处理，GitHub Pages 才能原样暴露文件',
    },
    {
      path: 'README.md',
      content: Buffer.from(
`# ${g.repo}

本仓库用于存放图床图片，文件路径：\`${g.pathPrefix}/<年>/<月>/<哈希>.<扩展名>\`

访问地址由 jsDelivr CDN 提供：

    ${buildCdnUrl(`${g.pathPrefix}/${year}/${month}/example.jpg`)}

> 本仓库中的文件通过内容哈希（SHA-256）命名，重复上传同一张图会复用同一文件，
> 因此同一 URL 的内容永不变化，适合长期缓存。

图片服务接口方：图床服务 v1.0.0 · ${new Date().toISOString().slice(0, 10)}
`,
        'utf8'
      ),
      note: '仓库说明（jsDelivr 官方建议仓库有文档与许可证）',
    },
  ];

  for (const f of files) {
    const exists = await storage.statFile(f.path);
    if (exists.exists) {
      info(`${f.path} 已存在，跳过`);
    } else {
      await storage.putFile(f.path, f.content);
      ok(`已创建 ${f.path} — ${f.note}`);
    }
  }

  // ---------- 4. 目录预热 ----------
  process.stdout.write('\n[4/4] 预创建当月目录\n');

  const probeName = `${g.pathPrefix}/${year}/${month}/.gitkeep`;
  const probeExists = await storage.statFile(probeName);
  if (probeExists.exists) {
    info(`当月目录已就绪（${year}/${month}）`);
  } else {
    await storage.putFile(probeName, Buffer.from('', 'utf8'));
    ok(`已创建当月目录占位文件 ${probeName}`);
  }

  // ---------- 完成 ----------
  process.stdout.write(`\n${'─'.repeat(52)}\n`);
  process.stdout.write(`${GREEN}初始化完成${RESET}\n\n`);
  process.stdout.write('接下来：\n');
  process.stdout.write('  1. 启动服务：npm start\n');
  process.stdout.write('  2. 验证：curl http://127.0.0.1:3000/api/v1/health/ready\n');
  process.stdout.write('  3. 测试上传：npm run upload:cli -- ./test.png\n\n');
}

main().catch((err) => {
  fail(`初始化失败：${err.message}`);
  logger.error('初始化异常', { stack: err.stack });
  process.exit(1);
});