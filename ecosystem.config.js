/**
 * PM2 进程配置（针对 2 核 1G VPS 优化）
 * ---------------------------------------------------------------
 * 关键点：
 *  1. exec_mode: fork + instances: 1
 *     不用 cluster。cluster 模式的每个 worker 都会复制一份运行时，
 *     1G 内存的机器上纯属浪费；个人站也完全不需要多进程。
 *  2. node_args: --max-old-space-size=96
 *     给 V8 堆设硬上限。达到上限会触发 GC 而不是把系统内存吃光，
 *     这是防止整台机器被拖死的第一道闸。
 *  3. max_memory_restart: '150M'
 *     第二道闸。RSS 超过 150MB 就自动重启，比被内核 OOM Killer
 *     杀掉（还可能牵连 Nginx / SSH）体面得多。
 *  4. env 里的 PM2 变量与 .env 是两层配置：
 *     PM2 负责进程级参数，业务配置仍然读项目根目录的 .env。
 *
 * 常用命令：
 *   pm2 start ecosystem.config.js     # 启动
 *   pm2 reload litesite               # 平滑重启
 *   pm2 logs litesite --lines 100     # 看日志
 *   pm2 monit                         # 实时看 CPU / 内存
 *   pm2 save                          # 保存进程列表，配合 pm2 startup 开机自启
 */
module.exports = {
  apps: [
    {
      name: 'litesite',
      script: 'server.js',

      // 用 __dirname 而不是相对路径，避免从别处调用 pm2 时 cwd 不对
      cwd: __dirname,

      // -------- 进程模型：单进程、fork，最省内存 --------
      instances: 1,
      exec_mode: 'fork',

      // -------- 内存护栏 --------
      node_args: '--max-old-space-size=96',
      max_memory_restart: '150M',

      // -------- 崩溃自愈 --------
      autorestart: true,
      max_restarts: 10, // 60 秒内超过 10 次就停止重启，避免无限重启刷爆日志
      min_uptime: '20s',
      restart_delay: 3000,

      // -------- 优雅退出（配合 server.js 里的 SIGTERM 处理）--------
      kill_timeout: 6000,
      listen_timeout: 8000,

      // -------- 日志 --------
      // 注意：PM2 默认不切割日志，请务必安装轮转模块：
      //   pm2 install pm2-logrotate
      //   pm2 set pm2-logrotate:max_size 10M
      //   pm2 set pm2-logrotate:retain 7
      error_file: './logs/err.log',
      out_file: './logs/out.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      time: false, // 已由 log_date_format 处理，避免重复时间戳

      // -------- 环境变量（业务配置仍以 .env 为准）--------
      env: {
        NODE_ENV: 'production',
        HOST: '127.0.0.1',
        PORT: 3000,
        TRUST_PROXY: 'true',
        SERVE_STATIC: 'false', // 静态资源交给 Nginx，Node 只管 API
      },

      // -------- 不监听文件变化（生产环境不要开，会白吃 CPU）--------
      watch: false,
    },
  ],
};
