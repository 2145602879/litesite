'use strict';
/**
 * 轻量鉴权
 * ---------------------------------------------------------------
 * 不引入 express-session / jsonwebtoken / cookie-parser：
 *  - 会话 = HMAC-SHA256 签名的无状态 token，放在 httpOnly Cookie 里
 *  - 服务端零存储，进程重启/内存回收不影响已登录用户（SESSION_SECRET 不变即可）
 *  - token 中带 v 字段（密码哈希前缀），改密码后所有旧会话自动失效
 */
const crypto = require('node:crypto');
const config = require('./config');
const db = require('./db');

const { cookieName, sessionSecret, sessionTtlMs } = {
  cookieName: config.security.cookieName,
  sessionSecret: config.security.sessionSecret,
  sessionTtlMs: config.security.sessionTtlMs,
};

// ---------------------------------------------------------------
// token 签名 / 校验
// ---------------------------------------------------------------
function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function sign(payload) {
  const body = b64url(JSON.stringify(payload));
  const mac = b64url(crypto.createHmac('sha256', sessionSecret).update(body).digest());
  return `${body}.${mac}`;
}

/** 校验签名 + 过期时间，失败返回 null */
function verify(token) {
  if (typeof token !== 'string' || token.length > 1024) return null;
  const idx = token.lastIndexOf('.');
  if (idx <= 0) return null;
  const body = token.slice(0, idx);
  const mac = token.slice(idx + 1);

  const expected = b64url(crypto.createHmac('sha256', sessionSecret).update(body).digest());
  // 定长比较，避免时序侧信道
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  let payload;
  try {
    payload = JSON.parse(Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
  } catch (_) {
    return null;
  }
  if (!payload || typeof payload.exp !== 'number' || payload.exp < Date.now()) return null;
  return payload;
}

// ---------------------------------------------------------------
// Cookie 读写（手写，省掉 cookie-parser 依赖）
// ---------------------------------------------------------------
function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    out[k] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function setSessionCookie(res, token, maxAgeMs) {
  const bits = [
    `${cookieName}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
  ];
  if (config.security.cookieSecure) bits.push('Secure');
  res.append('Set-Cookie', bits.join('; '));
}

function clearSessionCookie(res) {
  const bits = [`${cookieName}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (config.security.cookieSecure) bits.push('Secure');
  res.append('Set-Cookie', bits.join('; '));
}

// ---------------------------------------------------------------
// 会话版本：密码一变，v 变化，旧 token 全部作废
// ---------------------------------------------------------------
function currentUser() {
  return db.prepare('SELECT id, username, password_hash FROM users ORDER BY id LIMIT 1').get();
}

function sessionVersion(user) {
  return crypto.createHash('sha256').update(user.password_hash).digest('hex').slice(0, 16);
}

/** 登录成功后签发 token */
function issueToken(user) {
  return sign({
    uid: user.id,
    u: user.username,
    v: sessionVersion(user),
    exp: Date.now() + sessionTtlMs,
  });
}

/** 读取并校验当前请求的登录态，返回 {user} 或 null */
function readSession(req) {
  const token = parseCookies(req.headers.cookie)[cookieName];
  const payload = verify(token);
  if (!payload) return null;
  const user = currentUser();
  if (!user || user.id !== payload.uid) return null;
  if (sessionVersion(user) !== payload.v) return null; // 密码已修改
  return { user, exp: payload.exp };
}

/** 需要登录的接口中间件 */
function requireAuth(req, res, next) {
  const session = readSession(req);
  if (!session) {
    return res.status(401).json({ error: '未登录或会话已过期' });
  }
  req.user = session.user;
  next();
}

module.exports = {
  parseCookies,
  setSessionCookie,
  clearSessionCookie,
  issueToken,
  readSession,
  requireAuth,
  currentUser,
};
