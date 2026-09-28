'use strict';
/**
 * 管理后台 API（/api/admin/*）
 * ---------------------------------------------------------------
 * 安全策略：
 *  - /login 与 /password 走独立的内存限流（防爆破）
 *  - 登录后统一由 auth.requireAuth 网关保护
 *  - 所有写操作都先做字段收敛与长度限制，再入库
 */
const express = require('express');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const db = require('../db');
const U = require('../util');
const config = require('../config');
const auth = require('../auth');
const limit = require('../ratelimit');

const router = express.Router();

// ==================================================================
// 一、登录 / 登出（无需鉴权，但严格限流）
// ==================================================================
const loginLimiter = limit.limiter((req) => `login:${limit.clientIp(req)}`, {
  max: config.security.loginMaxAttempts,
  windowMs: config.security.loginWindowMs,
  blockMs: config.security.loginBlockMs,
});

router.post('/login', loginLimiter, (req, res) => {
  const username = U.str(req.body?.username, 60);
  const password = String(req.body?.password ?? '');
  if (!username || !password) {
    return res.status(400).json({ error: '请输入账号与密码' });
  }

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  // 用户不存在时也跑一次 bcrypt，避免通过响应时间探测账号是否存在
  const hash = user ? user.password_hash : '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinv';
  const ok = bcrypt.compareSync(password.slice(0, 200), hash);

  if (!user || !ok) {
    return res.status(401).json({ error: '账号或密码错误' });
  }

  db.prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?").run(user.id);
  limit.reset(`login:${limit.clientIp(req)}`);

  auth.setSessionCookie(res, auth.issueToken(user), config.security.sessionTtlMs);
  res.json({ ok: true, username: user.username });
});

router.post('/logout', (req, res) => {
  auth.clearSessionCookie(res);
  res.json({ ok: true });
});

// ==================================================================
// 二、以下所有接口都需要登录
// ==================================================================
router.use(auth.requireAuth);

router.get('/session', (req, res) => {
  const u = db.prepare('SELECT username, last_login_at FROM users WHERE id = ?').get(req.user.id);
  res.json({
    username: u.username,
    lastLoginAt: U.toIso(u.last_login_at),
    secretIsEphemeral: config.security.sessionSecretIsEphemeral,
  });
});

// ---------------------- 站点统计 ----------------------
router.get('/stats', (req, res) => {
  const one = (sql) => db.prepare(sql).get().c;
  const mem = process.memoryUsage();
  res.json({
    projects: one('SELECT COUNT(*) AS c FROM projects'),
    posts: one('SELECT COUNT(*) AS c FROM posts'),
    drafts: one('SELECT COUNT(*) AS c FROM posts WHERE published = 0'),
    messages: one('SELECT COUNT(*) AS c FROM messages'),
    skills: one('SELECT COUNT(*) AS c FROM skills'),
    uptime: Math.round(process.uptime()),
    rssMB: +(mem.rss / 1048576).toFixed(1),
  });
});

// ==================================================================
// 三、主页基础信息
// ==================================================================
router.get('/profile', (req, res) => {
  const p = db.prepare('SELECT * FROM profile WHERE id = 1').get() || {};
  res.json({ profile: { ...p, updated_at: U.toIso(p.updated_at) } });
});

router.put('/profile', (req, res) => {
  const b = req.body || {};
  db.prepare(
    `UPDATE profile SET
       name = @name, role = @role, tagline = @tagline, avatar = @avatar,
       bio = @bio, location = @location, email = @email, website = @website,
       github = @github, twitter = @twitter, weibo = @weibo, wechat = @wechat,
       updated_at = datetime('now')
     WHERE id = 1`
  ).run({
    name: U.str(b.name, 60),
    role: U.str(b.role, 80),
    tagline: U.str(b.tagline, 160),
    avatar: U.url(b.avatar, 500),
    bio: U.str(b.bio, 1200),
    location: U.str(b.location, 80),
    email: U.str(b.email, 120),
    website: U.url(b.website, 200),
    github: U.url(b.github, 200),
    twitter: U.url(b.twitter, 200),
    weibo: U.url(b.weibo, 200),
    wechat: U.str(b.wechat, 60),
  });
  res.json({ ok: true });
});

