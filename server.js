'use strict';
/**
 * litesite 服务入口
 * ---------------------------------------------------------------
 * 设计目标：2 核 1G VPS 上常驻内存 < 100MB。
 *  1. 只用 Express + better-sqlite3（同步、零连接池、无后台线程）
 *  2. 没有 session 中间件、没有 ORM、没有模板引擎
 *  3. 静态文件在 Nginx 层直接托管，Node 只处理 /api/*
 *  4. body 体积、上传体积、DB 页缓存全部设上限
 */

// 尽量早地加载 .env，保证 config 读到的是最新值
require('dotenv').config();

const path = require('node:path');
const fs = require('node:fs');
const express = require('express');

const config = require('./src/config');
const db = require('./src/db');
const github = require('./src/github');
const { securityHeaders } = require('./src/security');
const publicRoutes = require('./src/routes/public');
const adminRoutes = require('./src/routes/admin');

const app = express();

// ---------------------------------------------------------------
// 0. 基础加固
// ---------------------------------------------------------------
// 不暴露 Express 版本号
app.disable('x-powered-by');
// 生产环境关闭 etag 计算，省一点 CPU（静态文件由 Nginx 处理缓存）
app.set('etag', config.env === 'production' ? false : 'weak');
// Nginx 反代场景下拿到真实 IP（限流依赖它）
app.set('trust proxy', config.trustProxy);

// ---------------------------------------------------------------
// 1. 全局中间件（顺序即优先级）
// ---------------------------------------------------------------
app.use(securityHeaders);

// 请求体解析：体积上限很小，防止大 body 撑爆内存
app.use(express.json({ limit: config.bodyLimit }));
app.use(express.urlencoded({ extended: false, limit: config.bodyLimit }));

// ---------------------------------------------------------------
// 2. 路由
// ---------------------------------------------------------------
app.use('/api', publicRoutes);
app.use('/api/admin', adminRoutes);

// 健康检查（PM2 / 监控脚本用）
app.get('/api/health', (req, res) => {
  const mem = process.memoryUsage();
  res.json({
    ok: true,
    uptime: Math.round(process.uptime()),
    rssMB: +(mem.rss / 1048576).toFixed(1),
    heapMB: +(mem.heapUsed / 1048576).toFixed(1),
    // 作品集数据源状态：source=github 时能看到抓取条数与失败原因，
    // 方便直接在浏览器里排查，不必登录服务器看日志
    portfolio: github.stats(),
  });
});

// ---------------------------------------------------------------
// 3. 静态资源
//    开发环境由 Node 直接托管，方便本地调试；
//    生产环境请在 Nginx 里配置 root，并把 STATIC_VIA_NODE 设为 false，
//    这样 Node 完全不碰静态文件，内存与 CPU 都更省。
// ---------------------------------------------------------------
if (config.serveStatic) {
  const staticOpts = {
    maxAge: config.env === 'production' ? '7d' : 0,
    etag: config.env !== 'production',
    // 只做一层缓存，避免 dotfiles 泄漏
    dotfiles: 'ignore',
  };
  app.use(express.static(config.paths.publicDir, staticOpts));
}

// 管理后台入口：/admin 与 /admin/ 都返回同一个轻量页面
app.get(['/admin', '/admin/'], (req, res) => {
  res.sendFile(path.join(config.paths.publicDir, 'admin.html'));
});

// 博客文章直达链接（前端 SPA 路由用 hash，这里给个兜底）
app.get('/blog/:slug', (req, res) => {
  res.sendFile(path.join(config.paths.publicDir, 'index.html'));
});

// ---------------------------------------------------------------
// 4. 404 / 错误处理
// ---------------------------------------------------------------
app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: '接口不存在' });
  }
  res.status(404).sendFile(path.join(config.paths.publicDir, '404.html'));
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  // 请求体超限等客户端错误不打完整堆栈，避免日志刷爆磁盘
  const status = err.status || err.statusCode || 500;
  if (status >= 500) {
    console.error('[error]', req.method, req.originalUrl, err.message);
  }
  res.status(status).json({
    error: status >= 500 ? '服务器内部错误' : err.message || '请求无效',
  });
});

// ---------------------------------------------------------------
// 5. 启动
// ---------------------------------------------------------------
const server = app.listen(config.port, config.host, () => {
  const mem = process.memoryUsage();
  console.log(
    `[litesite] ${config.site.title} 已启动 → http://${config.host}:${config.port} ` +
      `(env=${config.env}, rss=${(mem.rss / 1048576).toFixed(1)}MB)`
  );
  // 启动时预热一次作品集数据（GitHub 抓取），让第一位访客就能看到内容。
  // 不 await：抓取失败也不影响服务启动，前端有骨架屏与手动数据兜底。
  github.warmup();
});

// keep-alive 缩短一点，减少空闲连接占用的内存
server.keepAliveTimeout = 30000;
server.headersTimeout = 35000;

// ---------------------------------------------------------------
// 6. 优雅退出：让 PM2 restart 不留僵尸连接与 WAL 残留
// ---------------------------------------------------------------
let closing = false;
function shutdown(signal) {
  if (closing) return;
  closing = true;
  console.log(`[litesite] 收到 ${signal}，正在优雅退出...`);
  server.close(() => {
    try {
      db.close();
    } catch (_) {
      /* ignore */
    }
    process.exit(0);
  });
  // 兜底：3 秒内没关完就强退
  setTimeout(() => process.exit(0), 3000).unref();
}
['SIGINT', 'SIGTERM'].forEach((sig) => process.on(sig, () => shutdown(sig)));

// 兜底异常，避免进程静默死掉（PM2 会负责重启）
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason && reason.message ? reason.message : reason);
});

// 目录自检：确保 data / uploads 存在
[config.paths.data, config.paths.uploads].forEach((dir) => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

module.exports = app;
