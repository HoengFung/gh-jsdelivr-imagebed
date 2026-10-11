/**
 * 轻量结构化日志，避免引入额外依赖。
 * 生产环境输出单行 JSON，便于采集；开发环境输出可读格式。
 */

import { config } from '../config/index.js';

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const threshold = LEVELS[config.logging.level] ?? LEVELS.info;

const COLORS = {
  error: '\x1b[31m',
  warn: '\x1b[33m',
  info: '\x1b[36m',
  debug: '\x1b[90m',
};
const RESET = '\x1b[0m';

function format(level, message, meta) {
  const time = new Date().toISOString();

  if (config.isProd) {
    return JSON.stringify({ time, level, message, ...meta });
  }
  const color = COLORS[level] || '';
  const extra = meta && Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
  return `${color}[${time}] ${level.toUpperCase().padEnd(5)}\x1b[0m ${message}${extra}`;
}

function emit(level, message, meta) {
  if (LEVELS[level] > threshold) return;
  const line = format(level, message, meta);
  if (level === 'error') process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
}

export const logger = {
  error: (msg, meta) => emit('error', msg, meta),
  warn: (msg, meta) => emit('warn', msg, meta),
  info: (msg, meta) => emit('info', msg, meta),
  debug: (msg, meta) => emit('debug', msg, meta),
};

export default logger;