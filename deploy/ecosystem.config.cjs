/**
 * PM2 进程配置。
 *
 * 用法：
 *   pm2 start deploy/ecosystem.config.cjs --env production
 *   pm2 logs imagebed
 *   pm2 reload imagebed      # 零停机重载
 *
 * cluster 模式开多进程：上传是IO 密集（等GitHub API 响应），
 * 单进程在并发上传时会成为瓶颈。
 */

module.exports = {
  apps: [
    {
      name: 'imagebed',
      script: 'src/server.js',
      cwd: __dirname,

      // 实例数按 CPU 核数，容器里通常是 1~2
      instances: process.env.PM2_INSTANCES || 2,
      exec_mode: 'cluster',

      // 内存超限自动重启，避免内存泄漏拖垮整机
      max_memory_restart: '400M',

      env: {
        NODE_ENV: 'development',
        PORT: 3000,
        LOG_LEVEL: 'debug',
      },
      env_production: {
        NODE_ENV: 'production',
        PORT: 3000,
        LOG_LEVEL: 'info',
        TRUST_PROXY_HOPS: 1,
      },

      // 日志按天切割，保留 7 天
      time: true,
      merge_logs: true,
      out_file: 'logs/out.log',
      error_file: 'logs/error.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      max_log_size: '10MB',
      retain: 7,

      // 优雅退出，给足上传请求完成的时间
      kill_timeout: 12000,
      listen_timeout: 10000,
      wait_ready: false,
    },
  ],
};