// ==================================================================
// 四、技能标签
// ==================================================================
router.get('/skills', (req, res) => {
  res.json({ items: db.prepare('SELECT * FROM skills ORDER BY category, sort, id').all() });
});

router.post('/skills', (req, res) => {
  const b = req.body || {};
  const name = U.str(b.name, 40);
  if (!name) return res.status(400).json({ error: '技能名称不能为空' });
  const info = db
    .prepare('INSERT INTO skills (name, category, level, sort) VALUES (?, ?, ?, ?)')
    .run(name, U.str(b.category, 20) || '通用', U.int(b.level, 3, 1, 5), U.int(b.sort, 0, 0, 9999));
  res.status(201).json({ ok: true, id: info.lastInsertRowid });
});

router.put('/skills/:id', (req, res) => {
  const b = req.body || {};
  const id = U.int(req.params.id, 0, 1);
  const info = db
    .prepare('UPDATE skills SET name = ?, category = ?, level = ?, sort = ? WHERE id = ?')
    .run(
      U.str(b.name, 40) || '未命名',
      U.str(b.category, 20) || '通用',
      U.int(b.level, 3, 1, 5),
      U.int(b.sort, 0, 0, 9999),
      id
    );
  if (!info.changes) return res.status(404).json({ error: '记录不存在' });
  res.json({ ok: true });
});

router.delete('/skills/:id', (req, res) => {
  const info = db.prepare('DELETE FROM skills WHERE id = ?').run(U.int(req.params.id, 0, 1));
  res.json({ ok: true, deleted: info.changes });
});

