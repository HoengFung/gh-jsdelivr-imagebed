/**
 * 集中式配置：所有可调项从环境变量读取，带默认值与启动期校验。
 * 密钥类一律不落库、不写死，仅从 .env / 部署平台环境变量注入。
 */

import path from 'node:path';
import fs from 'node:fs';
import process from 'node:process';
import dotenv from 'dotenv';

// 本地存在 .env 时加载；生产环境由容器/编排平台注入变量。
// dotenv 默认不覆盖已存在的环境变量，因此平台注入的配置优先级更高。
const dotenvPath = path.resolve(process.cwd(), '.env');
if (fs.existsSync(dotenvPath)) {
  dotenv.config({ path: dotenvPath });
}

export const bool = (v, dflt = false) => {
  if (v === undefined || v === null || v === '') return dflt;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
};

export const int = (v, dflt) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : dflt;
};

export const list = (v, dflt = []) => {
  if (!v) return dflt;
  return String(v)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
};

const env = process.env.NODE_ENV || 'development';
const isProd = env === 'production';

export const config = {
  env,
  isProd,

  server: {
    port: int(process.env.PORT, 3000),
    host: process.env.HOST || '0.0.0.0',
    // 反向代理层数。Nginx/Caddy 在前则填 1，用于正确解析客户端 IP（限流与防盗链日志需要）
    trustProxy: int(process.env.TRUST_PROXY_HOPS, isProd ? 1 : 0),
    bodyLimit: process.env.BODY_LIMIT || '10mb',
    // 优雅关闭等待存量请求完成的时间
    shutdownTimeoutMs: int(process.env.SHUTDOWN_TIMEOUT_MS, 10_000),
  },

  storage: {
    // github = 生产（仓库即存储，对应文章的方案）；local = 本地磁盘，用于离线调试
    driver: process.env.STORAGE_DRIVER || 'github',

    github: {
      token: process.env.GITHUB_TOKEN || '',
      owner: process.env.GITHUB_OWNER || '',
      repo: process.env.GITHUB_REPO || '',
      branch: process.env.GITHUB_BRANCH || 'main',
      // 图片在仓库中的根目录（对应 PicGo 的「存储路径」）
      pathPrefix: process.env.GITHUB_PATH_PREFIX || 'img',
      apiBase: process.env.GITHUB_API_BASE || 'https://api.github.com',
      requestTimeoutMs: int(process.env.GITHUB_TIMEOUT_MS, 30_000),
      // 单次上传的重试次数（GitHub API 偶发 5xx / secondary rate limit）
      maxRetries: int(process.env.GITHUB_MAX_RETRIES, 3),
    },

    local: {
      dir: path.resolve(
        process.cwd(),
        process.env.LOCAL_STORAGE_DIR || 'storage/local'
      ),
    },
  },

  cdn: {
    // 对应文章中的「自定义域名」：https://cdn.jsdelivr.net/gh/<owner>/<repo>@<branch>
    baseUrl:
      process.env.CDN_BASE_URL ||
      'https://cdn.jsdelivr.net/gh/CHANGE_ME/CHANGE_ME@main',
    // 国内可用镜像，按顺序做故障回退。留空数组则只用官方源
    mirrors: list(process.env.CDN_MIRRORS, [
      'https://cdn.jsdmirror.com/gh',
      'https://fastly.jsdelivr.net/gh',
    ]),
    // 自定义域名（如已接入 Cloudflare / 又拍云），留空则用 baseUrl + mirrors
    customDomain: process.env.CDN_CUSTOM_DOMAIN || '',
  },

  upload: {
    // 单文件大小上限（字节）。默认 5MB：兼顾绝大多数图床场景，且远离 jsDelivr 单文件 20MB 硬限制
    maxFileSize: int(process.env.MAX_FILE_SIZE, 5 * 1024 * 1024),
    // 扩展名白名单
    allowedExtensions: list(process.env.ALLOWED_EXTENSIONS, [
      'jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'bmp', 'svg', 'ico',
    ]),
    // MIME 白名单，作为文件头嗅探后的二次校验
    allowedMime: list(process.env.ALLOWED_MIME, [
      'image/jpeg', 'image/png', 'image/gif', 'image/webp',
      'image/avif', 'image/bmp', 'image/svg+xml', 'image/x-icon',
    ]),
    // 是否允许 SVG。SVG 可内联脚本，默认关闭；开启需自行在 CDN 前加 WAF
    allowSvg: bool(process.env.ALLOW_SVG, false),
    // 单请求文件数上限
    maxFiles: int(process.env.MAX_FILES, 10),
    // multer 接受的字段名别名，兼容 Typora / PicGo / 自研前端
    fields: ['file', 'files', 'image', 'upload'],
  },

  auth: {
    // 上传鉴权：Bearer Token。生产环境下留空会启动失败
    uploadTokens: list(process.env.UPLOAD_TOKENS, []),
    // 是否强制鉴权
    requireAuth: bool(process.env.REQUIRE_AUTH, true),
    // 读取鉴权：图片访问是否需要签名 URL
    requireSignedUrl: bool(process.env.REQUIRE_SIGNED_URL, false),
    // 签名密钥，用于生成带过期时间的访问链接
    urlSigningSecret: process.env.URL_SIGNING_SECRET || '',
    // 签名链接默认有效期（秒）
    urlTtlSeconds: int(process.env.URL_TTL_SECONDS, 3600),
  },

  antileech: {
    // 防盗链：Referer / Origin 白名单。为空表示该维度不启用
    allowedReferers: list(process.env.ALLOWED_REFERERS, []),
    allowedOrigins: list(process.env.ALLOWED_ORIGINS, []),
    // 是否放行没有 Referer 的请求（图片直链、Typora、微信内置浏览器常见）
    allowEmptyReferer: bool(process.env.ALLOW_EMPTY_REFERER, true),
    // 命中防盗链时是否拦截（仅对本站代理生效，直连 jsDelivr 无法拦截）
    blockDirectHotlink: bool(process.env.BLOCK_DIRECT_HOTLINK, true),
  },

  rateLimit: {
    enabled: bool(process.env.RATE_LIMIT_ENABLED, true),
    // 上传接口：较严
    upload: {
      windowMs: int(process.env.RATE_LIMIT_UPLOAD_WINDOW_MS, 60_000),
      max: int(process.env.RATE_LIMIT_UPLOAD_MAX, 30),
    },
    // 全局接口：较松
    global: {
      windowMs: int(process.env.RATE_LIMIT_GLOBAL_WINDOW_MS, 60_000),
      max: int(process.env.RATE_LIMIT_GLOBAL_MAX, 300),
    },
  },

  cors: {
    // 允许跨域的来源。默认放开（图片服务通常需被任意站点引用）；
    // 若仅自用，填入自己的域名即可收紧
    origins: list(process.env.CORS_ORIGINS, ['*']),
    credentials: bool(process.env.CORS_CREDENTIALS, false),
  },

  logging: {
    level: process.env.LOG_LEVEL || (isProd ? 'info' : 'debug'),
    // 打印请求日志（生产默认关闭，避免日志噪声与信息泄露）
    logRequests: bool(process.env.LOG_REQUESTS, false),
  },
};

