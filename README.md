# gh-jsdelivr-imagebed

基于 **GitHub 仓库 + jsDelivr CDN** 的自建图床服务，提供 HTTP 上传 API、访问鉴权、防盗链与限流。

> 本项目是对腾讯云社区文章《利用 github+jsDelivr 搭建图床》技术方案的工程化实现。
> 保留了文章的核心思路（仓库即存储 + CDN 加速），把 PicGo 这个 GUI 客户端
> 换成可被脚本、前端、CI 调用的服务端接口，并补齐了文章未涉及的安全与运维能力。
> **与原方案的差异及取舍理由见 [docs/ARTICLE-COMPARISON.md](docs/ARTICLE-COMPARISON.md)。**

---

## 目录

- [核心特性](#核心特性)
- [快速开始](#快速开始)
- [项目结构](#项目结构)
- [环境变量说明](#环境变量说明)
- [API 接口](#api-接口)
- [三种访问模式](#三种访问模式)
- [与 PicGo / Typora 配合](#与-picgo--typora-配合)
- [本地调试](#本地调试)
- [线上部署](#线上部署)
- [常见故障排查](#常见故障排查)
- [⚠️ 合规提示](#️-合规提示)

---

## 核心特性

| 能力 | 说明 |
|---|---|
| **上传 API** | multipart / base64 / 远程 URL 三种通道，兼容 Typora、PicGo、curl、自研前端 |
| **真实类型校验** | 按文件头（magic number）判定，不信任客户端声明的 Content-Type |
| **内容寻址命名** | SHA-256 前 32 位命名，同图自动去重，URL 内容永不变化利于 CDN 长缓存 |
| **访问鉴权** | Bearer Token 上传鉴权（多 Token、定长比较防时序攻击）；可选签名 URL 读鉴权 |
| **防盗链** | Referer / Origin 白名单，支持 `*.example.com` 子域通配 |
| **限流** | 应用层 + Nginx 层双重限流 |
| **SSRF 防护** | 远程转存接口默认关闭，开启后阻断内网与云元数据地址 |
| **故障回退** | 返回多个 CDN 地址，jsDelivr 不通时自动切镜像 |
| **健康检查** | 存活探针 + 就绪探针 + 配置自检接口，便于 K8s / 监控接入 |

---

## 快速开始

### 前置条件

- Node.js ≥ 18.17（推荐 20 / 22 LTS）
- 一个**公开**的 GitHub 仓库（jsDelivr 无法访问私有仓库）
- 一个 GitHub Personal Access Token，具备该仓库的写权限

### 三步启动

```bash
# 1. 安装依赖
npm install

# 2. 配置环境变量
cp .env.example .env
# 编辑 .env，至少填写这四项：
#   GITHUB_TOKEN / GITHUB_OWNER / GITHUB_REPO / CDN_BASE_URL
#   以及 UPLOAD_TOKENS（生成方式：openssl rand -hex 32）

# 3. 校验配置并启动
npm run init:repo    # 检查 Token 权限、仓库可访问性、创建辅助文件
npm start
```

看到 `图床服务已启动` 即成功。

```bash
# 上传一张图试试
curl -X POST http://127.0.0.1:3000/api/v1/upload \
  -H "Authorization: Bearer <你的 UPLOAD_TOKENS>" \
  -F "file=@./test.png"

# 返回
{
  "ok": true,
  "path": "img/2026/10/c414cd0e204de974f73753c7e28d7638.png",
  "url": "https://cdn.jsdelivr.net/gh/<owner>/<repo>@main/img/2026/10/c414cd0e...png",
  "fallbackUrls": ["...jsdelivr.net...", "...jsdmirror.com...", "...fastly.jsdelivr.net..."],
  "deduped": false,
  "size": 20481
}
```

> **刚上传的图片在 jsDelivr 上通常有 10~60 秒同步延迟**，期间访问直链会 404，属正常现象。
> 代理模式（`ACCESS_MODE=proxy`）会先读本地/源站，不受此延迟影响。

---

## 项目结构

```
.
├── src/
│   ├── server.js                 服务入口：配置校验 → 启动 → 优雅关闭
│   ├── app.js                    Express 应用装配（与 server 分离便于测试）
│   ├── config/index.js           集中配置 + 启动期校验 + URL 构建
│   ├── storage/
│   │   ├── index.js              驱动统一出口（切换后端不改业务代码）
│   │   ├── github.js             GitHub Contents API 驱动（生产）
│   │   └── local.js              本地磁盘驱动（调试 / CI）
│   ├── services/upload.js        上传核心：校验 → 命名 → 去重 → 落盘 → 生成链接
│   ├── middleware/
│   │   ├── auth.js               Bearer Token 鉴权（timingSafeEqual）
│   │   ├── anti-hotlink.js       Referer / Origin 防盗链
│   │   ├── upload.js             multer 配置（内存存储、尺寸与数量限制）
│   │   ├── request-log.js        请求日志（不记录请求头，避免泄露 Token）
│   │   └── error.js              统一错误处理
│   ├── routes/
│   │   ├── upload.js             上传接口（含 base64 与远程 URL 通道）
│   │   ├── images.js             图片访问与代理、防盗链校验
│   │   └── system.js             健康检查、配置自检、文件列表
│   └── utils/
│       ├── file-type.js          文件头嗅探、SVG 危险内容检测
│       ├── naming.js             内容寻址命名策略
│       ├── url-sign.js           签名 URL 生成与校验
│       ├── errors.js             统一错误类型
│       └── logger.js             结构化日志
├── scripts/
│   ├── init-repo.js              仓库初始化与配置自检
│   └── upload-cli.js             命令行上传工具
├── test/
│   ├── smoke.js                  端到端冒烟（35 项断言）
│   ├── auth.test.js              鉴权与防盗链（16 项断言）
│   └── url-sign.test.js          签名 URL（10 项断言）
├── deploy/
│   ├── ecosystem.config.cjs      PM2 集群配置
│   └── nginx/imagebed.conf       Nginx 反向代理 + 防盗链 + 限流
├── docs/
│   ├── DEPLOYMENT.md             完整部署步骤清单
│   ├── TROUBLESHOOTING.md        故障排查手册
│   └── ARTICLE-COMPARISON.md     与原文章方案的差异说明
├── Dockerfile
├── docker-compose.yml
├── .env.example
└── package.json
```

---

## 环境变量说明

完整清单见 [`.env.example`](.env.example)，以下是核心项：

### 存储与仓库

| 变量 | 默认值 | 说明 |
|---|---|---|
| `STORAGE_DRIVER` | `github` | `github`（生产）/ `local`（调试） |
| `GITHUB_TOKEN` | — | **必填**，具备仓库 `Contents: Read and write` 权限的 PAT |
| `GITHUB_OWNER` | — | **必填**，用户名或组织名 |
| `GITHUB_REPO` | — | **必填**，仓库名 |
| `GITHUB_BRANCH` | `main` | 分支名，需与仓库实际分支一致 |
| `GITHUB_PATH_PREFIX` | `img` | 图片在仓库中的根目录（对应 PicGo「存储路径」） |

### CDN

| 变量 | 默认值 | 说明 |
|---|---|---|
| `CDN_BASE_URL` | — | **必填**，形如 `https://cdn.jsdelivr.net/gh/<owner>/<repo>@<branch>` |
| `CDN_MIRRORS` | jsdmirror, fastly | 镜像源，逗号分隔，按序回退 |
| `CDN_CUSTOM_DOMAIN` | 空 | 自有域名，填写后覆盖 `CDN_BASE_URL` |

### 上传限制

| 变量 | 默认值 | 说明 |
|---|---|---|
| `MAX_FILE_SIZE` | `5242880`（5MB） | 单文件上限。jsDelivr 单文件硬限 20MB |
| `MAX_FILES` | `10` | 单请求文件数上限 |
| `ALLOW_SVG` | `false` | SVG 可内联脚本，默认禁止 |
| `NAMING_STRATEGY` | `hash` | `hash`（内容寻址）/ `original` / `timestamp` |

### 鉴权与防盗链

| 变量 | 默认值 | 说明 |
|---|---|---|
| `REQUIRE_AUTH` | `true` | 是否强制上传鉴权 |
| `UPLOAD_TOKENS` | — | **必填**（`REQUIRE_AUTH=true` 时），逗号分隔支持多 Token |
| `ACCESS_MODE` | `proxy` | `proxy` / `redirect` / `public`，见下节 |
| `REQUIRE_SIGNED_URL` | `false` | 图片访问是否需要签名参数 |
| `URL_SIGNING_SECRET` | — | `REQUIRE_SIGNED_URL=true` 时**必填** |
| `ALLOWED_REFERERS` | 空 | Referer 白名单，支持 `*.example.com` |
| `ALLOWED_ORIGINS` | 空 | Origin 白名单 |

> **密钥安全**：`.env` 已在 `.gitignore` 中。所有敏感项均为占位符，无任何真实凭证。
> 生产环境建议用部署平台的密钥管理注入，而非把 `.env` 打进镜像。

---

## API 接口

### 上传

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/api/v1/upload` | multipart/form-data，字段名 `file` / `image` / `files` / `upload` |
| `POST` | `/api/v1/upload/base64` | JSON：`{ filename, dataBase64 }` |
| `POST` | `/api/v1/url` | JSON：`{ url }`，需 `ENABLE_URL_FETCH=true` |

```bash
# multipart（单文件，响应直接含 url 字段，便于 Typora/PicGo 解析）
curl -X POST http://127.0.0.1:3000/api/v1/upload \
  -H "Authorization: Bearer $TOKEN" \
  -F "file=@photo.jpg"

# 批量：字段名重复即可
curl -X POST http://127.0.0.1:3000/api/v1/upload \
  -H "Authorization: Bearer $TOKEN" \
  -F "file=@1.png" -F "file=@2.png"

# base64
curl -X POST http://127.0.0.1:3000/api/v1/upload/base64 \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"filename":"a.png","dataBase64":"iVBORw0KGgo..."}'
```

**上传响应字段**

| 字段 | 说明 |
|---|---|
| `url` | 主访问地址（CDN） |
| `fallbackUrls` | 备用地址数组，含镜像源，按顺序回退 |
| `path` | 仓库内相对路径 |
| `hash` | 内容哈希（SHA-256 前 32 位） |
| `deduped` | `true` 表示命中去重，未重复写入 |
| `mime` / `size` / `sizeText` | 嗅探出的真实类型与体积 |
| `rawUrl` | GitHub 原始地址，排障用 |
| `signedUrl` | 仅在 `REQUIRE_SIGNED_URL=true` 时返回 |

### 访问与运维

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/i/<path>` | 图片访问（代理 / 跳转），受防盗链与签名保护 |
| `GET` | `/api/v1/image/<path>/url` | 查询该图片的全部可用访问地址 |
| `GET` | `/health` | 存活探针（不依赖外部服务） |
| `GET` | `/api/v1/health/ready` | 就绪探针（含存储连通性） |
| `GET` | `/api/v1/config` | 配置自检（**不回显任何密钥明文**） |
| `GET` | `/api/v1/files?dir=img/2026` | 列出已上传文件 |

---

## 三种访问模式

`ACCESS_MODE` 决定图片怎么被访问，直接影响防盗链能否生效：

| 模式 | 行为 | 防盗链 | 流量成本 | 适用 |
|---|---|---|---|---|
| `proxy` | 本服务回源转发图片字节 | ✅ 真正生效 | 走自己服务器 | 自用、需要防盗链 |
| `redirect` | 302 跳转到 CDN | ⚠️ 跳转前可校验 | 免费 | 想保留 CDN 速度 |
| `public` | 直接返回 CDN 链接 | ❌ 无法生效 | 免费 | 公开图床 |

> **必须理解的一点**：只要图片链接是 `cdn.jsdelivr.net/...` 形式的**直链**，
> 任何人都能直接引用，防盗链无从谈起 —— 请求根本不经过你的服务器。
> 防盗链只在 `proxy` 模式下有效。若需要真正的强约束，
> 请改用对象存储私有读 + 签名 URL（COS / OSS / S3）。
> 详见 [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) 的「合规提示」。

---

## 与 PicGo / Typora 配合

本服务与文章方案的 PicGo 可以**并存**，两者写入同一个仓库、共享同一套 CDN 地址：

- **PicGo（GUI）**：按原文章配置 GitHub 图床即可，继续管理你日常的图床操作
- **本服务（API）**：用于脚本、自动化、CI、以及需要防盗链/鉴权的场景

若想让 PicGo 直接调用本服务，可用 PicGo 的自定义图床插件指向 `POST /api/v1/upload`。

**Typora** 配置（图床工具 → 自定义命令）：

```bash
curl -X POST http://127.0.0.1:3000/api/v1/upload \
  -H "Authorization: Bearer <你的 Token>" \
  -F "file=@<path>"
```

---

## 本地调试

```bash
# 无需 GitHub Token，用本地磁盘驱动跑通全链路
STORAGE_DRIVER=local REQUIRE_AUTH=false npm start

# 或者用 CLI 工具（可指向任意环境）
UPLOAD_TOKEN=xxx IMAGEBED_URL=https://img.example.com \
  node scripts/upload-cli.js ./photo.jpg

# 跑测试（61 项断言，无需网络）
npm test
```

单独运行某个测试：

```bash
npm run test:smoke   # 端到端冒烟
npm run test:auth    # 鉴权与防盗链
npm run test:sign    # 签名 URL
```

---

## 线上部署

三种方式，按场景选择：

| 方式 | 适用 | 文档 |
|---|---|---|
| **Docker Compose** | 快速上线，推荐 | [DEPLOYMENT.md](docs/DEPLOYMENT.md#方式一docker-compose) |
| **PM2** | 已有服务器，直接进程托管 | [DEPLOYMENT.md](docs/DEPLOYMENT.md#方式二pm2) |
| **云平台** | Railway / Fly.io / K8s | [DEPLOYMENT.md](docs/DEPLOYMENT.md#方式三云平台) |

完整步骤清单、反向代理配置、TLS、部署后验证清单见 **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)**。

---

## 常见故障排查

按现象速查，完整手册见 **[docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)**。

| 现象 | 首要检查 |
|---|---|
| 上传 401/403 | `UPLOAD_TOKENS` 是否配置，请求头是否为 `Authorization: Bearer <token>` |
| 上传 404 | `GITHUB_BRANCH` 是否与仓库实际分支一致（main vs master） |
| 上传 502 | Token 权限、仓库名拼写、网络能否访问 `api.github.com` |
| 上传 415 | 文件不是真实图片；伪装扩展名会被文件头嗅探拦截 |
| 返回 403 `HOTLINK_BLOCKED` | Referer 不在 `ALLOWED_REFERERS` 白名单 |
| 新图访问 404 | jsDelivr 同步延迟，等 10~60 秒 |
| 限流不准 / 全算一个 IP | `TRUST_PROXY_HOPS` 未设置，Nginx 后未正确传递客户端 IP |
| 大文件 413 | Nginx `client_max_body_size` 小于应用 `MAX_FILE_SIZE` |
| 全部请求被限流 | `X-Forwarded-For` 未透传，检查 `proxy_set_header` |

**最快的自检方式**：

```bash
curl http://127.0.0.1:3000/api/v1/config
```

该接口会报告配置是否完整、校验有哪些错误、当前各开关状态，**且不会泄露任何密钥明文**。

---

## ⚠️ 合规提示

jsDelivr 官方服务条款（Terms of Use）在 **Prohibited Use** 中明确写道：

> *"Abusing the Service and its resources or using jsDelivr CDN as a general-purpose
> file or media hosting service. This includes... running an image hosting website
> and using jsDelivr CDN as a storage for all uploaded images."*

即：**把 jsDelivr 当作纯图床存储，属于官方条款禁止的用法**，可能导致仓库被 CDN 屏蔽。

同时 jsDelivr 也有明确的软性限制：

| 项目 | 限制 |
|---|---|
| 单文件大小 | 20MB（GitHub 代理） |
| 单包/仓库大小 | 150MB |
| 单仓库活跃文件数 | 建议 ≤ 10,000，软上限 100,000 |

**因此：**

- ✅ **适合**：个人自用、自建博客配图、静态站点资源、学习与实验
- ❌ **不适合**：公开图床服务、商业图床、需要 SLA 保证的对外服务

**要做生产级图床，请用对象存储**（腾讯云 COS / 阿里云 OSS / AWS S3）私有读 + 签名 URL：
成本可控（几毛钱/月）、有 SLA、防盗链与访问控制是一等公民、没有第三方条款风险。
本项目的存储层是**可插拔**的 —— 迁移只需新增一个 driver，无需改动业务代码。

`npm run init:repo` 会在仓库中写入 `.nojekyll` 与 `README.md`，
使仓库更像一个正经开源项目而非纯存储桶，这也是 jsDelivr 官方推荐的良好实践。

---

## License

MIT