/**
 * Express 应用装配。
 * 与 server.js 分开是为了让测试可以直接引入 app 而不必真的监听端口。
 */

import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import rateLimit from 'express-rate-limit';

import { config } from './config/index.js';
import { logger } from './utils/logger.js';
import { requestLogger } from './middleware/request-log.js';
import { notFoundHandler, errorHandler } from './middleware/error.js';
import uploadRoutes from './routes/upload.js';
import imageRoutes from './routes/images.js';
import systemRoutes from './routes/system.js';

export function createApp() {
  const app = express();

  // 置于反向代理之后时，信任指定跳数以拿到真实客户端 IP。
  // 不设置的话 req.ip 永远是代理的 IP，限流会把所有人算成同一个来源。
  app.set('trust proxy', config.server.trustProxy);
  app.disable('x-powered-by');

  // 图床服务不对外暴露框架信息
  app.use(
    helmet({
      // 允许跨域读取图片，因此放开 CORP
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      // 关闭 CSP：本服务不提供 HTML，CSP 没有意义
      contentSecurityPolicy: false,
    })
  );

  app.use(
    cors({
      origin: config.cors.origins.includes('*') ? true : config.cors.origins,
      credentials: config.cors.credentials,
      methods: ['GET', 'POST', 'OPTIONS'],
      maxAge: 86400,
    })
  );

  app.use(compression());

  app.use(requestLogger);

  // 全局限流（较宽松）。上传接口另有更严格的独立限流。
  if (config.rateLimit.enabled) {
    app.use(
      rateLimit({
        windowMs: config.rateLimit.global.windowMs,
        max: config.rateLimit.global.max,
        standardHeaders: true,
        legacyHeaders: false,
        skip: () => config.env === 'test',
        message: { ok: false, code: 'RATE_LIMITED', message: '请求过于频繁' },
      })
    );
  }

  // 挂载路由
  app.use('/', systemRoutes);          // /health, /health/ready
  app.use('/api/v1', systemRoutes);   // /api/v1/health, /api/v1/config, /api/v1/files
  app.use('/api/v1', uploadRoutes);   // 上传接口
  app.use('/', imageRoutes);          // /i/:path, /api/v1/image/:path/url

  // 根路径给一个简单的服务说明，避免用户打开域名一脸茫然
  app.get('/', (req, res) => {
    res.json({
      name: 'gh-jsdelivr-imagebed',
      version: '1.0.0',
      description: '基于 GitHub + jsDelivr 的图床服务',
      endpoints: {
        health: '/health',
        ready: '/api/v1/health/ready',
        config: '/api/v1/config',
        upload: 'POST /api/v1/upload',
        uploadBase64: 'POST /api/v1/upload/base64',
        uploadUrl: 'POST /api/v1/url',
        image: '/i/<path>',
        files: '/api/v1/files',
      },
    });
  });

  app.use(notFoundHandler);
  app.use(errorHandler);

  logger.debug('Express 应用装配完成', {
    driver: config.storage.driver,
    accessMode: process.env.ACCESS_MODE || 'proxy',
  });

  return app;
}

export default createApp;