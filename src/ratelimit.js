'use strict';
/**
 * 内存限流器（防暴力登录 / 防留言刷屏）
 * ---------------------------------------------------------------
 * 刻意不引入 express-rate-limit：
 *  - 单进程、单实例场景下，一个 Map 就够
 *  - 有上限与自动过期清理，不会成为内存泄漏点
 */

const MAX_KEYS = 5000; // 超过则强制清理最旧记录，防止被海量 IP 撑爆内存
const buckets = new Map(); // key -> { count, resetAt, blockedUntil }

/** 顺手清理过期项；返回当前是否被拉黑 */
function prune(now) {
  if (buckets.size <= MAX_KEYS) return;
  for (const [k, v] of buckets) {
    if ((v.blockedUntil || 0) < now && v.resetAt < now) buckets.delete(k);
    if (buckets.size <= MAX_KEYS) break;
  }
}

/**
 * 记一次访问
 * @param {string} key 维度键，例如 `login:1.2.3.4`
 * @param {{max:number, windowMs:number, blockMs?:number}} opts
 * @returns {{allowed:boolean, retryAfter:number, remaining:number}}
 */
function consume(key, opts) {
  const now = Date.now();
  const { max, windowMs, blockMs = 0 } = opts;
  let b = buckets.get(key);

  if (b && b.blockedUntil && b.blockedUntil > now) {
    return { allowed: false, retryAfter: Math.ceil((b.blockedUntil - now) / 1000), remaining: 0 };
  }

  if (!b || b.resetAt <= now) {
    b = { count: 0, resetAt: now + windowMs, blockedUntil: 0 };
    buckets.set(key, b);
  }

  b.count += 1;
  prune(now);

  if (b.count > max) {
    if (blockMs > 0) b.blockedUntil = now + blockMs;
    return {
      allowed: false,
      retryAfter: Math.ceil(((blockMs > 0 ? b.blockedUntil : b.resetAt) - now) / 1000),
      remaining: 0,
    };
  }
  return { allowed: true, retryAfter: 0, remaining: max - b.count };
}

/** 成功后清空计数（例如登录成功） */
function reset(key) {
  buckets.delete(key);
}

/** 调试/运维用：当前跟踪的键数量 */
function size() {
  return buckets.size;
}

/**
 * Express 中间件工厂
 * @param {(req)=>string} keyFn 生成维度键
 */
function limiter(keyFn, opts) {
  return function (req, res, next) {
    const key = keyFn(req);
    const r = consume(key, opts);
    if (!r.allowed) {
      res.setHeader('Retry-After', String(r.retryAfter));
      return res.status(429).json({
        error: `请求过于频繁，请 ${r.retryAfter} 秒后再试`,
        retryAfter: r.retryAfter,
      });
    }
    next();
  };
}

/** 取真实访客 IP（trust proxy 打开时 req.ip 已是真实 IP） */
function clientIp(req) {
  return (req.ip || req.connection?.remoteAddress || 'unknown').replace(/^::ffff:/, '');
}

// 定时清理，防止长期运行时 Map 里堆积死键（unref 保证不阻止进程退出）
const timer = setInterval(() => {
  const now = Date.now();
  for (const [k, v] of buckets) {
    if ((v.blockedUntil || 0) < now && v.resetAt < now) buckets.delete(k);
  }
}, 10 * 60 * 1000);
if (timer.unref) timer.unref();

module.exports = { consume, reset, size, limiter, clientIp };