/**
 * 启动期校验：尽早失败优于运行到一半才报错。
 * @returns {string[]} 错误列表，空数组表示通过
 */
export function validate() {
  const errors = [];

  if (!isProd) return errors;

  if (config.storage.driver === 'github') {
    const g = config.storage.github;
    if (!g.token) errors.push('缺少 GITHUB_TOKEN');
    if (!g.owner) errors.push('缺少 GITHUB_OWNER');
    if (!g.repo) errors.push('缺少 GITHUB_REPO');
    if (!/^[A-Za-z0-9._-]+$/.test(g.owner)) errors.push('GITHUB_OWNER 格式非法');
    if (!/^[A-Za-z0-9._-]+$/.test(g.repo)) errors.push('GITHUB_REPO 格式非法');
    if (!/^[A-Za-z0-9._\-/]+$/.test(g.branch)) errors.push('GITHUB_BRANCH 格式非法');
  }

  if (config.auth.requireAuth && config.auth.uploadTokens.length === 0) {
    errors.push('REQUIRE_AUTH=true 时必须配置至少一个 UPLOAD_TOKENS');
  }

  if (config.auth.requireSignedUrl && !config.auth.urlSigningSecret) {
    errors.push('REQUIRE_SIGNED_URL=true 时必须配置 URL_SIGNING_SECRET');
  }

  if (!config.cdn.baseUrl || config.cdn.baseUrl.includes('CHANGE_ME')) {
    errors.push('CDN_BASE_URL 未正确配置（或仍为占位符 CHANGE_ME）');
  }

  return errors;
}

/**
 * 将仓库内路径转为浏览器可访问的 CDN URL。
 * @param {string} repoPath 形如 img/2026/01/xxxx.jpg
 */
export function buildCdnUrl(repoPath) {
  const clean = String(repoPath).replace(/^\/+/, '');

  if (config.cdn.customDomain) {
    const base = config.cdn.customDomain.replace(/\/+$/, '');
    return `${base}/${clean}`;
  }

  const base = config.cdn.baseUrl.replace(/\/+$/, '');
  return `${base}/${clean}`;
}

/**
 * 从 CDN_BASE_URL 中解析出 owner/repo/branch。
 * 形如 https://cdn.jsdelivr.net/gh/<owner>/<repo>@<branch>
 *
 * 为什么要解析而不是直接读配置？
 * 因为 CDN_BASE_URL 本身就携带了这些信息。当用户只填了 CDN_BASE_URL
 * 而没填 GITHUB_OWNER 时（本地调试常见），镜像回退地址依然能正确生成。
 */
function parseCdnBase() {
  const m = String(config.cdn.baseUrl || '').match(/\/gh\/([^/]+)\/([^/@]+)(?:@([^/]+))?/);
  if (!m) return null;
  return { owner: m[1], repo: m[2], branch: m[3] || config.storage.github.branch };
}

/**
 * 生成备用 CDN 链接列表，供客户端侧故障回退。
 * jsDelivr 国内链路不稳定，单源不可用时前端可自动切换。
 */
export function buildCdnFallbackUrls(repoPath) {
  const clean = String(repoPath).replace(/^\/+/, '');
  const urls = [buildCdnUrl(clean)];

  if (config.cdn.customDomain) return urls;

  const parsed = parseCdnBase();
  const owner = config.storage.github.owner || parsed?.owner;
  const repo = config.storage.github.repo || parsed?.repo;
  const branch = config.storage.github.branch || parsed?.branch;

  if (owner && repo && owner !== 'CHANGE_ME') {
    for (const m of config.cdn.mirrors) {
      const base = m.replace(/\/+$/, '');
      urls.push(`${base}/${owner}/${repo}@${branch}/${clean}`);
    }
  }

  return [...new Set(urls)];
}

/**
 * 仓库内原始地址（raw.githubusercontent），用于防盗链代理与镜像回源。
 */
export function buildRawUrl(repoPath) {
  const clean = String(repoPath).replace(/^\/+/, '');
  const parsed = parseCdnBase();
  const owner = config.storage.github.owner || parsed?.owner;
  const repo = config.storage.github.repo || parsed?.repo;
  const branch = config.storage.github.branch || parsed?.branch;

  if (!owner || !repo || owner === 'CHANGE_ME') return null;
  return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${clean}`;
}

export default config;