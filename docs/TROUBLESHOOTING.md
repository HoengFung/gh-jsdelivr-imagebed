# 故障排查手册

按**现象**组织。先用最快的方式定位问题，再对照对应章节。

---

## 0. 三十秒自检

```bash
curl -s http://127.0.0.1:3000/api/v1/config | python -m json.tool
```

这个接口会直接告诉你：配置是否完整、缺了什么、当前各开关状态。
**它不会返回任何密钥明文**，可以放心贴给别人看。

```bash
# 服务还活着吗
curl -s http://127.0.0.1:3000/health

# 存储通吗（这个会真实连 GitHub）
curl -s http://127.0.0.1:3000/api/v1/health/ready
```

---

## 1. 服务启动问题

### 启动即退出，日志报「配置校验失败」

```
配置校验失败，服务无法启动：
  -缺少 GITHUB_TOKEN
  - CDN_BASE_URL 未正确配置（或仍为占位符 CHANGE_ME）
```

**原因**：`.env` 没填，或占位符没替换全。

**解决**：

```bash
ls -la .env                    # 确认文件存在
grep CHANGE_ME .env            # 找出所有未替换的占位符
cp .env.example .env           # 没文件就复制一份
```

> `validate()` 只在 `NODE_ENV=production` 时执行完整校验，
> 开发模式故意放行，方便快速调试。生产环境缺配置会**直接退出而不是带病运行**。

### 启动报「存储连通性检查失败」

```
存储连通性检查失败
  消息：GitHub API 404: Not Found
```

| 现象 | 原因 | 解决 |
|---|---|---|
| 404 | 仓库不存在或 Token 无权访问 | 检查 `GITHUB_OWNER` / `GITHUB_REPO` 拼写 |
| 401 | Token 无效或已过期 | 重新生成 Token |
| 403 | Token 权限不足 | 确认勾选了 `Contents: Read and write` |
| ENOTFOUND / 超时 | 网络无法访问 `api.github.com` | 检查服务器网络与代理设置 |
| 仓库是私有的 | **jsDelivr 无法访问私有仓库** | 改为公开仓库 |

### 端口被占用

```
Error: listen EADDRINUSE: address already in use :::3000
```

```bash
lsof -i :3000          # macOS / Linux
ss -lptn 'sport = :3000'# Linux
netstat -ano | findstr :3000   # Windows
```

改端口：`.env` 里设 `PORT=3001`，同时改 Nginx 的 `proxy_pass` 目标端口。

---

## 2. 上传问题

### 401 `MISSING_TOKEN` / 403 `INVALID_TOKEN`

```
缺少上传凭证，请通过 Authorization: Bearer <token> 提供
```

**排查顺序**：

```bash
# 1. 请求头格式对不对？必须是 Bearer，注意大小写和空格
curl -X POST http://127.0.0.1:3000/api/v1/upload \
  -H "Authorization: Bearer abc123" \
  -F "file=@test.png"
```

**易错点**：

| 错误写法 | 说明 |
|---|---|
| `Authorization: abc123` | 缺 `Bearer ` 前缀 |
| `Authorization: bearer abc123` | 大小写不影响（代码做了 `i` 标志），但建议统一 |
| `Authorization: Bearer  abc123` | **两个空格** —— 会导致 token 尾部带空格，校验失败 |
| 从 `.env` 复制时带了引号 | `"abc123"` 会被当成含引号的字符串 |

**验证配置是否生效**：

```bash
curl -s http://127.0.0.1:3000/api/v1/config | grep uploadTokenCount
# 期望：uploadTokenCount: 1 或更大；若为 0 说明 .env 没被加载
```

> 若 `.env` 里有多 Token，用**逗号**分隔，不能有空格：
> `UPLOAD_TOKENS=token1,token2,token3`
> 代码会 `trim()` 每个条目，但空值会被过滤。

### 400 `NO_FILE` / `UNEXPECTED_FIELD`

```
未接收到文件，请以 multipart/form-data 上传，字段名支持：file, files, image, upload
```

