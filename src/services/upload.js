/**
 * 上传核心服务：校验 → 命名 → 去重 → 落盘 → 生成访问链接。
 *
 * 校验顺序刻意如此设计（先便宜后昂贵，先安全后功能）：
 *   1. 空文件        —— 零成本
 *   2. 大小          —— 已在 multer 层拦住，这里是兜底
 *   3. 文件头嗅探    —— 真实类型判定，安全的核心
 *   4. SVG 深度检查  —— 仅当类型是 SVG
 *   5. 扩展名/MIME 白名单 —— 功能性约束
 */

import { config } from '../config/index.js';
import { sniffImage, inspectSvg, extOf, sanitizeFilename } from '../utils/file-type.js';
import { buildObjectPath } from '../utils/naming.js';
import { buildCdnUrl, buildCdnFallbackUrls, buildRawUrl } from '../config/index.js';
import { buildSignedUrl } from '../utils/url-sign.js';
import * as storage from '../storage/index.js';
import { logger } from '../utils/logger.js';
import { badRequest, unsupportedMediaType, forbidden } from '../utils/errors.js';

/**
 * 校验单个文件。
 * @param {{buffer:Buffer, originalname:string, mimetype:string}} file
 * @returns {{ext:string, mime:string, kind:string}}
 */
export function validateFile(file) {
  const { buffer } = file;

  if (!buffer || buffer.length === 0) {
    throw badRequest('文件内容为空', 'EMPTY_FILE');
  }

  if (buffer.length > config.upload.maxFileSize) {
    const mb = (buffer.length / 1024 / 1024).toFixed(2);
    const limit = (config.upload.maxFileSize / 1024 / 1024).toFixed(2);
    throw badRequest(`文件大小 ${mb}MB 超过上限 ${limit}MB`, 'FILE_TOO_LARGE');
  }

  // 关键：只看真实字节，不信客户端声明
  const sniffed = sniffImage(buffer);

  if (sniffed.kind === 'unknown') {
    throw unsupportedMediaType(
      '无法识别的文件类型，仅支持图片文件（依据文件头判定）',
      'UNSUPPORTED_TYPE'
    );
  }

  // SVG 可内联脚本，默认拒绝
  if (sniffed.kind === 'svg' && !config.upload.allowSvg) {
    throw forbidden(
      '出于安全考虑默认禁止上传 SVG（可内联脚本），如确需请设置 ALLOW_SVG=true 并在前置 WAF 加规则',
      'SVG_NOT_ALLOWED'
    );
  }

  if (sniffed.kind === 'svg') {
    const { dangerous, reasons } = inspectSvg(buffer);
    if (dangerous) {
      throw forbidden(`SVG 包含危险内容：${reasons.join('、')}`, 'SVG_DANGEROUS');
    }
  }

  // 功能性白名单
  if (!config.upload.allowedExtensions.includes(sniffed.ext)) {
    throw unsupportedMediaType(
      `不支持的图片格式：${sniffed.ext}，允许：${config.upload.allowedExtensions.join(', ')}`,
      'EXT_NOT_ALLOWED'
    );
  }

  if (!config.upload.allowedMime.includes(sniffed.mime)) {
    throw unsupportedMediaType(
      `不支持的 MIME 类型：${sniffed.mime}`,
      'MIME_NOT_ALLOWED'
    );
  }

  return sniffed;
}

/**
 * 上传单个文件。
 *
 * @param {object} params
 * @param {Buffer} params.buffer
 * @param {string} params.originalname
 * @param {string} [params.mimetype]
 * @param {string} [params.origin] 请求来源，用于生成签名链接
 * @returns {Promise<object>} 上传结果
 */
export async function uploadOne({ buffer, originalname = '', mimetype = '', origin = '' }) {
  const info = validateFile({ buffer, originalname, mimetype });

  const safeName = sanitizeFilename(originalname);
  const { path: objectPath, hash, dedupKey } = buildObjectPath({
    buffer,
    ext: info.ext,
    originalName: safeName,
  });

  // 命名策略若为 hash，扩展名固定；若为 original，扩展名仍用嗅探结果（安全）
  const finalPath = objectPath;

  const existing = await storage.statFile(finalPath);
  let result;
  let deduped = false;

  if (existing.exists) {
    deduped = true;
    result = { created: false, skipped: true, sha: existing.sha };
    logger.info('命中去重，跳过重复上传', { path: finalPath });
  } else {
    result = await storage.putFile(finalPath, buffer);
  }

  const cdnUrl = buildCdnUrl(finalPath);
  const payload = {
    ok: true,
    deduped,
    duplicate: deduped,
    hash,
    dedupKey,
    filename: finalPath.split('/').pop(),
    path: finalPath,
    ext: info.ext,
    mime: info.mime,
    size: buffer.length,
    sizeText: formatSize(buffer.length),
    // 主访问地址：生产走 CDN
    url: cdnUrl,
    // 备用地址：jsDelivr 国内链路不稳，前端可按序回退
    fallbackUrls: buildCdnFallbackUrls(finalPath),
    // 原始仓库地址：排障时用来确认文件确实已提交
    rawUrl: buildRawUrl(finalPath),
    commitSha: result.sha || null,
    driver: storage.driverName,
  };

  // 需要签名访问时，额外给一条代理链接
  if (config.auth.requireSignedUrl && origin) {
    payload.signedUrl = buildSignedUrl(origin, finalPath);
  }

  return payload;
}

/**
 * 批量上传：逐个处理，单个失败不影响其他（返回逐项结果）。
 * @param {Array} files
 * @param {string} origin
 */
export async function uploadMany(files, origin = '') {
  const results = [];

  for (const file of files) {
    try {
      const r = await uploadOne({
        buffer: file.buffer,
        originalname: file.originalname,
        mimetype: file.mimetype,
        origin,
      });
      results.push(r);
    } catch (err) {
      results.push({
        ok: false,
        filename: sanitizeFilename(file.originalname || ''),
        code: err.code || 'UPLOAD_FAILED',
        message: err.message,
      });
    }
  }

  return results;
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)}MB`;
}

export default { uploadOne, uploadMany, validateFile };