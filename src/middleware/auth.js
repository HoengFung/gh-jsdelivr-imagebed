/**
 * 上传鉴权：Bearer Token。
 *
 * 设计要点：
 *  - 用 timingSafeEqual 比较，避免时序侧信道
 *  - 支持多个 Token，便于多端/多环境隔离与轮换
 *  - 生产环境强制开启（REQUIRE_AUTH=true 时无Token 直接启动失败）
 */

import crypto from 'node:crypto';
import { config } from '../config/index.js';
import { unauthorized, forbidden } from '../utils/errors.js';

/** 定长比较：先各自做 SHA-256 得到等长摘要，再 timingSafeEqual */
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/**
 * 从请求中提取凭证。支持三种写法：
 *   Authorization: Bearer <token>
 *   X-Upload-Token: <token>
 *   ?token=<token>          （仅在 ALLOW_QUERY_TOKEN=true 时启用）
 */
function extractToken(req) {
  const auth = req.get('authorization');
  if (auth && /^Bearer\s+/i.test(auth)) {
    return auth.replace(/^Bearer\s+/i, '').trim();
  }

  const header = req.get('x-upload-token') || req.get('x-api-key');
  if (header) return header.trim();

  if (process.env.ALLOW_QUERY_TOKEN === 'true' && req.query.token) {
    return String(req.query.token);
  }

  return null;
}

export function requireUploadAuth(req, res, next) {
  if (!config.auth.requireAuth) return next();

  const token = extractToken(req);

  if (!token) {
    return next(
      unauthorized('缺少上传凭证，请通过 Authorization: Bearer <token> 提供', 'MISSING_TOKEN')
    );
  }

  const matched = config.auth.uploadTokens.some((t) => safeEqual(t, token));

  if (!matched) {
    return next(forbidden('上传凭证无效', 'INVALID_TOKEN'));
  }

  return next();
}

export default requireUploadAuth;