// ==================================================================
// 五、作品集 + 图片上传
// ==================================================================
const EXT_BY_MIME = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/svg+xml': '.svg',
};

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, config.paths.uploads),
  filename: (req, file, cb) => {
    // 随机文件名，避免中文名 / 路径穿越 / 覆盖已有文件
    const ext = EXT_BY_MIME[file.mimetype] || '.bin';
    cb(null, `${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: config.upload.maxBytes, files: 1 },
  fileFilter: (req, file, cb) => {
    if (config.upload.mimeWhitelist.includes(file.mimetype)) return cb(null, true);
    cb(new Error('只允许上传 jpg / png / webp / gif / svg 图片'));
  },
});

/** 包一层 multer，把它的错误转成统一的 JSON 响应 */
function uploadOne(req, res, next) {
  upload.single('file')(req, res, (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE' ? '图片太大，请压缩后再上传（上限见 .env）' : err.message;
      return res.status(400).json({ error: msg });
    }
    next();
  });
}

router.post('/upload', uploadOne, (req, res) => {
  if (!req.file) return res.status(400).json({ error: '没有收到文件' });
  res.status(201).json({
    ok: true,
    url: `/uploads/${req.file.filename}`,
    sizeKB: +(req.file.size / 1024).toFixed(1),
  });
});

/** 删除上传文件（只允许删除 uploads 目录下、符合命名规则的图片） */
router.delete('/uploads/:name', (req, res) => {
  const name = U.str(req.params.name, 120);
  if (!/^[a-z0-9]+-[a-f0-9]{8}\.(jpg|jpeg|png|webp|gif|svg)$/i.test(name)) {
    return res.status(400).json({ error: '文件名不合法' });
  }
  const file = path.join(config.paths.uploads, name);
  // 二次确认路径没有跳出上传目录
  if (path.dirname(path.resolve(file)) !== path.resolve(config.paths.uploads)) {
    return res.status(400).json({ error: '路径不合法' });
  }
  fs.promises
    .unlink(file)
    .then(() => res.json({ ok: true }))
    .catch(() => res.status(404).json({ error: '文件不存在' }));
});

router.get('/projects', (req, res) => {
  res.json({ items: db.prepare('SELECT * FROM projects ORDER BY sort, id DESC').all() });
});

function projectPayload(b) {
  return {
    title: U.str(b.title, 100) || '未命名作品',
    description: U.str(b.description, 1000),
    image: U.url(b.image, 500),
    link: U.url(b.link, 500),
    tags: U.splitTags(b.tags, 8).join(','),
    featured: b.featured ? 1 : 0,
    sort: U.int(b.sort, 0, 0, 9999),
  };
}

router.post('/projects', (req, res) => {
  const p = projectPayload(req.body || {});
  const info = db
    .prepare(
      `INSERT INTO projects (title, description, image, link, tags, featured, sort)
       VALUES (@title, @description, @image, @link, @tags, @featured, @sort)`
    )
    .run(p);
  res.status(201).json({ ok: true, id: info.lastInsertRowid });
});

router.put('/projects/:id', (req, res) => {
  const p = projectPayload(req.body || {});
  p.id = U.int(req.params.id, 0, 1);
  const info = db
    .prepare(
      `UPDATE projects SET title = @title, description = @description, image = @image,
        link = @link, tags = @tags, featured = @featured, sort = @sort WHERE id = @id`
    )
    .run(p);
  if (!info.changes) return res.status(404).json({ error: '作品不存在' });
  res.json({ ok: true });
});

router.delete('/projects/:id', (req, res) => {
  const info = db.prepare('DELETE FROM projects WHERE id = ?').run(U.int(req.params.id, 0, 1));
  res.json({ ok: true, deleted: info.changes });
});

// ==================================================================
// 六、博客文章（Markdown 原文入库，渲染交给前端）
// ==================================================================
const postStmts = {
  list: db.prepare(
    `SELECT id, title, slug, summary, tags, published, views, created_at, updated_at
       FROM posts ORDER BY created_at DESC LIMIT ? OFFSET ?`
  ),
  count: db.prepare('SELECT COUNT(*) AS c FROM posts'),
  byId: db.prepare('SELECT * FROM posts WHERE id = ?'),
  slugExists: db.prepare('SELECT id FROM posts WHERE slug = ? AND id <> ?'),
  insert: db.prepare(
    `INSERT INTO posts (title, slug, summary, content, tags, published)
     VALUES (@title, @slug, @summary, @content, @tags, @published)`
  ),
  update: db.prepare(
    `UPDATE posts SET title = @title, slug = @slug, summary = @summary, content = @content,
       tags = @tags, published = @published, updated_at = datetime('now') WHERE id = @id`
  ),
  remove: db.prepare('DELETE FROM posts WHERE id = ?'),
};

/** slug 唯一化：重名时追加 -2 / -3 … */
function uniqueSlug(base, currentId = 0) {
  let slug = base || `post-${Date.now().toString(36)}`;
  let n = 1;
  while (postStmts.slugExists.get(slug, currentId)) {
    n += 1;
    slug = `${base}-${n}`;
  }
  return slug;
}

function postPayload(b, currentId = 0) {
  const content = U.str(b.content, 200000); // Markdown 原文，200KB 上限已经非常宽松
  const title = U.str(b.title, 120) || '未命名文章';
  return {
    title,
    slug: uniqueSlug(U.slugify(U.str(b.slug, 80) || title), currentId),
    summary: U.str(b.summary, 300) || U.excerpt(content, 140),
    content,
    tags: U.splitTags(b.tags, 8).join(','),
    published: b.published === false || b.published === 0 || b.published === '0' ? 0 : 1,
  };
}

router.get('/posts', (req, res) => {
  const take = U.int(req.query.limit, 20, 1, 100);
  const skip = U.int(req.query.offset, 0, 0, 100000);
  res.json({
    total: postStmts.count.get().c,
    items: postStmts.list.all(take, skip).map((p) => ({
      ...p,
      created_at: U.toIso(p.created_at),
      updated_at: U.toIso(p.updated_at),
    })),
  });
});

router.get('/posts/:id', (req, res) => {
  const p = postStmts.byId.get(U.int(req.params.id, 0, 1));
  if (!p) return res.status(404).json({ error: '文章不存在' });
  res.json({ post: { ...p, created_at: U.toIso(p.created_at), updated_at: U.toIso(p.updated_at) } });
});

router.post('/posts', (req, res) => {
  const p = postPayload(req.body || {});
  const info = postStmts.insert.run(p);
  res.status(201).json({ ok: true, id: info.lastInsertRowid, slug: p.slug });
});

router.put('/posts/:id', (req, res) => {
  const id = U.int(req.params.id, 0, 1);
  if (!postStmts.byId.get(id)) return res.status(404).json({ error: '文章不存在' });
  const p = postPayload(req.body || {}, id);
  p.id = id;
  postStmts.update.run(p);
  res.json({ ok: true, slug: p.slug });
});

router.delete('/posts/:id', (req, res) => {
  const info = postStmts.remove.run(U.int(req.params.id, 0, 1));
  res.json({ ok: true, deleted: info.changes });
});

// ==================================================================
// 七、留言管理
// ==================================================================
router.get('/messages', (req, res) => {
  const take = U.int(req.query.limit, 50, 1, 200);
  const skip = U.int(req.query.offset, 0, 0, 100000);
  const items = db
    .prepare(
      `SELECT id, name, email, content, ip, approved, created_at
         FROM messages ORDER BY created_at DESC LIMIT ? OFFSET ?`
    )
    .all(take, skip)
    .map((m) => ({ ...m, created_at: U.toIso(m.created_at) }));
  res.json({ total: db.prepare('SELECT COUNT(*) AS c FROM messages').get().c, items });
});

/** 切换显示 / 隐藏 */
router.patch('/messages/:id', (req, res) => {
  const approved = req.body?.approved ? 1 : 0;
  const info = db
    .prepare('UPDATE messages SET approved = ? WHERE id = ?')
    .run(approved, U.int(req.params.id, 0, 1));
  if (!info.changes) return res.status(404).json({ error: '留言不存在' });
  res.json({ ok: true, approved });
});

router.delete('/messages/:id', (req, res) => {
  const info = db.prepare('DELETE FROM messages WHERE id = ?').run(U.int(req.params.id, 0, 1));
  res.json({ ok: true, deleted: info.changes });
});

// ==================================================================
// 八、修改登录密码
// 改完密码后，旧会话自动失效（token 里带了密码哈希前缀）
// ==================================================================
const pwdLimiter = limit.limiter((req) => `pwd:${limit.clientIp(req)}`, {
  max: 10,
  windowMs: 15 * 60 * 1000,
  blockMs: 15 * 60 * 1000,
});

router.post('/password', pwdLimiter, (req, res) => {
  const current = String(req.body?.currentPassword ?? '');
  const next = String(req.body?.newPassword ?? '');

  if (next.length < 8) return res.status(400).json({ error: '新密码至少 8 位' });
  if (next.length > 128) return res.status(400).json({ error: '新密码过长' });
  if (!/[a-zA-Z]/.test(next) || !/[0-9]/.test(next)) {
    return res.status(400).json({ error: '新密码需同时包含字母和数字' });
  }

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!bcrypt.compareSync(current, user.password_hash)) {
    return res.status(401).json({ error: '当前密码不正确' });
  }

  const hash = bcrypt.hashSync(next, 10);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, user.id);
  auth.clearSessionCookie(res); // 强制重新登录
  res.json({ ok: true, message: '密码已更新，请用新密码重新登录' });
});

module.exports = router;
