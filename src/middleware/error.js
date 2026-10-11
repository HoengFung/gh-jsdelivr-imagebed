/**
 * 统一错误处理与 404。
 * 目标：对外返回结构化 JSON，内部日志保留完整堆栈，两者信息量不对等。
 */

import { AppError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { config } from '../config/index.js';

export function notFoundHandler(req, res) {
  res.status(404).json({
    ok: false,
    code: 'NOT_FOUND',
    message: `接口不存在：${req.method} ${req.originalUrl}`,
  });
}

/**
 * multer 会把文件过大等错误放在 err.code 上，这里翻译成友好提示。
 */
function translateMulterError(err) {
  switch (err.code) {
    case 'LIMIT_FILE_SIZE':
      return new AppError(
        `文件超过大小上限 ${(config.upload.maxFileSize / 1024 / 1024).toFixed(2)}MB`,
        413,
        'FILE_TOO_LARGE'
      );
    case 'LIMIT_FILE_COUNT':
      return new AppError(`单次最多上传 ${config.upload.maxFiles} 个文件`, 400, 'TOO_MANY_FILES');
    case 'LIMIT_UNEXPECTED_FILE':
      return new AppError(
        `不支持的文件字段名，允许：${config.upload.fields.join(', ')}`,
        400,
        'UNEXPECTED_FIELD'
      );
    default:
      return null;
  }
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  // multer 错误优先翻译
  const translated = translateMulterError(err);
  const finalErr = translated || err;

  const status = finalErr instanceof AppError ? finalErr.status : 500;
  const code = finalErr instanceof AppError ? finalErr.code : 'INTERNAL_ERROR';

  // 5xx 记完整堆栈，4xx 只记摘要（客户端错误通常不值得刷屏）
  if (status >= 500) {
    logger.error('请求处理失败', {
      method: req.method,
      url: req.originalUrl,
      message: finalErr.message,
      stack: finalErr.stack,
    });
  } else {
    logger.warn('请求被拒绝', {
      method: req.method,
      url: req.originalUrl,
      status,
      code,
      message: finalErr.message,
    });
  }

  const body = {
    ok: false,
    code,
    message: status >= 500 && config.isProd ? '服务器内部错误' : finalErr.message,
  };

  if (finalErr instanceof AppError && finalErr.details) {
    body.details = finalErr.details;
  }

  res.status(status).json(body);
}

export default { notFoundHandler, errorHandler };