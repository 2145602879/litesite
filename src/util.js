'use strict';
/**
 * 通用小工具：字符串清洗、slug 生成、字段收敛。
 * 所有入库字段都必须经过这里，避免脏数据与 XSS 源头。
 */

/** 转字符串并裁剪长度（防超长字段撑大数据库与响应体） */
function str(value, max = 500) {
  if (value === undefined || value === null) return '';
  const s = String(value).replace(/\u0000/g, '').trim();
  return s.length > max ? s.slice(0, max) : s;
}

/** 转整数并限制区间 */
function int(value, fallback = 0, min = -2147483648, max = 2147483647) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** 只允许 http/https 链接，挡住 javascript: 之类的伪协议 */
function url(value, max = 500) {
  const s = str(value, max);
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return s;
  if (s.startsWith('/')) return s; // 站内相对路径（例如 /uploads/xxx.png）
  return '';
}

/** HTML 转义（服务端拼接 HTML 的场景使用） */
function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

/**
 * 生成 URL 友好的 slug
 * 中文标题无法转 ASCII 时会返回空串，由调用方补一个随机后缀。
 */
function slugify(title) {
  return String(title)
    .toLowerCase()
    .replace(/['"’“”]/g, '')
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    // 保留中文，但把连续分隔符压成一个
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

/** 逗号 / 顿号分隔的标签 → 数组 */
function splitTags(value, max = 10) {
  return str(value, 200)
    .split(/[,，;；|]/)
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, max);
}

/** SQLite 的 datetime('now') 是 UTC 且无时区标记，补成标准 ISO 供前端解析 */
function toIso(sqliteTs) {
  if (!sqliteTs) return null;
  if (typeof sqliteTs !== 'string') return sqliteTs;
  if (sqliteTs.includes('T')) return sqliteTs.endsWith('Z') ? sqliteTs : `${sqliteTs}Z`;
  return `${sqliteTs.replace(' ', 'T')}Z`;
}

/** 摘要：没有手填 summary 时从 Markdown 正文里截一段纯文本 */
function excerpt(markdown, len = 140) {
  const text = String(markdown || '')
    .replace(/```[\s\S]*?```/g, ' ')      // 代码块
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ') // 图片
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // 链接保留文字
    .replace(/[#>*_`~\-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > len ? `${text.slice(0, len)}…` : text;
}

module.exports = { str, int, url, escapeHtml, slugify, splitTags, toIso, excerpt };