| 问题 | 解决 |
|---|---|
| 用了 `--data` 而非 `-F` | curl 必须用 `-F`（`-F "file=@path"`） |
| 字段名不在白名单 | 改用 `file` / `image` / `files` / `upload` |
| Content-Type 设错了 | 不要手动设 `Content-Type`，让 curl 自动带 boundary |

正确写法：

```bash
curl -X POST http://127.0.0.1:3000/api/v1/upload \
  -H "Authorization: Bearer $TOKEN" \
  -F "file=@./test.png"          # ← 注意 -F
```

### 404 `GITHUB_PUT_FAILED` —— 分支不对

**这是最常见的配置错误。**

GitHub 2020 年前创建的仓库默认分支是 `master`，之后是 `main`。
填错分支时，GitHub API 会返回 404。

```bash
# 确认仓库实际分支
gh repo view <owner>/<repo> --json defaultBranchRef
# 或直接看仓库页面右上角
```

修正 `.env`：

```bash
GITHUB_BRANCH=master    # 或 main，以实际为准
```

> `npm run init:repo` 会自动对比并提示分支不一致。

### 413 `FILE_TOO_LARGE` / `LIMIT_FILE_SIZE`

```
文件大小 8.50MB 超过上限 5.00MB
```

**应用层**：调大 `.env` 的 `MAX_FILE_SIZE`，重启服务。

**Nginx 层**（更容易被忽略）：

```bash
nginx -T | grep client_max_body_size
```

如果 Nginx 的 `client_max_body_size` 小于应用的上限，
请求会在 Nginx 层就被截断，客户端收到 Nginx 的 413 而**不是**应用的清晰报错。

```nginx
# /etc/nginx/conf.d/imagebed.conf 或站点配置
client_max_body_size 10m;   # 必须 >= MAX_FILE_SIZE
```

参考上限：

| 层 | 限制 |
|---|---|
| 应用 `MAX_FILE_SIZE` | 默认 5MB |
| Nginx `client_max_body_size` | 需 ≥ 应用值 |
| jsDelivr 单文件 | **20MB 硬限制** |
| GitHub Contents API | 50MB（base64 编码后膨胀约 1/3，实际约 38MB） |

> 建议保持在 **5MB 以内**：图床场景绝大多数图片都够用，
> 且远低于 jsDelivr 的硬限制，避免踩坑。

### 415 `UNSUPPORTED_TYPE` / `EXT_NOT_ALLOWED`

```
无法识别的文件类型，仅支持图片文件（依据文件头判定）
```

**本服务按文件头（magic number）判定真实类型，不信任文件扩展名和客户端声明的 Content-Type。**
这是有意为之 —— 否则把 `shell.php` 改名成 `x.png` 就能绕过校验。

| 你上传的是 | 判定结果 | 说明 |
|---|---|---|
| 正常 PNG/JPG | ✅ 通过 | |
| 文本文件改名 `.png` | ❌ 拦截 | 文件头不是图片签名 |
| WebP / AVIF | ✅ 通过 | 已支持 |
| HEIC（iPhone 原生格式） | ⚠️ 部分支持 | 见下方说明 |
| 视频 / 音频 / 文档 | ❌ 拦截 | 设计如此 |

**HEIC 说明**：`.env` 默认白名单不含 `heic`。iPhone 拍照的 HEIC 需要先转换：

```bash
# macOS
sips -s format jpeg photo.heic --out photo.jpg

# ImageMagick
magick photo.heic photo.jpg

# 或在线转换后再上传
```

要放开更多格式，编辑 `.env` 的 `ALLOWED_EXTENSIONS` 与 `ALLOWED_MIME`。

### 403 `SVG_NOT_ALLOWED`

```
出于安全考虑默认禁止上传 SVG（可内联脚本）
```

SVG 本质是 XML，可以内联 `<script>`、`onload=` 事件、`javascript:` 伪协议，
是经典的 XSS 载体，因此默认禁用。

**确需上传 SVG**：

```bash
ALLOW_SVG=true
```

开启后仍会做深度检测，拦截包含 `<script>`、内联事件、`javascript:`、
`<foreignObject>`、DOCTYPE ENTITY（XXE）的 SVG。

