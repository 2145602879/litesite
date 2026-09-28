'use strict';
/**
 * SQLite 数据层
 * ---------------------------------------------------------------
 * 为什么选 better-sqlite3：
 *  - 同步 API，没有连接池、没有回调队列，1 个连接常驻，内存开销极小
 *  - 原生模块，查询走 C++，比纯 JS 的 sqlite3 包更省 CPU 与内存
 *  - 单文件数据库，备份 = 复制一个文件
 *
 * 内存控制手段：
 *  - cache_size 限制页缓存（默认 4MB）
 *  - mmap_size = 0，避免把整库映射进内存
 *  - 不用 WAL 的大页缓存组合；WAL 开启但 synchronous=NORMAL
 */
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const config = require('./config');

// 确保数据目录存在
fs.mkdirSync(path.dirname(config.db.file), { recursive: true });

const db = new Database(config.db.file);

// ---------------------------------------------------------------
// PRAGMA 调优（面向低内存小机器）
// ---------------------------------------------------------------
db.pragma('journal_mode = WAL');        // 读写不互相阻塞，适合"偶尔写、频繁读"
db.pragma('synchronous = NORMAL');      // 兼顾安全与写入速度
db.pragma(`cache_size = -${config.db.cacheSizeKb}`); // 页缓存上限，负数=KB
db.pragma('mmap_size = 0');             // 关闭内存映射，RSS 更可控
db.pragma('temp_store = MEMORY');       // 临时表放内存（查询都很小）
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

