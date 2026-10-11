/**
 * 防盗链（Referer / Origin 校验）。
 *
 * 必须讲清楚的边界 —— 这决定了你能把防盗链做到什么程度：
 *
 *  ✗ 直连 cdn.jsdelivr.net 的链接无法防外链。jsDelivr 是公共 CDN，
 *    任何人都能拿到 URL 直接引用，Referer 根本不会经过你的服务器。
 *    这也是 jsDelivr 官方 ToS 明确禁止「把 CDN 当通用图床存储」的原因。
 *
 *  ✓ 本站代理路径（/i/:path）可以拦。本服务在这里做 Referer 白名单校验，
 *    不通过则返回 403 或占位图。
 *
 *  ✓ Nginx 层可以对自有域名做同样校验（见 deploy/nginx/imagebed.conf）。
 *
 * 所以：防盗链是「减少盗刷」而非「杜绝盗链」。要真正强约束，
 * 只能换成私有桶 + 签名 URL 的对象存储（如 COS/OSS/S3 私有读+签名）。
 * 本项目已内置签名 URL 机制作为过渡方案。
 */

import { config } from '../config/index.js';
import { forbidden } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

/** 归一化：去掉协议、www.、结尾斜杠，便于比较 */
function normalizeHost(value) {
  if (!value) return '';
  let v = String(value).trim().toLowerCase();
  v = v.replace(/^https?:\/\//, '');
  v = v.replace(/^www\./, '');
  v = v.replace(/\/.*$/, '');
  return v;
}

function parseRefererHost(req) {
  const ref = req.get('referer');
  if (!ref) return { host: '', present: false };
  try {
    return { host: normalizeHost(new URL(ref).host), present: true };
  } catch {
    return { host: '', present: true };
  }
}

function parseOriginHost(req) {
  const origin = req.get('origin');
  if (!origin) return { host: '', present: false };
  try {
    return { host: normalizeHost(new URL(origin).host), present: true };
  } catch {
    return { host: '', present: true };
  }
}

/**
 * @param {boolean} options.enabled 是否启用
 */
export function antiHotlink(options = {}) {
  const enabled = options.enabled ?? true;

  return function antiHotlinkMiddleware(req, res, next) {
    if (!enabled) return next();

    const { allowedReferers, allowedOrigins, allowEmptyReferer } = config.antileech;

    // 两组白名单都为空 = 不启用防盗链
    if (allowedReferers.length === 0 && allowedOrigins.length === 0) {
      return next();
    }

    const referer = parseRefererHost(req);
    const origin = parseOriginHost(req);

    // Referer 白名单校验
    if (allowedReferers.length > 0) {
      if (!referer.present) {
        // 无 Referer：直链、Typora 粘贴、微信内置浏览器等常见场景
        if (!allowEmptyReferer) {
          logger.warn('防盗链拦截：无 Referer', { ip: req.ip, url: req.originalUrl });
          return next(forbidden('缺少 Referer，已被防盗链策略拦截', 'HOTLINK_NO_REFERER'));
        }
      } else {
        const ok = allowedReferers.some((r) => {
          const target = normalizeHost(r);
          const ref = referer.host;
          if (!target || !ref) return false;
          // 支持 *.example.com 形式的子域通配
          if (target.startsWith('*.')) {
            const base = target.slice(2);
            return ref === base || ref.endsWith(`.${base}`);
          }
          return ref === target;
        });

        if (!ok) {
          logger.warn('防盗链拦截：Referer 不在白名单', {
            referer: referer.host, ip: req.ip, url: req.originalUrl,
          });
          return next(forbidden('来源不在防盗链白名单内', 'HOTLINK_BLOCKED'));
        }
      }
    }

    // Origin 白名单校验（跨域场景下 Origin 比 Referer 更可靠）
    if (allowedOrigins.length > 0 && origin.present) {
      const ok = allowedOrigins.some((o) => {
        const target = normalizeHost(o);
        return target === '*' || target === origin.host;
      });

      if (!ok) {
        logger.warn('防盗链拦截：Origin 不在白名单', {
          origin: origin.host, ip: req.ip, url: req.originalUrl,
        });
        return next(forbidden('跨域来源不在白名单内', 'HOTLINK_ORIGIN_BLOCKED'));
      }
    }

    return next();
  };
}

export default antiHotlink;