> ⚠️ 即使开了检测，SVG 的攻击面仍远大于位图。
> 务必在 CDN 前加 WAF 规则，或干脆在用户侧转成 PNG。

### 502 `GITHUB_PUT_FAILED`

```
写入 GitHub 失败: 502 Bad Gateway
```

| 检查 | 命令 |
|---|---|
| 网络能否访问 GitHub | `curl -sI https://api.github.com` |
| Token 有效性 | `curl -s -H "Authorization: Bearer $TOKEN" https://api.github.com/user \| head -3` |
| 配额是否耗尽 | `curl -s https://api.github.com/rate_limit -H "Authorization: Bearer $TOKEN"` |
| 日志中的真实错误 | `docker compose logs --tail=50 imagebed` 或 `pm2 logs imagebed` |

**关于限流**：GitHub 对匿名请求是 60 次/小时，对认证请求是 5000 次/小时。
认证请求配额很充裕，但如果做批量导入，注意代码里已实现的**指数退避重试**。

---

## 3. 图片访问问题

### 新上传的图片 404

```
图片暂时无法访问。新上传的图片在 jsDelivr 上同步通常有 10~60 秒延迟，请稍后重试
```

**这是正常现象，不是 bug。** jsDelivr 是异步从 GitHub 拉取并缓存的，
新文件入库到 CDN 可分发之间有延迟。

| 场景 | 解决 |
|---|---|
| `ACCESS_MODE=proxy`（默认） | **不受影响** —— 直接读源站，不经过 CDN 同步 |
| 等一会儿再试 | 10~60 秒 |
| 确认文件确实提交了 | `npm run upload:cli` 返回的 `rawUrl` 字段可直接访问验证 |

**永久解决方案**：用 `ACCESS_MODE=proxy`，图片走自己的服务器，完全不依赖 CDN 同步。

### `cdn.jsdelivr.net` 访问慢或超时

这是 jsDelivr 在国内最常见的问题 —— 官方虽有"近中国"节点，但链路质量不稳定。

**方案一：使用备用镜像（已内置）**

上传响应里的 `fallbackUrls` 已包含多个镜像：

```json
{
  "url": "https://cdn.jsdelivr.net/gh/owner/repo@main/img/a.png",
  "fallbackUrls": [
    "https://cdn.jsdelivr.net/gh/owner/repo@main/img/a.png",
    "https://cdn.jsdmirror.com/gh/owner/repo@main/img/a.png",
    "https://fastly.jsdelivr.net/gh/owner/repo@main/img/a.png"
  ]
}
```

前端可依次探测，取第一个可用的：

```js
async function pickCdn(urls) {
  for (const url of urls) {
    try {
      const r = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(3000) });
      if (r.ok) return url;
    } catch { /* 试下一个 */ }
  }
  return urls[0];
}
```

**方案二：走自己的代理（`ACCESS_MODE=proxy`）**

图片流量走你的服务器，速度取决于你的服务器带宽与位置。
境内服务器 + 已备案域名，实测通常比直连 jsDelivr 更快更稳。

**方案三：接入自己的 CDN**

把 `CDN_CUSTOM_DOMAIN` 指向已接入 Cloudflare / 又拍云的域名，
图片经你的源站分发。国内访问用又拍云联合腾讯云效果更好。

### 403 `HOTLINK_BLOCKED`

```
来源不在防盗链白名单内
```

**防盗链确实在工作。** 检查请求的 Referer 是否在 `.env` 的 `ALLOWED_REFERERS` 里。

```bash
# 看请求带的 Referer
curl -s -v http://127.0.0.1:3000/i/img/2026/10/xxx.png 2>&1 | grep -i referer
```

**常见误区**：

| 误区 | 说明 |
|---|---|
| 「我用自己的域名访问怎么被拦」 | 如果用 `curl` 直连，**根本没有 Referer**，而你可能设了 `ALLOW_EMPTY_REFERER=false` |
| 「Referer 明明是对的」 | 检查是否写了协议和 `www.`。代码会归一化，但要注意实际值 |
| 「图片贴在微信里就不显示」 | 微信内置浏览器不发 Referer，需 `ALLOW_EMPTY_REFERER=true` |

