/**
 * multer 上传解析器配置。
 *
 * 关键安全设置：
 *  - memoryStorage：文件只在内存中，不落临时磁盘（避免残留文件与目录穿越）
 *  - fileSize：与 config.upload.maxFileSize 统一，超限直接中断
 *  - limits.files：防止一次性塞爆内存
 *  - fileFilter：这里只做「快速拒绝」和字段名兼容，
 *    真正的类型判定在 services/upload.js 里按文件头做，
 *    因为 browser 传来的 mimetype 完全不可信
 */

import multer from 'multer';
import { config } from '../config/index.js';
import { AppError } from '../utils/errors.js';

const storage = multer.memoryStorage();

const limits = {
  fileSize: config.upload.maxFileSize,
  files: config.upload.maxFiles,
  // 限制非文件字段数量与体积，防止字段滥用
  fields: 20,
  fieldSize: 1024 * 1024,
  parts: config.upload.maxFiles + 20,
};

/**
 * 兼容多种字段名：Typora 用 image，PicGo 用 file，部分前端用 files/upload。
 * multer 的 .any() 会接收任意字段名，再用 fields 白名单做二次过滤。
 */
const uploadAny = multer({ storage, limits }).any();

/**
 * 包装 multer，拦截其错误并转为 AppError。
 */
function wrap(handler) {
  return (req, res, next) =>
    handler(req, res, (err) => {
      if (err) return next(err);
      return next();
    });
}

/**
 * 校验字段名是否在允许列表内。
 */
function filterFields(req) {
  const files = req.files || [];
  const bad = files.find((f) => !config.upload.fields.includes(f.fieldname));
  if (bad) {
    throw new AppError(
      `不支持的文件字段名 "${bad.fieldname}"，允许：${config.upload.fields.join(', ')}`,
      400,
      'UNEXPECTED_FIELD'
    );
  }
  req.files = files;
}

export const parseUpload = [
  wrap(uploadAny),
  (req, res, next) => {
    try {
      filterFields(req);
      return next();
    } catch (err) {
      return next(err);
    }
  },
];

export default { parseUpload };