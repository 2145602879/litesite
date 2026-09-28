'use strict';
/**
 * 安全响应头
 * 手写替代 helmet（helmet 本身不大，但多一个依赖就多一份内存与维护成本）。
 */
const config = require('./config');

// CSP 需要放行：
//  - cdn.tailwindcss.com  Tailwind Play CDN
//  - cdn.jsdelivr.net      marked / DOMPurify
//  - fonts.googleapis/gstatic 网页字体
// Tailwind CDN 会注入 <style>，所以 style-src 必须带 'unsafe-inline'
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://cdn.tailwindcss.com https://cdn.jsdelivr.net",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  "img-src 'self' data: blob: https:",
  "connect-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "object-src 'none'",
].join('; ');

function securityHeaders(req, res, next) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  // API 与后台不允许被搜索引擎收录（前台页面保持可收录）
  if (req.path.startsWith('/api/') || req.path.startsWith('/admin')) {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  }
  if (config.isProd && config.security.cookieSecure) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
}

module.exports = { securityHeaders };
