/**
 * 服务入口：启动校验 → 监听 → 优雅关闭。
 *
 * 优雅关闭很重要：容器滚动更新时直接 kill 会中断正在上传的请求，
 * 导致 GitHub 侧留下半成品 commit。
 */

import process from 'node:process';
import { createApp } from './app.js';
import { config, validate } from './config/index.js';
import { logger } from './utils/logger.js';
import * as storage from './storage/index.js';

async function main() {
  // 1. 配置校验 —— 有问题直接退出，不带病启动
  const errors = validate();
  if (errors.length > 0) {
    logger.error('配置校验失败，服务无法启动：');
    for (const e of errors) logger.error(`  - ${e}`);
    logger.error('请检查 .env 或部署平台的环境变量配置');
    process.exit(1);
  }

  // 2. 存储连通性预检
  try {
    const info = await storage.checkConnection();
    logger.info('存储连通性检查通过', { driver: storage.driverName, ...info });
  } catch (err) {
    logger.error('存储连通性检查失败', { message: err.message });
    if (config.isProd) {
      logger.error('生产环境无法访问存储后端，终止启动');
      process.exit(1);
    }
    logger.warn('开发环境：继续启动，但上传功能可能不可用');
  }

  // 3. 启动 HTTP 服务
  const app = createApp();
  const server = app.listen(config.server.port, config.server.host, () => {
    logger.info('图床服务已启动', {
      url: `http://${config.server.host}:${config.server.port}`,
      env: config.env,
      driver: storage.driverName,
      accessMode: process.env.ACCESS_MODE || 'proxy',
      authRequired: config.auth.requireAuth,
      signedUrl: config.auth.requireSignedUrl,
      antiHotlink:
        config.antileech.allowedReferers.length > 0
        || config.antileech.allowedOrigins.length > 0,
    });

    // 生产环境不打印任何密钥，仅打印是否存在
    if (config.storage.github.token) {
      logger.info(`GitHub 目标仓库：${config.storage.github.owner}/${config.storage.github.repo}@${config.storage.github.branch}`);
    }
  });

  // 上传是耗时操作（要调 GitHub API），超时放宽
  server.requestTimeout = 120_000;
  server.headersTimeout = 125_000;
  server.keepAliveTimeout = 61_000;

  // 4. 优雅关闭
  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`收到 ${signal}，开始优雅关闭…`);

    const forceTimer = setTimeout(() => {
      logger.warn('优雅关闭超时，强制退出');
      process.exit(1);
    }, config.server.shutdownTimeoutMs);
    forceTimer.unref();

    server.close((err) => {
      clearTimeout(forceTimer);
      if (err) {
        logger.error('关闭 HTTP 服务时出错', { message: err.message });
        process.exit(1);
      }
      logger.info('HTTP 服务已关闭，进程退出');
      process.exit(0);
    });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // 未捕获异常：记录后退出，交给进程管理器重启。
  // 不吞掉异常继续跑 —— 状态可能已经不一致，静默损坏比崩溃更危险。
  process.on('unhandledRejection', (reason) => {
    logger.error('未处理的 Promise 拒绝', {
      reason: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack : undefined,
    });
  });

  process.on('uncaughtException', (err) => {
    logger.error('未捕获异常，进程即将退出', { message: err.message, stack: err.stack });
    process.exit(1);
  });
}

main().catch((err) => {
  logger.error('服务启动失败', { message: err.message, stack: err.stack });
  process.exit(1);
});