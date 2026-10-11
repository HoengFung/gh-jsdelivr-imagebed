/**
 * 上传接口。
 *
 * 设计兼容三类调用方：
 *  1. curl / 脚本      —— multipart/form-data，字段名 file
 *  2. Typora / PicGo   —— 同样是 multipart，字段名 image 或 file
 *  3. 自研前端         —— multipart 批量；另提供 base64 JSON 通道（应对无二进制流的场景）
 */

import express from 'express';
import rateLimit from 'express-rate-limit';
import { config, buildCdnUrl } from '../config/index.js';
import { parseUpload } from '../middleware/upload.js';
import { requireUploadAuth } from '../middleware/auth.js';
import { uploadOne, uploadMany } from '../services/upload.js';
import { badRequest } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

const router = express.Router();

/** 上传限流：比全局更严，防止刷爆 GitHub API 配额 */
const uploadLimiter = rateLimit({
  windowMs: config.rateLimit.upload.windowMs,
  max: config.rateLimit.upload.max,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    ok: false,
    code: 'RATE_LIMITED',
    message: '上传过于频繁，请稍后再试',
  },
  skip: () => !config.rateLimit.enabled,
});

/**
 * POST /api/v1/upload
 * multipart/form-data，字段名 file / image / files / upload
 */
router.post('/upload', uploadLimiter, requireUploadAuth, parseUpload, async (req, res, next) => {
  try {
    const files = req.files || [];
    if (files.length === 0) {
      throw badRequest(
        `未接收到文件，请以 multipart/form-data 上传，字段名支持：${config.upload.fields.join(', ')}`,
        'NO_FILE'
      );
    }

    const origin = `${req.protocol}://${req.get('host') || ''}`;

    // 单文件走简化响应，方便 Typora / PicGo 直接取 url 字段
    if (files.length === 1) {
      const file = files[0];
      const result = await uploadOne({
        buffer: file.buffer,
        originalname: file.originalname,
        mimetype: file.mimetype,
        origin,
      });
      return res.status(201).json(result);
    }

    const results = await uploadMany(files, origin);
    const succeeded = results.filter((r) => r.ok);

    return res.status(succeeded.length ? 201 : 422).json({
      ok: succeeded.length > 0,
      total: results.length,
      succeeded: succeeded.length,
      failed: results.length - succeeded.length,
      results,
    });
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /api/v1/upload/base64
 * JSON 通道：{ filename, dataBase64, mimeType }
 * 适用于不便构造 multipart 的调用方（如部分小程序/服务端 SDK）
 */
router.post('/upload/base64', uploadLimiter, requireUploadAuth, express.json({ limit: config.server.bodyLimit }), async (req, res, next) => {
  try {
    const { filename = 'image', dataBase64, mimeType = '' } = req.body || {};

    if (!dataBase64) {
      throw badRequest('缺少 dataBase64 字段', 'MISSING_DATA');
    }

    //兼容 data:image/png;base64,xxx 与纯 base64 两种写法
    const base64 = String(dataBase64).replace(/^data:[^;]+;base64,/, '');
    const buffer = Buffer.from(base64, 'base64');

    if (buffer.length === 0) {
      throw badRequest('base64 解码后内容为空，请确认数据是否完整', 'INVALID_BASE64');
    }

    const result = await uploadOne({
      buffer,
      originalname: filename,
      mimetype: mimeType,
      origin: `${req.protocol}://${req.get('host') || ''}`,
    });

    return res.status(201).json(result);
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /api/v1/url
 * 远程图片转存：{ url }
 *
 * 注意：这是一个 SSRF 敏感接口，因此：
 *  - 默认关闭，需显式设置 ENABLE_URL_FETCH=true 开启
 *  - 强制协议白名单（仅 http/https）
 *  - 阻断内网/回环/元数据地址（169.254.169.254 等）
 *  - 受上传鉴权与限流保护
 */
router.post('/url', uploadLimiter, requireUploadAuth, express.json({ limit: '64kb' }), async (req, res, next) => {
  try {
    if (process.env.ENABLE_URL_FETCH !== 'true') {
      throw badRequest(
        '远程转存接口默认关闭，如需开启请设置 ENABLE_URL_FETCH=true',
        'URL_FETCH_DISABLED'
      );
    }

    const { url } = req.body || {};
    if (!url) throw badRequest('缺少 url 字段', 'MISSING_URL');

    let target;
    try {
      target = new URL(url);
    } catch {
      throw badRequest('url 格式非法', 'INVALID_URL');
    }

    if (!['http:', 'https:'].includes(target.protocol)) {
      throw badRequest('仅支持 http/https 协议的 URL', 'INVALID_PROTOCOL');
    }

    // SSRF 防护：拒绝内网与云元数据地址
    const hostname = target.hostname.toLowerCase();
    const blocked =
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '::1' ||
      hostname === '0.0.0.0' ||
      hostname.endsWith('.localhost') ||
      hostname.endsWith('.internal') ||
      /^169\.254\./.test(hostname) ||
      /^10\./.test(hostname) ||
      /^192\.168\./.test(hostname) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(hostname);

    if (blocked) {
      throw badRequest('目标地址属于内网范围，出于安全考虑已拒绝', 'SSRF_BLOCKED');
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);

    let upstream;
    try {
      upstream = await fetch(target.toString(), {
        signal: controller.signal,
        redirect: 'follow',
        headers: { 'User-Agent': 'gh-jsdelivr-imagebed' },
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!upstream.ok) {
      throw badRequest(`远程获取失败：HTTP ${upstream.status}`, 'UPSTREAM_FAILED');
    }

    const buffer = Buffer.from(await upstream.arrayBuffer());

    const result = await uploadOne({
      buffer,
      originalname: target.pathname.split('/').pop() || 'image',
      mimetype: upstream.headers.get('content-type') || '',
      origin: `${req.protocol}://${req.get('host') || ''}`,
    });

    return res.status(201).json({ ...result, sourceUrl: target.toString() });
  } catch (err) {
    if (err.name === 'AbortError') {
      return next(badRequest('远程获取超时', 'UPSTREAM_TIMEOUT'));
    }
    return next(err);
  }
});

export default router;