/**
 * 系统与运维接口：健康检查、配置自检、文件列表。
 * 这些接口用于部署后验证与故障排查，默认不暴露敏感信息。
 */

import express from 'express';
import { config, validate, buildCdnUrl } from '../config/index.js';
import * as storage from '../storage/index.js';
import { logger } from '../utils/logger.js';
import { NAMING } from '../utils/naming.js';

const router = express.Router();

/**
 * GET /health —— 存活探针
 * 只检查进程是否可响应，不依赖外部服务，避免 GitHub 抖动导致容器被误杀
 */
router.get('/health', (req, res) => {
  res.json({
    ok: true,
    status: 'alive',
    uptime: Number(process.uptime().toFixed(0)),
    timestamp: new Date().toISOString(),
  });
});

/**
 * GET /api/v1/health —— 就绪探针（含依赖连通性）
 * 检查存储驱动是否真的可用，适合 K8s readinessProbe
 */
router.get('/health/ready', async (req, res) => {
  try {
    const info = await storage.checkConnection();
    res.json({
      ok: true,
      status: 'ready',
      driver: storage.driverName,
      storage: info,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    logger.error('就绪检查失败', { message: err.message });
    res.status(503).json({
      ok: false,
      status: 'not_ready',
      driver: storage.driverName,
      message: err.message,
    });
  }
});

/**
 * GET /api/v1/config —— 配置自检
 * 只输出「是否配置」和关键非敏感项，绝不回显 Token 明文
 */
router.get('/config', (req, res) => {
  const errors = validate();

  res.json({
    ok: errors.length === 0,
    validationErrors: errors,
    env: config.env,
    storage: {
      driver: config.storage.driver,
      github: {
        owner: config.storage.github.owner || null,
        repo: config.storage.github.repo || null,
        branch: config.storage.github.branch,
        pathPrefix: config.storage.github.pathPrefix,
        tokenConfigured: Boolean(config.storage.github.token),
        // 只提示 token 前缀用于核对类型，不泄露完整密钥
        tokenHint: config.storage.github.token
          ? `${config.storage.github.token.slice(0, 4)}****`
          : null,
      },
    },
    cdn: {
      baseUrl: config.cdn.baseUrl,
      customDomain: config.cdn.customDomain || null,
      mirrors: config.cdn.mirrors,
      sampleUrl: buildCdnUrl('img/example.jpg'),
    },
    upload: {
      maxFileSize: config.upload.maxFileSize,
      maxFileSizeText: `${(config.upload.maxFileSize / 1024 / 1024).toFixed(2)}MB`,
      allowedExtensions: config.upload.allowedExtensions,
      allowSvg: config.upload.allowSvg,
      maxFiles: config.upload.maxFiles,
      namingStrategy: process.env.NAMING_STRATEGY || NAMING.HASH,
    },
    security: {
      requireAuth: config.auth.requireAuth,
      uploadTokenCount: config.auth.uploadTokens.length,
      requireSignedUrl: config.auth.requireSignedUrl,
      signedUrlConfigured: Boolean(config.auth.urlSigningSecret),
      antiHotlink: {
        enabled: config.antileech.allowedReferers.length > 0
          || config.antileech.allowedOrigins.length > 0,
        allowedReferers: config.antileech.allowedReferers,
        allowedOrigins: config.antileech.allowedOrigins,
        allowEmptyReferer: config.antileech.allowEmptyReferer,
      },
      rateLimitEnabled: config.rateLimit.enabled,
    },
    accessMode: process.env.ACCESS_MODE || 'proxy',
  });
});

/**
 * GET /api/v1/files?dir=img/2026/10 —— 列出已上传文件
 */
router.get('/files', async (req, res, next) => {
  try {
    const dir = String(req.query.dir || '').replace(/^\/+|\/+$/g, '');
    if (dir.includes('..')) {
      return res.status(400).json({ ok: false, message: '非法目录路径' });
    }

    const files = await storage.listFiles(dir);
    const withUrls = files.map((f) => ({
      ...f,
      url: buildCdnUrl(f.path),
    }));

    return res.json({
      ok: true,
      driver: storage.driverName,
      dir: dir || '(root)',
      count: withUrls.length,
      files: withUrls.slice(0, 500),
      truncated: withUrls.length > 500,
    });
  } catch (err) {
    return next(err);
  }
});

export default router;