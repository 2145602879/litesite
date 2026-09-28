'use strict';
/**
 * 面向访客的公开 API（全部只读，除留言提交外）
 * 只返回前端真正需要的字段，减少 JSON 体积与序列化开销。
 */
const express = require('express');
const db = require('../db');
const U = require('../util');
const limit = require('../ratelimit');
const config = require('../config');

const router = express.Router();

// ---------- 预编译语句：启动时编译一次，后续调用几乎零开销 ----------
const stmts = {
  profile: db.prepare('SELECT * FROM profile WHERE id = 1'),
  skills: db.prepare('SELECT name, category, level FROM skills ORDER BY category, sort, id'),
  projects: db.prepare(
    'SELECT id, title, description, image, link, tags, featured FROM projects ORDER BY sort, id DESC'
  ),
  posts: db.prepare(
    `SELECT id, title, slug, summary, tags, views, created_at
       FROM posts WHERE published = 1
      ORDER BY created_at DESC LIMIT ? OFFSET ?`
  ),
  postCount: db.prepare('SELECT COUNT(*) AS c FROM posts WHERE published = 1'),
  postBySlug: db.prepare('SELECT * FROM posts WHERE slug = ? AND published = 1'),
  postNeighbors: db.prepare(
    `SELECT title, slug FROM posts
      WHERE published = 1 AND created_at < ?
      ORDER BY created_at DESC LIMIT 1`
  ),
  addView: db.prepare('UPDATE posts SET views = views + 1 WHERE id = ?'),
  messages: db.prepare(
    `SELECT id, name, content, created_at FROM messages
      WHERE approved = 1 ORDER BY created_at DESC LIMIT ?`
  ),
  messageCount: db.prepare('SELECT COUNT(*) AS c FROM messages WHERE approved = 1'),
  addMessage: db.prepare(
    'INSERT INTO messages (name, email, content, ip, ua) VALUES (?, ?, ?, ?, ?)'
  ),
  recentMessage: db.prepare(
    'SELECT id, name, content, created_at FROM messages WHERE ip = ? ORDER BY id DESC LIMIT 1'
  ),
};

/** 把 profile 行转成前端需要的结构（不含任何敏感字段） */
function publicProfile() {
  const p = stmts.profile.get() || {};
  return {
    name: p.name || '',
    role: p.role || '',
    tagline: p.tagline || '',
    avatar: p.avatar || '',
    bio: p.bio || '',
    location: p.location || '',
    email: p.email || '',
    website: p.website || '',
    social: {
      github: p.github || '',
      twitter: p.twitter || '',
      weibo: p.weibo || '',
      wechat: p.wechat || '',
    },
    updatedAt: U.toIso(p.updated_at),
  };
}

// ------------------------------------------------------------------
// GET /api/site  首页首屏所需的全部数据（一次请求，减少往返）
// ------------------------------------------------------------------
router.get('/site', (req, res) => {
  const skills = stmts.skills.all();
  // 按分类分组，前端直接渲染，避免在浏览器里再跑一次 groupBy
  const grouped = {};
  for (const s of skills) {
    (grouped[s.category] = grouped[s.category] || []).push(s);
  }
  res.set('Cache-Control', 'no-store');
  res.json({
    site: {
      title: config.site.title,
      description: config.site.description,
      url: config.site.url,
    },
    profile: publicProfile(),
    skills: Object.keys(grouped).map((category) => ({ category, items: grouped[category] })),
    stats: {
      projects: stmts.projects.all().length,
      posts: stmts.postCount.get().c,
      messages: stmts.messageCount.get().c,
    },
  });
});

// ------------------------------------------------------------------
// GET /api/projects
// ------------------------------------------------------------------
router.get('/projects', (req, res) => {
  const rows = stmts.projects.all();
  res.set('Cache-Control', 'public, max-age=60');
  res.json({
    items: rows.map((r) => ({
      id: r.id,
      title: r.title,
      description: r.description,
      image: r.image,
      link: r.link,
      tags: U.splitTags(r.tags),
      featured: !!r.featured,
    })),
  });
});

