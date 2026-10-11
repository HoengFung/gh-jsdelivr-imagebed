/**
 * 图片访问接口。
 *
 * 三种访问模式（ACCESS_MODE 控制）：
 *
 *  1. public  —— 上传后直接返回 cdn.jsdelivr.net 链接，不经过本服务。
 *     最快、零流量成本，但没有防盗链能力（jsDelivr 侧无法拦截外链）。
 *
 *  2. redirect —— GET /i/:path 返回 302 跳转到 CDN。
 *     本服务可在此处做防盗链与签名校验，但用户仍会看到真实 CDN 域名。
 *
 *  3. proxy   —— GET /i/:path 由本服务回源并转发图片字节。
 *     防盗链与访问控制真正生效（真正的私有化），代价是流量走自己的服务器。
 *
 * 默认 proxy，因为它是唯一能真正落实「访问鉴权 + 防盗链」的方案。
 */

import express from 'express';
import { config, buildCdnUrl, buildCdnFallbackUrls, buildRawUrl } from '../config/index.js';
import { verifySignedPath, buildSignedUrl } from '../utils/url-sign.js';
import { antiHotlink } from '../middleware/anti-hotlink.js';
import { forbidden, notFound, badRequest, badGateway } from '../utils/errors.js';
import { sniffImage } from '../utils/file-type.js';
import { logger } from '../utils/logger.js';

const router = express.Router();

const ACCESS_MODE = process.env.ACCESS_MODE || 'proxy';

/** 防盗链中间件（仅对本站代理路径生效） */
const hotlinkGuard = antiHotlink({ enabled: config.antileech.blockDirectHotlink });

/** 本地驱动时直接从磁盘读，避免本地调试还要起一个 CDN */
async function readLocal(pathname) {
  const { default: fs } = await import('node:fs/promises');
  const path = await import('node:path');
  const root = path.resolve(config.storage.local.dir);
  const target = path.resolve(root, pathname.replace(/^\/+/, ''));

  // 路径穿越防护
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw forbidden('非法路径', 'PATH_TRAVERSAL');
  }

  try {
    return await fs.readFile(target);
  } catch {
    throw notFound('图片不存在', 'IMAGE_NOT_FOUND');
  }
}

/**
 * GET /i/:path(*)
 * 例：/i/img/2026/10/3f9a....jpg
 */
router.get(/^\/i\/(.+)$/, hotlinkGuard, async (req, res, next) => {
  try {
    const rawPath = req.params[0];

    // 拒绝路径穿越
    if (rawPath.includes('..') || rawPath.includes('\0')) {
      throw forbidden('非法路径', 'PATH_TRAVERSAL');
    }

    const pathname = decodeURIComponent(rawPath).replace(/^\/+/, '');
    if (!pathname) throw badRequest('缺少图片路径', 'MISSING_PATH');

    // 读取鉴权：启用签名时必须验签通过
    if (config.auth.requireSignedUrl) {
      const result = verifySignedPath(pathname, req.query);
      if (!result.ok) {
        logger.warn('签名校验失败', { path: pathname, reason: result.reason });
        throw forbidden(`访问被拒绝：${result.reason}`, 'INVALID_SIGNATURE');
      }
    }

    // 模式 1：直接 302 到 CDN
    if (ACCESS_MODE === 'redirect') {
      return res.redirect(302, buildCdnUrl(pathname));
    }

    // 模式 2/3：回源并由本服务转发字节
    let buffer;

    if (config.storage.driver === 'local') {
      buffer = await readLocal(pathname);
    } else {
      // 优先走 CDN（更快，且 CDN 已缓存），失败再回退 raw
      const sources = [buildCdnUrl(pathname), buildRawUrl(pathname)].filter(Boolean);
      buffer = null;

      for (const url of sources) {
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 15_000);
          const res2 = await fetch(url, { signal: controller.signal });
          clearTimeout(timer);

          if (!res2.ok) continue;
          const arr = Buffer.from(await res2.arrayBuffer());
          if (arr.length === 0) continue;
          buffer = arr;
          break;
        } catch {
          /* 试下一个源 */
        }
      }

      if (!buffer) {
        // CDN 与 raw 都拿不到：可能 jsDelivr 尚未同步新文件（通常有几十秒延迟）
        throw notFound(
          '图片暂时无法访问。新上传的图片在 jsDelivr 上同步通常有 10~60 秒延迟，请稍后重试',
          'IMAGE_NOT_READY'
        );
      }
    }

    // 用文件头判定 Content-Type，避免用户上传时声明的类型污染响应头
    const sniffed = sniffImage(buffer);

    res.set({
      'Content-Type': sniffed.mime,
      'Content-Length': String(buffer.length),
      // 图片内容寻址，理论上永不变化 —— 可放心长缓存
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': 'inline',
    });

    return res.send(buffer);
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /api/v1/image/:path(*)/url
 * 查询某张图片的全部可用访问地址（用于客户端故障回退）。
 * 同时兼容不带 /api/v1 前缀的简写形式。
 */
router.get(/^\/(?:api\/v1\/)?image\/(.+)\/url$/, async (req, res, next) => {
  try {
    const pathname = decodeURIComponent(req.params[0]).replace(/^\/+/, '');
    if (!pathname) throw badRequest('缺少图片路径', 'MISSING_PATH');

    const origin = `${req.protocol}://${req.get('host') || ''}`;

    const payload = {
      ok: true,
      path: pathname,
      urls: buildCdnFallbackUrls(pathname),
      proxyUrl: `${origin}/i/${pathname}`,
      accessMode: ACCESS_MODE,
    };

    if (config.auth.requireSignedUrl && config.auth.urlSigningSecret) {
      payload.signedUrl = buildSignedUrl(origin, pathname);
    }

    return res.json(payload);
  } catch (err) {
    return next(err);
  }
});

export default router;