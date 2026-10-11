# 与原文章方案的差异说明

参考文章：《[利用 github+jsDelivr 搭建图床](https://cloud.tencent.com/developer/article/1858753)》
（科技怪物君，2021-08-10）

本文说明本项目**保留了什么、改动了什么、为什么改**。

---

## 摘要

| 维度 | 原文章 | 本项目 | 改动理由 |
|---|---|---|---|
| 存储 | GitHub 仓库 | **同** | 这是方案的核心，保留 |
| CDN | jsDelivr | **同**（+ 镜像回退） | 保留，但补国内链路不稳的兜底 |
| 上传 | PicGo GUI 客户端 | **服务端 API** | GUI 无法用于脚本/CI，且无鉴权能力 |
| 命名 | PicGo 默认（时间戳） | **内容寻址（SHA-256）** | 时间戳命名导致 CDN 缓存命中率极低 |
| 鉴权 | 无 | **Bearer Token + 签名 URL** | 原方案任何人都能往你的仓库传图 |
| 防盗链 | 无 | **Referer/Origin 白名单** | 原方案的 CDN 直链无法防盗链 |
| 格式校验 | 无 | **文件头嗅探** | 原方案无任何校验 |
| 限流 | 无 | **应用层 + Nginx** | 防止刷爆 GitHub API 配额 |
| 部署 | 无（纯客户端） | **Docker / PM2 / 云平台** | 可上线的服务需要部署方案 |

**核心思路零改动** —— GitHub 仓库当存储、jsDelivr 做分发，
这一点与文章完全一致，只是把「手动操作」工程化、把「能用」升级为「可控」。

---

## 一、保留原方案的部分

### 1.1 存储：GitHub 仓库即存储

文章的思路是新建一个仓库专门存图片。本项目延续该设计，
通过 GitHub Contents API 写入：

```
PUT https://api.github.com/repos/{owner}/{repo}/contents/{path}
{
  "message": "chore: upload img/2026/10/xxx.png by imagebed",
  "content": "<base64>",
  "branch": "main"
}
```

**为什么不用 git commit API**：Contents API 单次请求完成写入，
无需本地克隆、无需 git 环境、无需处理 merge 与冲突。适合服务端场景。

### 1.2 分发：jsDelivr CDN

地址格式与文章完全一致：

```
https://cdn.jsdelivr.net/gh/<owner>/<repo>@<branch>/<path>
```

### 1.3 `img/` 存储路径

对应 PicGo 的「存储路径」配置项，本项目为 `GITHUB_PATH_PREFIX`，默认 `img`。

---

## 二、改动及理由

### 改动 1：PicGo 客户端 → 服务端 API

**原文方案**：下载 PicGo 桌面客户端，在 GUI 里填 GitHub Token，然后拖拽上传。

**本项目**：提供 HTTP 上传 API。

**理由**：

1. **GUI 无法自动化**。写博客时手动拖拽还行，但要接 CI、自动备份、
   批量迁移、程序化生成配图，GUI 完全做不到。
2. **没有鉴权机制**。PicGo 把 Token 存在本地配置文件里，
   服务端没有任何身份认证 —— 谁都能往你的仓库传图，
   塞满仓库或塞入违规内容，你只能自己去清理。
3. **无法做限流与校验**。客户端直连 GitHub API，服务端形同虚设。
4. **依赖桌面环境**。服务器、容器、CI 环境里没有 GUI。

**兼容性**：本项目**不排斥 PicGo**。两者写入同一个仓库、共享同一套 CDN 地址，
可以并存使用。日常操作用 PicGo，需要自动化时用 API。

---

### 改动 2：文件名改为内容寻址（SHA-256）

**原文方案**：PicGo 默认按 `时间戳_原文件名` 命名。

**本项目**：`img/<yyyy>/<mm>/<sha256前32位>.<ext>`

**理由 —— 这是最重要的改动**：

内容寻址对 CDN 缓存命中率的影响是决定性的。

| 维度 | 时间戳命名 | 内容寻址 |
|---|---|---|
| 同一张图重复上传 | 产生新文件、新 URL | **同一个 URL** |
| CDN 缓存 | 每次都是新 URL，边缘节点必须回源 | 命中已有缓存，**永不过期** |
| 内容变更 | URL 变（合理） | URL 变（合理） |
| 存储 | 重复占用空间 | **自动去重** |
| 可缓存性 | `Cache-Control` 只能短缓存 | 可以 `immutable` 长缓存 |

举例：一张 logo 被 20 篇文章引用。

- **时间戳命名**：如果 logo 换了，又要在 20 处重新上传，
  产生 20 个新 URL，20 个缓存条目，20 次回源。
- **内容寻址**：logo 内容不变就还是同一个 URL，边缘节点直接命中，
  缓存命中率接近 100%。logo 变了，URL 自动变，**旧 URL 依然可用**
  （因为它指向的历史 commit 还在），不会出现「改图后旧文章全挂」。

配套的还有**按年月分片目录**，避免单目录累积上万文件
导致 GitHub 页面渲染和克隆变慢。

> 也可以通过 `NAMING_STRATEGY=original` 保留可读原名（会追加哈希后缀防重名）。
> 但默认推荐 `hash`。

---

### 改动 3：增加上传鉴权

**原文方案**：无。任何人都能用你的仓库 Token 上传（前提是拿到 Token，
但 PicGo 把 Token 明文存在客户端配置文件里）。

**本项目**：

- `UPLOAD_TOKENS` 支持多个 Token，便于多端隔离与轮换
- 支持三种传递方式：`Authorization: Bearer`、`X-Upload-Token`、`X-API-Key`
- 用 `timingSafeEqual` 做定长比较，防时序侧信道攻击
- `REQUIRE_AUTH=true` 且未配置 Token 时，**服务拒绝启动**

**理由**：图床是写操作。Token 泄露等于仓库被任意篡改。
生产环境必须有鉴权。

---

### 改动 4：增加文件类型校验（文件头嗅探）

**原文方案**：无任何校验，PicGo 靠扩展名判断。

**本项目**：

1. 读文件头（magic number）判定真实类型 —— PNG 看 `89 50 4E 47`，
   JPEG 看 `FF D8 FF`，以此类推
2. 校验通过后才用扩展名命名
3. SVG 默认禁用（可内联 `<script>`）
4. 开启 SVG 时做深度检测：拦截 `<script>`、内联事件、
   `javascript:`、`<foreignObject>`、DOCTYPE ENTITY

**理由**：**扩展名和 Content-Type 都可以随意伪造**。

把 `shell.php` 改名成 `photo.png`，声明 `Content-Type: image/png`，
基于扩展名的校验就会放行。只有嗅探真实字节才能挡住。

测试用例（`test/smoke.js` 已覆盖）：

```js
// 伪装成 PNG 的 PHP 代码 → 415 拦截
form.append('file', new Blob([Buffer.from('<?php system($_GET["c"]); ?>')],
                            { type: 'image/png' }), 'evil.png');

// 含脚本的 SVG → 403 拦截
form.append('file', new Blob([Buffer.from('<svg><script>alert(1)</script></svg>')],
                            { type: 'image/svg+xml' }), 'evil.svg');
```

---

### 改动 5：增加防盗链

**原文方案**：无。

**本项目**：`ALLOWED_REFERERS` / `ALLOWED_ORIGINS` 白名单，
支持 `*.example.com` 子域通配，应用层与 Nginx 层双重校验。

**必须说清楚的限制**：

防盗链**只在 `ACCESS_MODE=proxy` 时有效**。

```
✅ https://你的域名/i/img/a.png
   → 请求经过你的服务器 → Referer 校验生效

❌ https://cdn.jsdelivr.net/gh/owner/repo@main/img/a.png
   → 直连 jsDelivr → 你的服务器完全不知情 → 防盗链无效
```

**原因**：防盗链的本质是「服务器检查请求来源」。
请求不经过你的服务器，就无从检查。

这也是为什么本项目提供三种访问模式，以及为什么 `proxy` 是默认值 ——
它是唯一能真正落实访问控制的模式。

---

### 改动 6：增加三种访问模式

| 模式 | 说明 |
|---|---|
| `proxy`（默认） | 服务回源转发图片字节。防盗链与鉴权真正生效 |
| `redirect` | 302 跳到 CDN。跳转前可校验，但用户能看到真实域名 |
| `public` | 直接返回 CDN 链接，最快但零控制 |

**理由**：不同场景对「速度」「成本」「控制力」的取舍不同。
给出选择权，而不是一刀切。

---

### 改动 7：增加限流

**原文方案**：无。

**本项目**：应用层 `express-rate-limit` + Nginx `limit_req` 双重限流。

**理由**：上传会消耗 GitHub API 配额（认证请求 5000 次/小时）。
无限制的刷接口可能导致仓库被写入大量垃圾文件，
也可能耗尽配额导致正常上传失败。

---

### 改动 8：增加 CDN 镜像回退

**原文方案**：只有 `cdn.jsdelivr.net` 一个源。

**本项目**：上传响应返回 `fallbackUrls` 数组，含多个镜像。

**理由**：jsDelivr 在国内链路质量不稳定是长期问题。
单源方案意味着「jsDelivr 抽风 = 全站图片挂掉」。
返回多个源让客户端能自动降级。

**实现细节**：镜像地址需要 `<owner>/<repo>@<branch>`，
项目会从 `CDN_BASE_URL` 解析（也可从 GitHub 配置项直接读），
这样只填了 `CDN_BASE_URL` 没填 `GITHUB_OWNER` 时镜像地址依然能正确生成。

---

### 改动 9：增加 SSRF 防护

**原文方案**：无。

**本项目**：`/api/v1/url` 远程转存接口**默认关闭**，
开启后强制 http/https 协议，并阻断：

- 回环地址（`127.0.0.1`、`::1`、`localhost`）
- 私有网段（`10.x`、`172.16-31.x`、`192.168.x`）
- 云元数据地址（`169.254.169.254`）
- 内部域名（`.internal`、`.localhost`）

**理由**：这是典型的 SSRF 攻击面。
攻击者可用你的服务器探测内网服务、访问云平台元数据接口窃取凭证。
默认关闭是负责任的设计 —— 需要的人显式开启。

---

### 改动 10：增加签名 URL

**原文方案**：无。

**本项目**：`REQUIRE_SIGNED_URL=true` 后，图片访问需带
`?e=<过期时间>&s=<HMAC签名>`，签名绑定完整路径并可设有效期。

**理由**：作为「jsDelivr 直链无法防盗链」问题的过渡方案。
配合 `proxy` 模式可以做到「链接有时效，过期即失效」。

**坦率说明局限**：签名只能保护走本服务的那条路径。
一旦 CDN 直链泄露，签名形同虚设。**真正的解决方案是换私有桶对象存储。**

---

### 改动 11：增加可插拔存储层

**原文方案**：写死 GitHub。

**本项目**：`src/storage/` 下实现驱动接口，
`STORAGE_DRIVER` 环境变量切换。

**理由**：jsDelivr 官方条款禁止把 CDN 当通用图床存储（见下节），
用户迟早需要迁走。存储层抽象让迁移成本降到「新增一个 30~50 行的文件」，
业务代码零改动。

同时 `local` 驱动让**无 Token、无网络**也能跑通全链路，
对本地开发和 CI 测试价值很大。

---

### 改动 12：工程化与运维

原文方案没有部署相关内容。本项目补充：

| 能力 | 说明 |
|---|---|
| Docker 多阶段构建 | 运行镜像不含编译工具链，非 root 运行 |
| `dumb-init` | 保证 SIGTERM 传递，优雅关闭不丢请求 |
| PM2 集群配置 | 上传是 IO 密集，多进程提升并发 |
| 健康检查 | 存活探针（不依赖外部）+ 就绪探针（查存储） |
| 配置自检接口 | `/api/v1/config`，报告配置完整性且**不回显密钥** |
| 结构化日志 | 生产输出 JSON；**不记录请求头**，避免 Token 落日志 |
| 测试 | 61 项断言，覆盖上传/去重/鉴权/防盗链/签名/路径穿越/伪装文件 |

---

## 三、必须提醒的合规问题

这是原文章（2021 年发布）没有提到、但现在必须面对的问题。

### jsDelivr 官方条款明确禁止图床用法

摘自 [jsDelivr Terms of Use](https://www.jsdelivr.com/terms)：

> **6. Prohibited Use (jsDelivr CDN)**
>
> *"Abusing the Service and its resources or using jsDelivr CDN as a
> general-purpose file or media hosting service. This includes, for example,
> in the case of jsDelivr CDN: **running an image hosting website and using
> jsDelivr CDN as a storage for all uploaded images**, hosting videos, file
> backups, or other files in large quantities."*

**明确点名**「running an image hosting website」和
「using jsDelivr CDN as a storage for all uploaded images」属于禁止用法。

条款还写明可自行终止服务：

> *"We may suspend or withdraw our site... where your use of the Website and
> jsDelivr CDN violates or breaches this Terms."*

### 容量限制

| 项目 | 限制 |
|---|---|
| 单文件大小 | 20MB（GitHub 代理） |
| 单包 / 仓库 | 150MB |
| 单仓库活跃文件数 | 建议 ≤ 10,000，软上限 100,000 |

> ⚠️ 注意「150MB」这个数远低于 GitHub 自身的 1GB 仓库建议上限。
> 如果你的图床仓库超过 150MB，jsDelivr 可能停止分发，**所有图片一起失效**。

### 结论

| 场景 | 是否合适 |
|---|---|
| 个人自用、自建博客配图、学习实验 | ✅ 合适 |
| 公开图床服务、商业图床、需要 SLA | ❌ 不合适 |

**要做生产级图床，请用对象存储**（腾讯云 COS / 阿里云 OSS / AWS S3）
私有读 + 签名 URL。成本可控、有 SLA、防盗链是一等公民、无第三方条款风险。

本项目的存储层抽象就是为这一步准备的 —— 迁移只需新增一个 driver。

### 降低风险的做法

`npm run init:repo` 会在仓库中创建 `.nojekyll` 与 `README.md`，
让仓库更像一个正经开源项目而非纯存储桶。

jsDelivr 官方在条款中确实认可这类做法：

> *"We recognize that there are legitimate projects that consist of a large
> number of files... For example: icons packs, apps, or games with a large
> number of assets."*

以及推荐实践：*"has a meaningful name, has public documentation and an
appropriate license"*。

这不能改变条款的定性，但能让仓库不至于被当成纯粹的存储桶。

---

## 四、如果只用原文章方案

原文章方案本身是**可以用的**，三步就能跑起来：

1. 新建一个**公开** GitHub 仓库
2. 下载安装 PicGo → 图床设置 → GitHub → 填仓库名、分支、Token、存储路径、自定义域名
3. 自定义域名填 `https://cdn.jsdelivr.net/gh/<用户名>/<仓库名>@master`

**必须注意**：

- 仓库必须公开（jsDelivr 访问不了私有仓库）
- 分支是 `master` 还是 `main` 要看仓库实际分支
- Token 会明文存在 PicGo 配置文件里
- jsDelivr 国内访问不稳定，准备好镜像源
- 这是「个人自用」，不要当公共图床对外提供

**什么时候应该换成本项目**：

| 需求 | 原方案 | 本项目 |
|---|---|---|
| 手动上传几张图 | ✅ 够用 | ✅ 够用 |
| CI / 脚本自动上传 | ❌ 做不到 | ✅ HTTP API |
| 防止他人往仓库塞图 | ❌ 无鉴权 | ✅ Bearer Token |
| 防止图片被外链 | ❌ CDN 直链无法防 | ✅ proxy 模式 |
| 多用户/多环境隔离 | ❌ 单 Token | ✅ 多 Token |
| 存储可迁移 | ❌ 写死 GitHub | ✅ 可插拔驱动 |

---

## 五、总结

**本项目不是要取代原文章方案，而是把它从「个人技巧」变成「可控的服务」。**

保留的部分（GitHub 存储 + jsDelivr 分发）依然是这个方案的核心价值 ——
免费、简单、不需要服务器存储。

补上的部分（鉴权、校验、限流、防盗链、部署、测试），
是把这个方案用在线上服务时**必须补上**的东西 ——
原文章面向的是「个人手动上传几张图」，没有暴露这些需求，
但一旦要自动化、要上线，它们立刻变成刚需。

同时，通过存储层抽象，为**必须迁移到对象存储**这个终局做了平滑过渡。