// ---------------------------------------------------------------
// 建表 + 迁移
// ---------------------------------------------------------------
db.exec(`
  -- 站点基础信息（永远只有 id = 1 这一行）
  CREATE TABLE IF NOT EXISTS profile (
    id          INTEGER PRIMARY KEY CHECK (id = 1),
    name        TEXT NOT NULL DEFAULT '',
    role        TEXT NOT NULL DEFAULT '',
    tagline     TEXT NOT NULL DEFAULT '',
    avatar      TEXT NOT NULL DEFAULT '',
    bio         TEXT NOT NULL DEFAULT '',
    location    TEXT NOT NULL DEFAULT '',
    email       TEXT NOT NULL DEFAULT '',
    website     TEXT NOT NULL DEFAULT '',
    github      TEXT NOT NULL DEFAULT '',
    twitter     TEXT NOT NULL DEFAULT '',
    weibo       TEXT NOT NULL DEFAULT '',
    wechat      TEXT NOT NULL DEFAULT '',
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- 技能标签
  CREATE TABLE IF NOT EXISTS skills (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    category   TEXT NOT NULL DEFAULT '通用',
    level      INTEGER NOT NULL DEFAULT 3,   -- 1~5，用于渲染强度条
    sort       INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- 作品集
  CREATE TABLE IF NOT EXISTS projects (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    title       TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    image       TEXT NOT NULL DEFAULT '',
    link        TEXT NOT NULL DEFAULT '',
    tags        TEXT NOT NULL DEFAULT '',    -- 逗号分隔
    featured    INTEGER NOT NULL DEFAULT 0,  -- 1 = 首页大图位
    sort        INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- 博客文章（content 存 Markdown 原文）
  CREATE TABLE IF NOT EXISTS posts (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    title      TEXT NOT NULL,
    slug       TEXT NOT NULL UNIQUE,
    summary    TEXT NOT NULL DEFAULT '',
    content    TEXT NOT NULL DEFAULT '',
    tags       TEXT NOT NULL DEFAULT '',
    published  INTEGER NOT NULL DEFAULT 1,
    views      INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_posts_published ON posts (published, created_at DESC);

  -- 访客留言
  CREATE TABLE IF NOT EXISTS messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    email      TEXT NOT NULL DEFAULT '',
    content    TEXT NOT NULL,
    ip         TEXT NOT NULL DEFAULT '',
    ua         TEXT NOT NULL DEFAULT '',
    approved   INTEGER NOT NULL DEFAULT 1,   -- 后台可改为 0 隐藏
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_messages_created ON messages (created_at DESC);

  -- 管理员账号（支持后续扩展多账号，目前只用一行）
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    last_login_at TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- 通用键值表（记录数据库版本号等）
  CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

// ---------------------------------------------------------------
// 初始化数据：只在缺数据时写入，不会覆盖你已有的内容
// ---------------------------------------------------------------
function initialize() {
  const profileCount = db.prepare('SELECT COUNT(*) AS c FROM profile').get().c;
  if (profileCount === 0) {
    db.prepare(
      `INSERT INTO profile (id, name, role, tagline, avatar, bio, location, email, website, github, twitter, weibo, wechat)
       VALUES (1, @name, @role, @tagline, @avatar, @bio, @location, @email, @website, @github, @twitter, @weibo, @wechat)`
    ).run({
      name: '林知远',
      role: '产品设计师 / 全栈开发者',
      tagline: '把复杂的事情做简单，把简单的事情做漂亮。',
      avatar: 'https://picsum.photos/seed/litesite-avatar/480/480',
      bio:
        '我在成都做独立产品。白天写代码和画界面，晚上写一点关于设计与工程之间那条模糊边界的笔记。' +
        '相信好的产品应该像好的排版一样，安静、清晰、不打扰人。',
      location: '成都 · 中国',
      email: 'hi@example.com',
      website: 'https://example.com',
      github: 'https://github.com/yourname',
      twitter: 'https://twitter.com/yourname',
      weibo: 'https://weibo.com/yourname',
      wechat: 'your_wechat_id',
    });
  }

  const skillCount = db.prepare('SELECT COUNT(*) AS c FROM skills').get().c;
  if (skillCount === 0) {
    const insert = db.prepare(
      'INSERT INTO skills (name, category, level, sort) VALUES (?, ?, ?, ?)'
    );
    const seedSkills = [
      ['UI / 视觉设计', '设计', 5, 1],
      ['设计系统', '设计', 4, 2],
      ['交互原型', '设计', 4, 3],
      ['JavaScript / TypeScript', '开发', 5, 1],
      ['Node.js', '开发', 4, 2],
      ['SQLite / 数据建模', '开发', 4, 3],
      ['Linux 运维', '运维', 3, 1],
      ['Nginx / 部署', '运维', 3, 2],
      ['写作与文档', '其它', 4, 1],
    ];
    const tx = db.transaction((rows) => rows.forEach((r) => insert.run(...r)));
    tx(seedSkills);
  }

  const projectCount = db.prepare('SELECT COUNT(*) AS c FROM projects').get().c;
  if (projectCount === 0) {
    const insert = db.prepare(
      `INSERT INTO projects (title, description, image, link, tags, featured, sort)
       VALUES (@title, @description, @image, @link, @tags, @featured, @sort)`
    );
    const seedProjects = [
      {
        title: 'Paper 记账',
        description:
          '一个克制到只有三个按钮的记账工具。把"记录"这件事压缩到 2 秒内完成，剩下的交给时间。',
        image: 'https://picsum.photos/seed/litesite-p1/1200/900',
        link: 'https://example.com/paper',
        tags: '产品设计,Node.js,PWA',
        featured: 1,
        sort: 1,
      },
      {
        title: 'Grid 排版实验室',
        description: '把杂志排版规则翻译成 CSS 变量的一个小工具，附带 24 套网格预设。',
        image: 'https://picsum.photos/seed/litesite-p2/900/900',
        link: 'https://example.com/grid',
        tags: 'CSS,工具',
        featured: 0,
        sort: 2,
      },
      {
        title: 'Quiet 阅读器',
        description: '为长文阅读重做的排版引擎，去掉一切会打断注意力的元素。',
        image: 'https://picsum.photos/seed/litesite-p3/900/900',
        link: 'https://example.com/quiet',
        tags: '排版,体验设计',
        featured: 0,
        sort: 3,
      },
      {
        title: '站点监控小屏',
        description: '一台旧平板 + 树莓派，做成挂在墙上的服务状态看板。',
        image: 'https://picsum.photos/seed/litesite-p4/1200/900',
        link: 'https://example.com/dash',
        tags: '硬件,Linux',
        featured: 0,
        sort: 4,
      },
    ];
    const tx = db.transaction((rows) => rows.forEach((r) => insert.run(r)));
    tx(seedProjects);
  }

  const postCount = db.prepare('SELECT COUNT(*) AS c FROM posts').get().c;
  if (postCount === 0) {
    const insert = db.prepare(
      `INSERT INTO posts (title, slug, summary, content, tags, published, created_at)
       VALUES (@title, @slug, @summary, @content, @tags, 1, @created_at)`
    );
    const seedPosts = [
      {
        title: '用 1 核 1G 的机器跑一个像样的个人站',
        slug: 'run-a-site-on-1c1g-vps',
        summary: '大多数个人站根本不需要 React 与 MySQL。聊一聊这套栈为什么够用。',
        tags: '运维,Node.js',
        created_at: '2024-11-02 09:12:00',
        content: `## 先承认一件事

个人主页的访问量通常是**个位数到三位数**。为这个量级准备 Kubernetes 和 MySQL，就像骑自行车去楼下买菜却开了一辆货车。

### 这套栈的选择

| 层 | 选择 | 理由 |
| --- | --- | --- |
| 运行时 | Node.js + Express | 冷启动快，常驻内存约 50MB |
| 数据库 | SQLite 单文件 | 零独立进程，省下 200MB 以上内存 |
| 前端 | Tailwind CDN + 原生 JS | 没有构建步骤，没有虚拟 DOM |

### 关键的一行配置

\`\`\`bash
pm2 start ecosystem.config.js
\`\`\`

PM2 的 \`max_memory_restart\` 是最后的保险丝：内存一旦超过阈值就自动重启，比被系统 OOM Killer 杀掉要体面得多。

> 记住：能在 Nginx 层解决的问题，就不要留给 Node。

### 静态资源交给 Nginx

\`\`\`nginx
location /uploads/ {
    alias /var/www/litesite/public/uploads/;
    expires 30d;
}
\`\`\`

这样一张图片的请求根本不会进 Node 进程，CPU 与内存都省下来了。`,
      },
      {
        title: '排版里的三个隐形决定',
        slug: 'three-invisible-typography-decisions',
        summary: '字号、行高、对比度。它们决定了读者会不会读完你的文章。',
        tags: '设计,排版',
        created_at: '2024-10-18 21:40:00',
        content: `## 一、字号不是越大越好

正文的舒适区在 **16px 到 19px** 之间。移动端取上限，桌面端取下限，因为屏幕距离不同。

## 二、行高跟着字号走

经验公式：

- 正文：\`1.6\` 到 \`1.8\`
- 标题：\`1.1\` 到 \`1.25\`

字号越大，行高比例应当越小，否则两三行标题会散架。

## 三、对比度要"够用就停"

纯黑 \`#000\` 在纯白背景上对比度过高，长文阅读会累。用接近黑但带一点色相的墨色，例如 \`#14110F\`。

> 排版的目标不是让人注意到排版，而是让人注意到内容。

这也是我个人站坚持的做法：所有装饰性元素都可以删，唯独这三条不能。`,
      },
      {
        title: '我如何备份一台只有 1G 内存的服务器',
        slug: 'backup-a-1g-vps',
        summary: 'SQLite 的好处就是备份几乎是零成本的：复制一个文件。',
        tags: '运维,备份',
        created_at: '2024-09-30 08:05:00',
        content: `## 备份策略：三层

1. **数据库**：用 \`sqlite3 .backup\` 生成一致性快照，避免直接复制正在写入的库。
2. **上传目录**：每周打一次 \`tar.gz\`，保留 4 份。
3. **配置**：\`.env\`、Nginx 配置、PM2 配置丢进私有 Git 仓库。

### 一个够用的备份脚本

\`\`\`bash
#!/usr/bin/env bash
set -euo pipefail
STAMP=$(date +%F_%H%M)
mkdir -p /var/backups/litesite
sqlite3 /var/www/litesite/data/litesite.db ".backup '/var/backups/litesite/db_$STAMP.db'"
find /var/backups/litesite -type f -mtime +30 -delete
\`\`\`

挂到 crontab，每天凌晨 4 点跑一次即可。恢复时把 db 文件放回 \`data/\` 目录，重启 PM2。`,
      },
    ];
    const tx = db.transaction((rows) => rows.forEach((r) => insert.run(r)));
    tx(seedPosts);
  }

  const userCount = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  if (userCount === 0) {
    // bcryptjs 使用 10 轮，1G 内存机器上单次哈希约 60~90ms，足够安全且不卡
    const hash = bcrypt.hashSync(config.admin.password, 10);
    db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(
      config.admin.username,
      hash
    );
    console.log(`[db] 已创建管理员账号：${config.admin.username}（请登录后立即修改密码）`);
  }

  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('schema_version', '1');
}

initialize();

module.exports = db;
