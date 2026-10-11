/**
 * 请求日志中间件。
 * 刻意不打印请求体/Header：Authorization 里有 Token，落日志等于泄露。
 */

import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';

export function requestLogger(req, res, next) {
  if (!config.logging.logRequests) return next();

  const start = process.hrtime.bigint();

  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
    logger.info(`${req.method} ${req.originalUrl} ${res.statusCode}`, {
      ip: req.ip,
      durationMs: Number(durationMs.toFixed(1)),
    });
  });

  return next();
}

export default requestLogger;