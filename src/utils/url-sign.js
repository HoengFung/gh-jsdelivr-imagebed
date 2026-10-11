/**
 * 签名 URL：给图片访问加一个可过期、可撤销的凭证。
 *
 * 重要前提与边界（务必理解再决定是否启用）：
 * jsDelivr 的公共 URL 本身是任何人拿到就能访问的，签名只能保护
 * 「本站代理回源」这条路径（/i/:path 走本服务）。一旦把 cdn.jsdelivr.net
 * 的直链贴到第三方站点，jsDelivr 侧无法做Referer 校验，
 * 此时防盗链只能靠 Nginx 层或改用私有桶 + 签名 URL 的对象存储。
 *
 * 签名格式：<path>?e=<expiryEpochSec>&s=<hmacSha256 base64url>
 */

import crypto from 'node:crypto';
import { config } from '../config/index.js';

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * 计算签名。
 * @param {string} path 仓库内相对路径
 * @param {number} expiresAt 过期时间戳（秒）
 * @param {string} [secret] 密钥，默认取配置
 */
export function signPath(path, expiresAt, secret = config.auth.urlSigningSecret) {
  const clean = String(path).replace(/^\/+/, '');
  const payload = `${clean}:${expiresAt}`;
  const hmac = crypto.createHmac('sha256', secret).update(payload).digest();
  return base64url(hmac);
}

/**
 * 生成完整的签名访问链接。
 * @param {string} origin 本站源，如 https://img.example.com
 * @param {string} path 仓库内相对路径
 * @param {number} [ttl] 有效期（秒）
 */
export function buildSignedUrl(origin, path, ttl = config.auth.urlTtlSeconds) {
  const clean = String(path).replace(/^\/+/, '');
  const expiresAt = Math.floor(Date.now() / 1000) + ttl;
  const sig = signPath(clean, expiresAt);
  const q = new URLSearchParams({ e: String(expiresAt), s: sig });
  return `${String(origin).replace(/\/+$/, '')}/i/${clean}?${q.toString()}`;
}

/**
 * 校验签名。使用 timingSafeEqual 防时序攻击。
 * @returns {{ok:boolean, reason?:string}}
 */
export function verifySignedPath(path, query) {
  if (!config.auth.urlSigningSecret) {
    return { ok: false, reason: '服务端未配置签名密钥' };
  }

  const exp = Number.parseInt(query?.e ?? '', 10);
  const sig = String(query?.s ?? '');

  if (!Number.isFinite(exp)) return { ok: false, reason: '缺少或非法的过期时间' };
  if (!sig) return { ok: false, reason: '缺少签名' };
  if (exp * 1000 < Date.now()) return { ok: false, reason: '链接已过期' };

  const expected = signPath(path, exp);
  const a = Buffer.from(expected);
  const b = Buffer.from(sig);

  // timingSafeEqual 要求等长，长度不同直接判否
  if (a.length !== b.length) return { ok: false, reason: '签名不匹配' };
  if (!crypto.timingSafeEqual(a, b)) return { ok: false, reason: '签名不匹配' };

  return { ok: true };
}

export default { signPath, buildSignedUrl, verifySignedPath };