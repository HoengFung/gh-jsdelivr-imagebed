/**
 * GitHub 存储驱动 —— 文章方案中「GitHub 仓库即存储」的代码实现。
 *
 * 原理：走 GitHub REST API 的 Contents 接口，把图片以 base64 写入指定分支的目录。
 * 这一步等价于 PicGo 的 GitHub 图床上传，只是把GUI 客户端换成了可被脚本/前端调用的服务端。
 *
 * 关键取舍：
 *  - Contents API 而非 git commit API：一次请求即可完成写入，无需本地克隆与git 环境
 *  - 带 sha 做「已存在则跳过」：内容寻址命名下可天然去重，也避免 422 冲突
 *  - 指数退避重试：GitHub 有secondary rate limit，短暂 5xx/403 很常见
 */

import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { badGateway, payloadTooLarge, AppError } from '../utils/errors.js';

const API_VERSION = '2022-11-28';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 带超时与重试的 fetch 包装。
 */
async function request(url, options = {}, { retries = 3, timeoutMs = 30_000 } = {}) {
  const { token, apiBase } = config.storage.github;
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(url, {
        ...options,
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': API_VERSION,
          'User-Agent': 'gh-jsdelivr-imagebed',
          ...(options.headers || {}),
        },
      });

      clearTimeout(timer);

      // 5xx 与限流值得重试；4xx 直接失败
      if (res.status === 403 || res.status === 429 || res.status >= 500) {
        const text = await res.text().catch(() => '');
        lastError = new AppError(
          `GitHub API ${res.status}: ${text.slice(0, 200)}`,
          res.status === 403 || res.status === 429 ? 429 : 502,
          'GITHUB_RATE_LIMITED'
        );
        if (attempt < retries) {
          const backoff = 2 ** attempt * 500;
          logger.warn('GitHub API 需要重试', {
            status: res.status, attempt: attempt + 1, backoffMs: backoff,
          });
          await sleep(backoff);
          continue;
        }
        throw lastError;
      }

      return res;
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof AppError) throw err;
      lastError = err;
      if (attempt < retries) {
        const backoff = 2 ** attempt * 500;
        logger.warn('GitHub API 请求异常，准备重试', {
          message: err.message, attempt: attempt + 1, backoffMs: backoff,
        });
        await sleep(backoff);
        continue;
      }
    }
  }

  throw lastError || new Error('GitHub API 请求失败');
}

/**
 * 查询文件是否存在，返回其 sha。
 * @returns {Promise<{exists:boolean, sha?:string}>}
 */
export async function statFile(path) {
  const { apiBase, owner, repo, branch } = config.storage.github;
  const url = `${apiBase}/repos/${owner}/${repo}/contents/${encodeRepoPath(path)}?ref=${encodeURIComponent(branch)}`;

  const res = await request(url, { method: 'GET' }, { retries: 1 });

  if (res.status === 404) return { exists: false };
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw badGateway(`查询文件失败: ${res.status} ${text.slice(0, 200)}`, 'GITHUB_STAT_FAILED');
  }

  const data = await res.json();
  return { exists: true, sha: data.sha, size: data.size };
}

/**
 * 写入文件（不存在则创建，存在且内容相同则跳过）。
 * @param {string} path 仓库内相对路径
 * @param {Buffer} buffer 文件内容
 * @returns {Promise<{created:boolean, sha:string, skipped:boolean}>}
 */
