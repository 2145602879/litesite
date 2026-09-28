'use strict';
/**
 * 全局配置：集中读取 .env，并做类型转换与默认值兜底。
 * 其它模块只 require 本文件，不直接读 process.env，方便排查。
 */
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');

/** 解析布尔值 */
function bool(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

/** 解析整数 */
function int(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

/** 相对路径统一基于项目根目录解析，避免 PM2 工作目录不同导致错乱 */
function resolveDir(value, fallback) {
  const raw = value && String(value).trim() ? String(value).trim() : fallback;
  return path.isAbsolute(raw) ? raw : path.resolve(ROOT, raw);
}

const env = process.env.NODE_ENV || 'development';
const isProd = env === 'production';

// 会话密钥：生产环境缺失时给一次显式警告，并生成临时密钥
let sessionSecret = (process.env.SESSION_SECRET || '').trim();
let sessionSecretIsEphemeral = false;
if (sessionSecret.length < 16) {
  sessionSecret = crypto.randomBytes(32).toString('hex');
  sessionSecretIsEphemeral = true;
  if (isProd) {
    console.warn(
      '[config] 警告：SESSION_SECRET 未设置或过短，已生成临时密钥。' +
        '重启后所有后台登录会话将失效，请在 .env 中配置固定值。'
    );
  }
}

const config = {
  env,
  isProd,
  root: ROOT,
  port: int(process.env.PORT, 3000),
  host: process.env.HOST || '127.0.0.1',
  trustProxy: bool(process.env.TRUST_PROXY, true),
  // 生产环境默认交给 Nginx 托管静态资源；本地开发自动兜底由 Node 托管
  serveStatic: bool(process.env.SERVE_STATIC, !isProd),
  bodyLimit: process.env.BODY_LIMIT || '128kb',

  site: {
    title: process.env.SITE_TITLE || '个人主页',
    description: process.env.SITE_DESCRIPTION || '',
    url: (process.env.SITE_URL || 'http://localhost:3000').replace(/\/+$/, ''),
  },

  admin: {
    username: process.env.ADMIN_USERNAME || 'admin',
    password: process.env.ADMIN_PASSWORD || 'ChangeMe_2024',
  },

  security: {
    sessionSecret,
    sessionSecretIsEphemeral,
    cookieName: 'ls_sid',
    cookieSecure: bool(process.env.COOKIE_SECURE, isProd),
    sessionTtlMs: int(process.env.SESSION_TTL_HOURS, 168) * 3600 * 1000,
    loginMaxAttempts: int(process.env.LOGIN_MAX_ATTEMPTS, 5),
    loginWindowMs: int(process.env.LOGIN_WINDOW_MINUTES, 10) * 60 * 1000,
    loginBlockMs: int(process.env.LOGIN_BLOCK_MINUTES, 15) * 60 * 1000,
  },

  // 作品集数据源：github（抓取 GitHub 公开仓库）或 manual（后台手动录入）
  // 留空则自动判断：配了 GITHUB_USERNAME 就当作 github
  portfolio: {
    source: (process.env.PORTFOLIO_SOURCE || '').trim().toLowerCase(),
  },

  github: {
    username: (process.env.GITHUB_USERNAME || '').trim(),
    // 可选：配了令牌额度从 60/小时 提升到 5000/小时，也能读取私有仓库
    token: (process.env.GITHUB_TOKEN || '').trim(),
    // 可选：只展示这些仓库，并按此处的顺序排列（逗号分隔的仓库名）
    repos: (process.env.GITHUB_REPOS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    excludeForks: bool(process.env.GITHUB_EXCLUDE_FORKS, true),
    excludeArchived: bool(process.env.GITHUB_EXCLUDE_ARCHIVED, false),
    max: int(process.env.GITHUB_MAX, 12),
    cacheMinutes: int(process.env.GITHUB_CACHE_MINUTES, 30),
    timeoutMs: int(process.env.GITHUB_TIMEOUT_MS, 8000),
  },

  paths: {
    data: resolveDir(process.env.DATA_DIR, 'data'),
    uploads: resolveDir(process.env.UPLOAD_DIR, path.join('public', 'uploads')),
    publicDir: path.join(ROOT, 'public'),
  },

  upload: {
    maxBytes: int(process.env.UPLOAD_MAX_KB, 2048) * 1024,
    // 只允许常见图片类型，减少被塞入可执行文件的风险
    mimeWhitelist: ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/svg+xml'],
  },

  // better-sqlite3 页缓存上限（KB，负数表示 KB 单位），刻意压小以控内存
  db: {
    file: path.join(resolveDir(process.env.DATA_DIR, 'data'), 'litesite.db'),
    cacheSizeKb: int(process.env.DB_CACHE_KB, 4096),
  },
};

module.exports = config;