// ------------------------------------------------------------------
// GET /api/posts?limit=6&offset=0
// ------------------------------------------------------------------
router.get('/posts', (req, res) => {
  const take = U.int(req.query.limit, 6, 1, 20); // 单页最多 20 条，控制响应体
  const skip = U.int(req.query.offset, 0, 0, 100000);
  const rows = stmts.posts.all(take, skip);
  const total = stmts.postCount.get().c;
  res.json({
    total,
    items: rows.map((r) => ({
      id: r.id,
      title: r.title,
      slug: r.slug,
      // summary 在后台保存时已算好，列表查询不读取 content 大字段以省内存
      summary: r.summary || '',
      tags: U.splitTags(r.tags),
      views: r.views,
      createdAt: U.toIso(r.created_at),
    })),
  });
});

// ------------------------------------------------------------------
// GET /api/posts/:slug  文章详情（Markdown 原文交给前端渲染）
// ------------------------------------------------------------------
router.get('/posts/:slug', (req, res) => {
  const slug = U.str(req.params.slug, 120);
  const post = stmts.postBySlug.get(slug);
  if (!post) return res.status(404).json({ error: '文章不存在或未发布' });

  // 浏览量 +1：不做防刷，个人站流量小，够用且无额外内存
  stmts.addView.run(post.id);

  const prev = stmts.postNeighbors.get(post.created_at);
  res.json({
    post: {
      id: post.id,
      title: post.title,
      slug: post.slug,
      summary: post.summary,
      content: post.content,
      tags: U.splitTags(post.tags),
      views: post.views + 1,
      createdAt: U.toIso(post.created_at),
      updatedAt: U.toIso(post.updated_at),
    },
    next: prev ? { title: prev.title, slug: prev.slug } : null,
  });
});

// ------------------------------------------------------------------
// GET /api/messages?limit=20  留言墙
// ------------------------------------------------------------------
router.get('/messages', (req, res) => {
  const take = U.int(req.query.limit, 20, 1, 50);
  const rows = stmts.messages.all(take);
  res.json({
    total: stmts.messageCount.get().c,
    items: rows.map((r) => ({
      id: r.id,
      name: r.name,
      content: r.content,
      createdAt: U.toIso(r.created_at),
    })),
  });
});

// ------------------------------------------------------------------
// POST /api/messages  提交留言
// 限流：每个 IP 10 分钟最多 3 条；同一 IP 内容完全相同则拒绝
// ------------------------------------------------------------------
const messageLimiter = limit.limiter((req) => `msg:${limit.clientIp(req)}`, {
  max: 3,
  windowMs: 10 * 60 * 1000,
  blockMs: 30 * 60 * 1000,
});

router.post('/messages', messageLimiter, (req, res) => {
  const name = U.str(req.body?.name, 40);
  const email = U.url(req.body?.email, 120) || U.str(req.body?.email, 120);
  // 先按原始长度校验，再截断。避免超长内容被静默砍掉后仍然入库
  const rawContent = String(req.body?.content ?? '');
  if (rawContent.length > 1000) {
    return res.status(400).json({ error: '留言最多 1000 字' });
  }
  const content = U.str(rawContent, 1000);

  if (name.length < 1) return res.status(400).json({ error: '请填写称呼' });
  if (content.length < 2) return res.status(400).json({ error: '留言内容太短了' });

  const ip = limit.clientIp(req);
  const last = stmts.recentMessage.get(ip);
  if (last && last.content === content) {
    return res.status(400).json({ error: '这条留言刚刚已经提交过了' });
  }

  const info = stmts.addMessage.run(
    name,
    email,
    content,
    ip,
    U.str(req.headers['user-agent'], 200)
  );
  res.status(201).json({
    ok: true,
    item: { id: info.lastInsertRowid, name, content, createdAt: U.toIso(new Date().toISOString()) },
  });
});

module.exports = router;