**归一化规则**：协议前缀、`www.`、路径都会被剥离后比较。
所以 `https://www.example.com/post/1` 与 `example.com` 视为同一站点。

**子域通配**：`ALLOWED_REFERERS=*.example.com` 匹配 `a.example.com` 与 `example.com`。

**想临时关闭防盗链**：清空 `ALLOWED_REFERERS` 与 `ALLOWED_ORIGINS` 两项。

### ⚠️ 防盗链的根本限制

**必须理解，否则会白忙活**：

只要图片链接是 `cdn.jsdelivr.net/...` 的**直链形式**，
任何人拿到就能直接引用 —— 请求根本不经过你的服务器，Referer 校验无从谈起。

```
防盗链的实际效果（ACCESS_MODE=proxy 时）：

  ✅ /i/img/a.png        → 经你的服务器 → 防盗链生效
  ❌ cdn.jsdelivr.net/... → 直接访问 jsDelivr → 防盗链无效
```

**要让防盗链真正生效**：

1. 使用 `ACCESS_MODE=proxy`，对外**只暴露 `/i/` 路径**，不暴露 CDN 直链
2. 或改用对象存储私有读 + 签名 URL（本项目已内置签名机制作为过渡）

---

## 4. 配置与鉴权问题

### 限流不准 —— 所有请求算作同一个 IP

```
明明是多用户，但配额消耗像是共享的
```

**原因**：`TRUST_PROXY_HOPS` 未设置。经过 Nginx 后，`req.ip` 永远是 `127.0.0.1`，
限流器把所有请求都算作同一个来源。

**解决**：`.env` 设 `TRUST_PROXY_HOPS=1`（Nginx 在一层）

同时确认 Nginx 透传了真实 IP：

```nginx
proxy_set_header X-Real-IP         $remote_addr;
proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $scheme;
```

验证：

```bash
# 从两个不同来源访问，看日志里的 IP 是否不同
tail -f logs/out.log
```

### 429 请求过于频繁

| 调整项 | 环境变量 |
|---|---|
| 上传限流阈值 | `RATE_LIMIT_UPLOAD_MAX`（默认 30 次/分钟） |
| 上传限流窗口 | `RATE_LIMIT_UPLOAD_WINDOW_MS`（默认 60000） |
| 全局限流 | `RATE_LIMIT_GLOBAL_MAX`（默认 300 次/分钟） |
| Nginx 层限流 | `limit_req_zone` 的 `rate=` 与 `burst=` |

两层的阈值应大致匹配，否则会出现「应用还没限流，Nginx 先拒了」或反之。

### 签名链接报 403 `INVALID_SIGNATURE`

```
访问被拒绝：链接已过期
```

签名 URL 有有效期（默认 `URL_TTL_SECONDS=3600`，即 1 小时）。

| 检查 | 说明 |
|---|---|
| 是否过期 | 调整 `URL_TTL_SECONDS` |
| 服务是否重启过 | 改了 `URL_SIGNING_SECRET` 会让旧签名全部失效 |
| 路径是否被改 | 签名绑定完整路径，改任何一个字符都会失配 |
| 多实例部署 | **所有实例的 `URL_SIGNING_SECRET` 必须一致**，否则验签随机失败 |

> ⚠️ 多实例（PM2 cluster / K8s 多副本）时，
> 密钥必须通过环境变量统一注入，不能每个实例各写一份不同的。

---

## 5. 性能与容量

### 仓库体积增长过快

GitHub 仓库的建议上限是 1GB，硬上限 5GB（软警告）。

```bash
# 查看仓库大小
curl -s https://api.github.com/repos/<owner>/<repo> \
  -H "Authorization: Bearer $TOKEN" | grep '"size"'
```

**控制手段**：

1. **启用去重**（默认已开）—— 同一张图重复上传不会重复存储
2. **压缩图片后再上传** —— WebP 格式通常比 PNG 小 60~80%
3. **定期清理旧图** —— 删除仓库中不再需要的文件
4. **限制大小** —— `MAX_FILE_SIZE` 不要设太大