export async function putFile(path, buffer) {
  const { apiBase, owner, repo, branch } = config.storage.github;

  // GitHub Contents API 对单文件有 50MB 硬限制，但 base64 编码后体积膨胀约 1/3，
  // 因此这里用更保守的 20MB 作为红线（也与 jsDelivr 单文件 20MB 上限对齐）
  if (buffer.length > 20 * 1024 * 1024) {
    throw payloadTooLarge('文件超过 20MB，无法通过 GitHub Contents API 写入');
  }

  const url = `${apiBase}/repos/${owner}/${repo}/contents/${encodeRepoPath(path)}`;

  // 先查是否已存在 —— 内容寻址命名下，同名即同内容
  const existing = await statFile(path);

  if (existing.exists) {
    logger.info('文件已存在，跳过写入（内容寻址去重命中）', { path });
    return { created: false, sha: existing.sha, skipped: true };
  }

  const res = await request(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: `chore: upload ${path} by imagebed`,
      content: buffer.toString('base64'),
      branch,
    }),
  });

  if (res.status === 422) {
    // 并发下另一个请求刚好写入了同名文件，视为成功（内容相同）
    logger.warn('写入返回 422，按已存在处理', { path });
    const again = await statFile(path);
    return { created: false, sha: again.sha, skipped: true };
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw badGateway(
      `写入 GitHub 失败: ${res.status} ${text.slice(0, 300)}`,
      'GITHUB_PUT_FAILED'
    );
  }

  const data = await res.json();
  logger.info('写入 GitHub 成功', { path, sha: data.content?.sha });
  return { created: true, sha: data.content?.sha, skipped: false };
}

/**
 * 删除文件（需要 sha）。
 */
export async function deleteFile(path, sha) {
  const { apiBase, owner, repo, branch } = config.storage.github;
  const url = `${apiBase}/repos/${owner}/${repo}/contents/${encodeRepoPath(path)}`;

  const res = await request(url, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: `chore: delete ${path} by imagebed`, sha, branch }),
  });

  if (!res.ok && res.status !== 404) {
    const text = await res.text().catch(() => '');
    throw badGateway(`删除失败: ${res.status} ${text.slice(0, 200)}`, 'GITHUB_DELETE_FAILED');
  }
  return res.status !== 404;
}

/**
 * 列出目录下所有文件（递归）。
 */
export async function listFiles(dirPath = '') {
  const { apiBase, owner, repo, branch } = config.storage.github;
  const url = `${apiBase}/repos/${owner}/${repo}/contents/${encodeRepoPath(dirPath)}?ref=${encodeURIComponent(branch)}`;

  const res = await request(url, { method: 'GET' }, { retries: 1 });
  if (res.status === 404) return [];
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw badGateway(`列目录失败: ${res.status} ${text.slice(0, 200)}`, 'GITHUB_LIST_FAILED');
  }

  const data = await res.json();
  if (!Array.isArray(data)) return [];

  const out = [];
  for (const item of data) {
    if (item.type === 'dir') {
      out.push(...(await listFiles(item.path)));
    } else {
      out.push({
        name: item.name,
        path: item.path,
        size: item.size,
        sha: item.sha,
        url: item.download_url,
        updatedAt: item._links?.self ? undefined : undefined,
      });
    }
  }
  return out;
}

/**
 * 校验仓库与 Token 可用性。
 */
export async function checkConnection() {
  const { apiBase, owner, repo, branch } = config.storage.github;
  const url = `${apiBase}/repos/${owner}/${repo}`;
  const res = await request(url, { method: 'GET' }, { retries: 1 });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw badGateway(
      `仓库访问失败: ${res.status} ${text.slice(0, 200)}（请检查 Token 权限、仓库名与仓库是否为私有）`,
      'GITHUB_REPO_UNREACHABLE'
    );
  }

  const data = await res.json();
  return {
    fullName: data.full_name,
    private: data.private,
    defaultBranch: data.default_branch,
    configuredBranch: branch,
    sizeKb: data.size,
    permissions: data.permissions,
  };
}

/**
 * 路径逐段编码，保留 / 作为路径分隔符。
 */
function encodeRepoPath(p) {
  return String(p)
    .replace(/^\/+/, '')
    .split('/')
    .filter(Boolean)
    .map(encodeURIComponent)
    .join('/');
}

export default { statFile, putFile, deleteFile, listFiles, checkConnection };