# 部署步骤清单

本文档给出从零到上线的完整步骤。三种部署方式任选其一，**配置与验证部分通用**。

---

## 目录

- [阶段 0：前置准备](#阶段-0前置准备)
- [阶段 1：GitHub 仓库准备](#阶段-1github-仓库准备)
- [阶段 2：本地配置](#阶段-2本地配置)
- [方式一：Docker Compose](#方式一docker-compose)
- [方式二：PM2](#方式二pm2)
- [方式三：云平台](#方式三云平台)
- [阶段 3：域名与反向代理](#阶段-3域名与反向代理)
- [阶段 4：部署后验证清单](#阶段-4部署后验证清单)
- [合规提示](#合规提示)

---

## 阶段 0：前置准备

| 项目 | 要求 |
|---|---|
| Node.js | ≥ 18.17，推荐 20 / 22 LTS |
| GitHub 账号 | 一个公开仓库 |
| 服务器 | 1 核 1G 即可（proxy 模式下带宽是主要成本） |
| 域名 | 可选。用于防盗链与 HTTPS，建议配 |

**服务器规格参考**：`proxy` 模式下所有图片流量都走你的服务器。
个人博客日均 1 万次图片请求、每张 200KB ≈ 2GB/天 ≈ 60GB/月，
1M 带宽（≈ 每月 300GB 理论值）完全够用。

---

## 阶段 1：GitHub 仓库准备

### 1.1 创建公开仓库

新建一个仓库（建议命名如 `my-images`）。

> ⚠️ **必须是公开仓库**。jsDelivr 无法访问私有仓库，
> `npm run init:repo` 会检测到并直接报错退出。

### 1.2 生成 Token

**推荐：Fine-grained token（细粒度，权限最小）**

1. GitHub → 头像 → **Settings** → 左侧最下方 **Developer settings**
2. **Personal access tokens** → **Fine-grained tokens** → **Generate new token**
3. 填写：
   - Token name：`imagebed`
   - Expiration：建议 90 天（到期需重新生成，或改用 1 年）
   - **Repository access**：`Only select repositories` → 选择你的图片仓库
   - **Repository permissions** → **Contents**：`Read and write`
4. 生成后**立即复制**，离开页面就看不到了

**不推荐：Classic token** —— 权限是账号级的，`repo` 一勾就是所有仓库的读写权限。
Classic token 的 `repo` 作用域与本项目需求完全够用，但风险面大得多。

> 如果用 Classic token，勾选 `repo` 即可；但请务必清楚它等价于账号的全部仓库写权限。

### 1.3 记录仓库信息

| 项 | 值 | 从哪看 |
|---|---|---|
| owner | 你的用户名 | 仓库地址 `github.com/<owner>/<repo>` |
| repo | 仓库名 | 同上 |
| branch | `main` 或 `master` | 仓库页面上方分支下拉框 |

> 老仓库默认分支是 `master`，GitHub 2020 年后的新仓库是 `main`。
> **填错会导致上传返回 404**，这是最常见的配置错误之一。

---

## 阶段 2：本地配置

```bash
git clone <你的 repo>
cd imagebed
npm install

cp .env.example .env
```

编辑 `.env`，**至少填写这 5 项**：

```bash
GITHUB_TOKEN=ghp_xxxxxxxxxxxx
GITHUB_OWNER=your-username
GITHUB_REPO=my-images
GITHUB_BRANCH=main
CDN_BASE_URL=https://cdn.jsdelivr.net/gh/your-username/my-images@main

# 生成一个高强度 Token：openssl rand -hex 32
UPLOAD_TOKENS=<粘贴生成的随机串>
```

### 配置自检

```bash
npm run init:repo
```

这个命令会验证：

- ✅ `.env` 必填项是否齐全
- ✅ Token 能否访问目标仓库
- ✅ Token 是否有写权限
- ✅ 仓库是否为公开（私有直接报错）
- ✅ 分支配置是否与仓库一致
- ✅ 创建 `.nojekyll` 与 `README.md`
- ✅ 预创建当月目录

**期望输出**：

```
图床服务 · 仓库初始化与配置自检
────────────────────────────────────────────────────

[1/4] 检查配置
✓ 仓库目标：your-username/my-images @ main
✓ 存储路径：img/<yyyy>/<mm>/

[2/4] 校验 Token 与仓库访问
✓ 仓库可达：your-username/my-images
  可见性：公开
✓ Token 具备写权限

[3/4] 初始化仓库辅助文件
✓ 已创建 .nojekyll — 禁用 Jekyll 处理
✓ 已创建 README.md — 仓库说明

[4/4] 预创建当月目录
✓ 已创建当月目录占位文件

────────────────────────────────────────────────────
初始化完成
```

---

## 方式一：Docker Compose

**推荐**，环境隔离最干净。

### 1. 准备环境变量文件

```bash
cp .env.example .env
# 编辑 .env，至少填写：
#   GITHUB_TOKEN / GITHUB_OWNER / GITHUB_REPO / CDN_BASE_URL / UPLOAD_TOKENS
```

> `docker-compose.yml` 通过 `${VAR}` 从 `.env` 读取变量，
> 并对必填项做了 `:?` 校验 —— 缺失时容器会直接报错而不是静默启动失败。

### 2. 构建与启动

```bash
docker compose build
docker compose up -d
docker compose logs -f imagebed
```

### 3. 验证

```bash
curl http://127.0.0.1:3000/health
curl http://127.0.0.1:3000/api/v1/health/ready
```

### 4. 常用运维命令

```bash
docker compose ps                    # 查看状态
docker compose logs -f --tail=100    # 跟踪日志
docker compose restart imagebed      # 重启
docker compose down                  # 停止
docker compose up -d --build         # 改完代码重新构建
```

> **compose 已做的安全处理**：
> - 端口只绑定 `127.0.0.1:3000`，不直接对外，必须经 Nginx 暴露
> - 容器内以非 root 用户（uid 1001）运行
> - 镜像含 `dumb-init`，保证 SIGTERM 能到达 Node 触发优雅关闭
> - 内置 `HEALTHCHECK`

---

## 方式二：PM2

适合已有服务器、不想引入 Docker 的场景。

### 1. 安装并启动

```bash
npm install --omit=dev

pm2 start deploy/ecosystem.config.cjs --env production
pm2 save                    # 保存进程列表
pm2 startup                 # 注册开机自启（按提示执行它输出的命令）
```

### 2. 管理

```bash
pm2 status                   # 查看所有进程
pm2 logs imagebed            # 实时日志
pm2 logs imagebed --lines 200
pm2 reload imagebed          # 零停机重载（优于 restart）
pm2 monit                    # CPU / 内存监控
```

### 3. 日志

配置已按天切割、单文件 10MB、保留 7 天，路径为 `logs/`。

```bash
tail -f logs/out.log
```

---

## 方式三：云平台

以 Railway / Fly.io / Heroku / K8s 为例，核心都是**注入环境变量**而非打包 `.env`。

### 必须注入的变量

```
NODE_ENV=production
PORT=<平台分配或自定义>
STORAGE_DRIVER=github
GITHUB_TOKEN=<PAT>
GITHUB_OWNER=<owner>
GITHUB_REPO=<repo>
GITHUB_BRANCH=main
CDN_BASE_URL=https://cdn.jsdelivr.net/gh/<owner>/<repo>@main
UPLOAD_TOKENS=<随机串>
REQUIRE_AUTH=true
ACCESS_MODE=proxy
TRUST_PROXY_HOPS=1
```

### 注意事项

| 项目 | 说明 |
|---|---|
| **端口** | 平台通过 `PORT` 注入，服务需监听 `$PORT`（本项目已支持） |
| **健康检查** | 存活探针配 `/health`（不依赖 GitHub，避免外部抖动导致误杀容器） |
| **密钥存储** | 用平台的 Secret 功能，**不要**写进部署配置或镜像 |
| **本地状态** | 本项目无状态（`github` 驱动），可随意扩缩容 |
| **冷启动** | 首次上传要连 GitHub API，冷启动稍慢；`pm2`/Docker 均已配 `start-period` |

### Fly.io 示例

```bash
fly launch --no-deploy
fly secrets set GITHUB_TOKEN=<PAT> UPLOAD_TOKENS=<random>
fly deploy
```

---

## 阶段 3：域名与反向代理

### 1. 解析域名

```
img.example.com  →  服务器公网 IP
```

### 2. 安装证书

```bash
apt install certbot python3-certbot-nginx
certbot --nginx -d img.example.com
```

### 3. 配置 Nginx

```bash
cp deploy/nginx/imagebed.conf /etc/nginx/sites-available/imagebed.conf
vim /etc/nginx/sites-available/imagebed.conf   # 改 server_name 与证书路径
ln -s /etc/nginx/sites-available/imagebed.conf /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
```

`deploy/nginx/imagebed.conf` 已包含：

- HTTP → HTTPS 跳转
- TLS 配置与安全响应头（HSTS / nosniff / Referrer-Policy）
- `client_max_body_size`（**必须 ≥ `MAX_FILE_SIZE`**）
- `/api/v1/upload` 独立限流区
- `/i/` 路径的 `valid_referers` 防盗链 + 长缓存
- `X-Forwarded-*` 头透传（**不配会导致限流把所有请求算作一个 IP**）

### 4. 在 nginx.conf 的 http 块中添加限流区

限流区**必须**定义在 `http` 块，不能写在站点配置里：

```nginx
http {
    # ...
    limit_req_zone $binary_remote_addr zone=upload:10m rate=30r/m;
}
```

### 5. 同步应用层配置

Nginx 与应用层都要配，且保持一致：

```bash
# 应用层防盗链（.env）
ALLOWED_REFERERS=example.com,*.example.com
ALLOW_EMPTY_REFERER=false

# 应用层代理设置
TRUST_PROXY_HOPS=1     # Nginx 在一层
```

---

## 阶段 4：部署后验证清单

逐项执行，全部通过才算部署完成。

### 4.1 服务存活

```bash
curl -s https://img.example.com/health
# 期望：{"ok":true,"status":"alive",...}
```

### 4.2 存储就绪

```bash
curl -s https://img.example.com/api/v1/health/ready
# 期望：{"ok":true,"status":"ready","driver":"github",...}
# 若为 503，说明 GitHub 侧配置有问题，看 message 字段
```

### 4.3 配置自检

```bash
curl -s https://img.example.com/api/v1/config
```

**重点检查**：

- `validationErrors` 应为空数组
- `storage.github.tokenConfigured` 为 `true`
- `security.requireAuth` 为 `true`
- `security.antiHotlink.enabled` 为 `true`（若你配了防盗链）

> 该接口不会返回任何密钥明文，可安全用于排查。

### 4.4 鉴权生效

```bash
# 不带 Token —— 应返回 401
curl -s -X POST https://img.example.com/api/v1/upload -F "file=@test.png"

# 错误 Token —— 应返回 403
curl -s -X POST https://img.example.com/api/v1/upload \
  -H "Authorization: Bearer wrong" -F "file=@test.png"
```

### 4.5 正常上传

```bash
curl -s -X POST https://img.example.com/api/v1/upload \
  -H "Authorization: Bearer <真实Token>" \
  -F "file=@./test.png"
# 期望：HTTP 201 + 含 url / path / hash 字段
```

### 4.6 防盗链生效

```bash
# 伪造外站 Referer 访问图片 —— 应返回 403
curl -s -o /dev/null -w "%{http_code}\n" \
  -H "Referer: https://evil.com" \
  https://img.example.com/i/img/2026/10/xxxxx.png

# 合法 Referer —— 应返回 200
curl -s -o /dev/null -w "%{http_code}\n" \
  -H "Referer: https://example.com/post" \
  https://img.example.com/i/img/2026/10/xxxxx.png
```

### 4.7 CDN 链路

上传后等 10~60 秒（jsDelivr 同步延迟），然后：

```bash
# 主源
curl -s -o /dev/null -w "%{http_code}\n" "https://cdn.jsdelivr.net/gh/<owner>/<repo>@main/<path>"

# 镜像源（备用）
curl -s -o /dev/null -w "%{http_code}\n" "https://cdn.jsdmirror.com/gh/<owner>/<repo>@main/<path>"
```

### 4.8 重启存活

```bash
docker compose restart imagebed    # 或 pm2 reload imagebed
sleep 5
curl -s https://img.example.com/health    # 应仍然正常
```

验证优雅关闭生效：重启过程中正在进行的请求不应被强行中断。

### 4.9 开机自启（PM2 / systemd 场景）

```bash
sudo reboot
# 重启后
curl -s https://img.example.com/health    # 应正常
```

---

## 合规提示

**jsDelivr 官方服务条款明确禁止**把 CDN 当作通用图床存储：

> *"Abusing the Service and its resources or using jsDelivr CDN as a general-purpose
> file or media hosting service. This includes... running an image hosting website
> and using jsDelivr CDN as a storage for all uploaded images."*
> —— [jsDelivr Terms of Use](https://www.jsdelivr.com/terms)

同时存在明确的容量限制：

| 项目 | 限制 |
|---|---|
| 单文件 | 20MB（GitHub 代理） |
| 单包 / 仓库 | 150MB |
| 单仓库活跃文件数 | 建议 ≤ 10,000（软上限 100,000） |

### 使用边界

| 场景 | 是否合适 |
|---|---|
| 个人自用图床 | ✅ 合适 |
| 自建博客配图 | ✅ 合适 |
| 学习 / 实验 | ✅ 合适 |
| 公开图床服务 | ❌ 违反 jsDelivr 条款 |
| 商业图床 / 需要 SLA | ❌ 无保障 |

### 生产级替代方案

要做真正的生产图床，请用对象存储**私有读 + 签名 URL**：

| 方案 | 说明 |
|---|---|
| 腾讯云 COS | 境内访问快，与微信生态契合好 |
| 阿里云 OSS | 同上 |
| AWS S3 / CloudFront | 海外为主 |

**迁移成本很低** —— 本项目的存储层是可插拔的：

```
src/storage/
├── index.js    ← 驱动出口（已抽象好）
├── github.js   ← 当前实现
└── oss.js      ← 新增一个即可，30~50 行
```

业务层（路由、中间件、上传服务）完全不感知底层是 GitHub 还是 OSS。
详见 `src/storage/index.js` 的驱动接口约定。

---

## 相关文档

- [README.md](../README.md) — 快速开始与 API 说明
- [TROUBLESHOOTING.md](TROUBLESHOOTING.md) — 故障排查手册
- [ARTICLE-COMPARISON.md](ARTICLE-COMPARISON.md) — 与原文章方案的差异说明