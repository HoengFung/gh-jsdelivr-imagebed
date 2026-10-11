/**
 * 统一错误类型：让路由层可以精确地把内部异常映射为合适的 HTTP 状态码。
 */

export class AppError extends Error {
  /**
   * @param {string} message 面向调用方的错误描述
   * @param {number} status HTTP 状态码
   * @param {string} code 机器可读的错误码
   * @param {object} [details] 附加信息
   */
  constructor(message, status = 500, code = 'INTERNAL_ERROR', details = undefined) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
    Error.captureStackTrace?.(this, AppError);
  }
}

export const badRequest = (msg, code = 'BAD_REQUEST', details) =>
  new AppError(msg, 400, code, details);

export const unauthorized = (msg = '未授权', code = 'UNAUTHORIZED') =>
  new AppError(msg, 401, code);

export const forbidden = (msg = '禁止访问', code = 'FORBIDDEN') =>
  new AppError(msg, 403, code);

export const notFound = (msg = '资源不存在', code = 'NOT_FOUND') =>
  new AppError(msg, 404, code);

export const payloadTooLarge = (msg, code = 'PAYLOAD_TOO_LARGE') =>
  new AppError(msg, 413, code);

export const unsupportedMediaType = (msg, code = 'UNSUPPORTED_MEDIA_TYPE') =>
  new AppError(msg, 415, code);

export const tooManyRequests = (msg = '请求过于频繁', code = 'RATE_LIMITED') =>
  new AppError(msg, 429, code);

export const badGateway = (msg, code = 'UPSTREAM_ERROR', details) =>
  new AppError(msg, 502, code, details);

export default AppError;