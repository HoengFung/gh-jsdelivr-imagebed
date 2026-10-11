/**
 * 存储驱动统一出口。
 * 上层服务只认这里导出的接口，切换存储后端不需要改业务代码。
 */

import { config } from '../config/index.js';
import * as github from './github.js';
import * as local from './local.js';
import { logger } from '../utils/logger.js';

const drivers = {
  github,
  local,
};

const current = drivers[config.storage.driver];

if (!current) {
  throw new Error(
    `未知的 STORAGE_DRIVER="${config.storage.driver}"，可选值：${Object.keys(drivers).join(' | ')}`
  );
}

logger.debug('已加载存储驱动', { driver: config.storage.driver });

export const driverName = config.storage.driver;
export const statFile = current.statFile;
export const putFile = current.putFile;
export const deleteFile = current.deleteFile;
export const listFiles = current.listFiles;
export const checkConnection = current.checkConnection;

export default {
  driverName,
  statFile,
  putFile,
  deleteFile,
  listFiles,
  checkConnection,
};