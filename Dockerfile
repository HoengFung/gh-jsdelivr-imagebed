# 多阶段构建：构建阶段装依赖，运行阶段只带产物
# 目的：最终镜像不含编译工具链，体积与攻击面都更小

# ---------- 构建阶段 ----------
FROM node:22-alpine AS builder

WORKDIR /app

# 先只拷贝 package 文件，利用 Docker 层缓存：
# 只要依赖没变，重新构建就不会重跑 npm ci
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --ignore-scripts

# ---------- 运行阶段 ----------
FROM node:22-alpine AS runner

# dumb-init 负责转发信号，保证 SIGTERM 能到达 Node 进程触发优雅关闭。
# 没有它，容器停止时会直接 SIGKILL，正在上传的请求会被打断。
RUN apk add --no-cache dumb-init

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0

WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src

# 创建非 root 用户 —— 容器逃逸时降低影响面
RUN addgroup -g 1001 -S nodejs \
 && adduser -u 1001 -S nodejs -G nodejs \
 && mkdir -p /app/storage/local \
 && chown -R nodejs:nodejs /app

USER nodejs

EXPOSE 3000

# 容器健康检查：直接用内置 fetch 探测，避免额外安装 curl
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]

CMD ["node", "src/server.js"]