**注意 jsDelivr 的限制**（比 GitHub 更严格）：

| 项目 | jsDelivr 限制 |
|---|---|
| 单文件 | 20MB |
| 单包/仓库 | **150MB** |
| 活跃文件数 | 建议 ≤ 10,000 |

> 仓库超过 150MB 时 jsDelivr 可能停止分发。
> 如果你看到所有图片突然全 404，**先查仓库体积**。

### 上传响应慢

上传是「接收 → 校验 → 调 GitHub API → 等 commit → 返回」，瓶颈在 GitHub。

| 优化 | 效果 |
|---|---|
| `GITHUB_MAX_RETRIES` 调大 | 网络抖动时更稳（但失败时更慢） |
| 用 `proxy` 模式 + 短 `Content-Length` | 无明显改善，瓶颈仍在 GitHub |
| PM2 cluster 多实例 | **有效**，上传是 IO 密集型，多进程可显著提升并发 |

### 内存占用高

```bash
docker stats imagebed          # Docker
pm2 monit                      # PM2
```

本服务使用 `memoryStorage`，**整个文件读进内存**再校验。
5MB 上限 × 并发数是可预期的峰值占用。

- 调小 `MAX_FILE_SIZE` 可直接降低内存压力
- 大文件应改为流式落盘（需要调整 multer 配置为 `diskStorage`）

---

## 6. 快速对照表

| 状态码 | 错误码 | 90% 的原因 |
|---|---|---|
| 400 | `MISSING_TOKEN` | 没带 `Authorization` 头 |
| 400 | `INVALID_TOKEN` | Token 拼错，或从 `.env` 复制时带了引号/空格 |
| 400 | `NO_FILE` | curl 用了 `--data` 而非 `-F` |
| 400 | `UNEXPECTED_FIELD` | 字段名不在白名单 |
| 400 | `EMPTY_FILE` | 上传了 0 字节文件 |
| 403 | `SVG_NOT_ALLOWED` | SVG 默认禁用 |
| 403 | `HOTLINK_BLOCKED` | Referer 不在白名单 |
| 404 | — | 分支名填错（`main` vs `master`） |
| 404 | `NOT_FOUND` | 接口路径拼错 |
| 413 | `FILE_TOO_LARGE` | 超过 `MAX_FILE_SIZE`，或 Nginx 限制更严 |
| 415 | `UNSUPPORTED_TYPE` | 不是真实图片，或格式在白名单外 |
| 429 | `RATE_LIMITED` | 触发限流 |
| 429 | `GITHUB_RATE_LIMITED` | GitHub API 配额耗尽 |
| 502 | `GITHUB_PUT_FAILED` | Token 权限 / 仓库名 / 网络 |
| 503 | — | 存储不可达，看 `/api/v1/health/ready` 的 message |

---

## 7. 彻底排障流程

按顺序执行，每一步都能缩小范围：

```bash
# ① 服务活着吗
curl -s http://127.0.0.1:3000/health

# ② 配置对吗（最有用的一步）
curl -s http://127.0.0.1:3000/api/v1/config | python -m json.tool

# ③ 存储通吗
curl -s http://127.0.0.1:3000/api/v1/health/ready | python -m json.tool

# ④ Token 能访问 GitHub 吗
curl -s -H "Authorization: Bearer $GITHUB_TOKEN" \
  https://api.github.com/repos/$GITHUB_OWNER/$GITHUB_REPO | head -20

# ⑤ 完整的配置校验（含权限检查）
npm run init:repo

# ⑥ 看日志
docker compose logs --tail=100 imagebed
# 或
pm2 logs imagebed --lines 100
```

如果 ④ 通过但上传仍失败，检查 `.env` 里的值是否与服务实际加载的一致
（`/api/v1/config` 的 `storage.github` 字段会反映真实生效值）。

---

## 相关文档

- [README.md](../README.md) — 快速开始与 API
- [DEPLOYMENT.md](DEPLOYMENT.md) — 部署步骤与验证清单
- [ARTICLE-COMPARISON.md](ARTICLE-COMPARISON.md) — 与原文章方案的差异