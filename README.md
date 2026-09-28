# litesite · 轻量个人主页 + 独立管理后台

一套刻意做「减法」的个人主页系统，目标只有一个：**在 2 核 1G 的 VPS 上长期稳定运行，不被 OOM Killer 杀掉。**

实测常驻内存：**生产模式 64 MB 左右**（`NODE_ENV=production`，静态文件交给 Nginx）。堆内存仅 10 MB 上下，说明大量内存消耗在 Node 运行时本身，而不是业务代码。

---

## 一、技术选型与内存账本

| 层 | 选型 | 为什么不用常见的替代品 |
| --- | --- | --- |
| 运行时 | Node.js 22 LTS + Express 4 | Express 只做路由与中间件，没有 Nest / NextJS 的装饰器、DI 容器、编译产物常驻 |
| 数据库 | SQLite（better-sqlite3） | 单文件、零独立进程。MySQL 空载就吃 300MB 以上内存，PostgreSQL 更多；个人站的数据量根本用不上连接池与并发事务 |
| 会话 | 自写 HMAC 签名 Cookie | 省掉 express-session + 存储驱动，服务端零存储，改密码自动踢掉所有旧会话 |
| 前端 | TailwindCSS CDN + 原生 JS | 不装 React / Vue，没有虚拟 DOM、没有 hydration、没有打包产物 |
| 图标 | 内联几何 SVG（全站不到 10 个） | 不引入整套图标库 |
| Markdown | marked + DOMPurify（浏览器端 CDN） | 服务端零渲染开销，Node 不因为渲染 Markdown 而占用内存 |
| 图片 | 占位图 + 懒加载 + 按显示尺寸取图 | 减少带宽的同时也减少浏览器解码内存 |
| 进程 | PM2，fork 单进程 + 内存上限 | 不用 cluster（多 worker 会复制运行时内存）；配 `max-old-space-size` 与 `max_memory_restart` 两道闸 |

依赖清单只有 5 个（4 个纯 JS + 1 个原生模块）：

```
express  better-sqlite3  bcryptjs  multer  dotenv
```

对比一下：`nest + typeorm + mysql2 + next` 这一套空载常驻内存通常在 400MB 以上，1G 的机器还没跑起来就已经被吃掉一半。

### 内存护栏的三道防线

1. **V8 堆上限**：`--max-old-space-size=96`，达到上限触发 GC 而不是无限索取系统内存；
2. **PM2 重启阈值**：`max_memory_restart: '150M'`，RSS 超限自动重启，避免被内核 OOM Killer 连带杀掉 Nginx / SSH；
3. **静态资源旁路**：Nginx 直接读磁盘返回静态文件与图片，请求根本不进 Node 进程。

---

## 二、目录结构

```
personal-site/
├── server.js                       # 服务入口：中间件编排、静态托管开关、优雅退出
├── package.json                    # 只有 5 个生产依赖
├── package-lock.json               # 锁定版本，部署用 npm ci
├── ecosystem.config.js             # PM2 配置（内存上限 + 崩溃自愈）
├── tailwind.config.js              # 可选：本地构建 CSS 时的配置
├── tailwind.input.css              # 可选：本地构建 CSS 的入口
├── .env.example                    # 环境变量模板（复制成 .env 使用）
├── .gitignore
├── README.md                       # 本文件
│
├── docs/
│   ├── DEPLOY.md                   # 从零部署到 2核1G VPS 的完整步骤
│   └── OPS.md                      # 日常运维 + 排错指南（内存过高、服务退出等）
│
├── deploy/
│   ├── deploy.sh                   # 一键部署脚本（Ubuntu / Debian）
│   ├── nginx.conf                  # Nginx 反代 + 静态缓存配置模板
│   └── proxy_params_litesite.conf  # Nginx 反代公共参数片段
│
├── tests/
│   └── api-test.js                 # 零依赖的端到端 API 自测（48 项检查）
│
├── data/                           # SQLite 数据目录（运行时生成 litesite.db）
├── logs/                           # PM2 日志目录（err.log / out.log）
│
├── public/                         # 静态资源，生产环境由 Nginx 直接托管
│   ├── index.html                  # 访客首页（单文件，含全部模块）
│   ├── admin.html                  # 管理后台单页
│   ├── 404.html                    # 零外部请求的 404 页
│   ├── css/app.css                 # 自定义样式：氛围层、按钮、骨架屏、Markdown 排版
│   ├── js/app.js                   # 前台脚本：数据渲染、主题切换、阅读层、留言
│   ├── js/admin.js                 # 后台脚本：全部管理交互
│   └── uploads/                    # 上传图片目录（Nginx 直接托管）
│
└── src/
    ├── config.js                   # 集中读取 .env，做类型转换与路径解析
    ├── db.js                       # 建表、PRAGMA 调优、示例数据初始化
    ├── auth.js                     # HMAC 会话签发校验、Cookie 读写、鉴权中间件
    ├── security.js                 # 安全响应头（CSP 等）
    ├── ratelimit.js                # 内存限流器（登录防爆破、留言防刷屏）
    ├── util.js                     # 字段收敛、slug 生成、摘要提取
    ├── seed.js                     # 初始化 / 查看数据量
    ├── reset-password.js           # 忘记密码时的救援脚本
    └── routes/
        ├── public.js               # 访客 API（只读 + 留言提交）
        └── admin.js                # 后台 API（登录、CRUD、上传、改密）
```

---

## 三、功能一览

**访客前台（`/`）**

- 个人头像与简介、一句话签名、真实统计（作品数 / 文章数）
- 技能标签，按分类分组，用细线条展示熟练度
- 作品集：**不对称网格**（4 列宽卡与 2 列窄卡交替），图片懒加载并按显示尺寸请求
- 博客列表：编辑式列表而非卡片墙，点击在阅读层内打开，支持 `#/post/slug` 深链
- 联系方式：邮箱、网站、GitHub、X、微博、微信，一键复制
- 留言墙 + 留言表单（含字数统计、错误提示、限流提示）
- 深色 / 浅色主题切换，跟随系统，记忆选择，**首屏无闪烁**
- 响应式：手机 / 平板 / 桌面自适应，导航在桌面端始终单行
- 无障碍：键盘焦点可见、尊重 `prefers-reduced-motion`、语义化标签

**管理后台（`/admin`）**

- 账号密码登录，bcrypt 加密存储，登录失败限流封禁
- 主页信息：头像（可上传）、昵称、身份、签名、简介、所在地、邮箱、四个社交链接
- 技能标签：增删改查
- 作品集：增删改查、图片上传、标题描述链接、标签、排序、首页突出
- 博客：Markdown 编辑器 + 实时预览（分栏）、草稿/发布、slug 自动生成与去重、摘要自动截取
- 留言：查看（含邮箱与来源 IP）、显示/隐藏、删除
- 安全：修改登录密码（改完全部旧会话立即失效）、查看上次登录与进程内存

---

## 四、本地测试运行

需要 **Node.js 22 或更高版本**。

> 为什么不能用 Node 20：`better-sqlite3` 从 v12 起只提供 Node 22+（ABI `node-v127` 及以上）的预编译包。
> 在 Node 20 上会下载不到预编译文件、回退到本地编译并报 `Could not locate the bindings file`。
> 想确认依赖装好了，执行 `node -e "require('better-sqlite3'); console.log('OK')"`。

```bash
# 1. 进入项目目录
cd personal-site

# 2. 安装依赖
npm install

# 3. 准备环境变量
cp .env.example .env      # Windows: copy .env.example .env

# 4. 编辑 .env，至少确认这两项
#    NODE_ENV=development
#    SERVE_STATIC=true      # 本地没有 Nginx，让 Node 直接托管静态文件
#    SESSION_SECRET=<随机字符串，可用 openssl rand -hex 32 生成>
#    ADMIN_USERNAME=admin
#    ADMIN_PASSWORD=你的密码

# 5. 初始化数据库（写入示例内容，已有数据不会覆盖）
npm run seed

# 6. 启动
npm start                 # 或 npm run dev（文件变更自动重启）
```

打开 <http://127.0.0.1:3000> 查看前台，<http://127.0.0.1:3000/admin> 进入后台（用 `.env` 里的账号密码登录）。

自检接口：

```bash
curl -s http://127.0.0.1:3000/api/health
# {"ok":true,"uptime":12,"rssMB":64.4,"heapMB":10.8}
```

### 跑一遍端到端自测（可选，但推荐）

项目自带一个零依赖的 API 测试脚本，覆盖登录、限流、四类 CRUD、图片上传、改密后会话失效、
路径穿越防护与内存稳定性，共 48 项检查。**它会在结束时把自己改动的数据恢复原样**。

```bash
# 另开一个终端保持服务运行，然后：
npm run test:api
```

如果 `.env` 里的账号密码不是默认值，用环境变量覆盖：

```bash
# Linux / macOS
ADMIN_USER=admin ADMIN_PASS=你的密码 npm run test:api
# Windows PowerShell
$env:ADMIN_PASS='你的密码'; npm run test:api
# 换端口时
BASE_URL=http://127.0.0.1:3210 npm run test:api
```

期望结尾输出：

```
结果：48 通过 / 0 失败
```

> 提示：留言接口有「每 IP 10 分钟 3 条」的限流，短时间内重复运行脚本可能触发 429，
> 重启一次服务即可清空限流计数（限流状态存在内存里）。

> **注意**：项目**不包含 `.env`**（它含密钥与密码，已被 `.gitignore` 排除）。
> 请务必按上面第 3 步从 `.env.example` 复制一份再启动。

> **安装依赖时如果卡在 better-sqlite3**（国内服务器下载 GitHub 预编译包超时很常见），
> 先核对 Node 版本，再配国内镜像：
>
> ```bash
> node -v          # 必须是 v22.x 或更高，Node 20 没有对应的预编译包
> npm config set better_sqlite3_binary_host_mirror https://registry.npmmirror.com/-/binary/better-sqlite3
> npm install
> ```
>
> 该配置只在安装阶段生效，不影响运行时。

> **如果提示 `Could not locate the bindings file` 或找不到 Visual Studio**：都是预编译包没下载成功的表现。
> 先确认 Node 版本 >= 22，再套用上面的镜像；这两步都对的话，不需要任何 C++ 工具链。

---

## 五、部署与运维文档

- 从零部署（系统更新、Node 安装、上传项目、依赖安装、PM2、Nginx、HTTPS、防火墙）：见 [docs/DEPLOY.md](docs/DEPLOY.md)
- 日常运维与排错（查看内存、看日志、重启、重置密码、内存过高 / 服务自动退出处理）：见 [docs/OPS.md](docs/OPS.md)
- Nginx 配置模板：见 [deploy/nginx.conf](deploy/nginx.conf)
- PM2 配置：见 [ecosystem.config.js](ecosystem.config.js)
- 环境变量模板：见 [.env.example](.env.example)

---

## 六、更新线上站点（Git 工作流）

线上代码一律通过 Git 拉取。**不要在服务器上直接改源码**，否则下次拉取会冲突。

### 一次性配置（部署时做一遍）

```bash
# 服务器上生成只读部署密钥
sudo -i
mkdir -p /root/.ssh && chmod 700 /root/.ssh
ssh-keygen -t ed25519 -C "litesite-server" -f /root/.ssh/deploy_litesite -N ""
cat /root/.ssh/deploy_litesite.pub
```

把打印出的公钥整行加到仓库 **Settings → Deploy keys**（**不要勾选 Allow write access**），然后：

```bash
cat >> /root/.ssh/config <<'EOF'
Host github.com
  IdentityFile /root/.ssh/deploy_litesite
  IdentitiesOnly yes
EOF
chmod 600 /root/.ssh/config

cd /var/www/litesite
git init -b main
git remote add origin git@github.com:<你的用户名>/litesite.git
git fetch origin
git reset --hard origin/main
git branch --set-upstream-to=origin/main main
```

`git reset --hard` 只覆盖被 Git 跟踪的文件；`.env`、`data/`、`node_modules/`、`public/uploads/` 都在 `.gitignore` 里，不受影响。

### 装一次更新脚本

```bash
cat > /root/update.sh <<'EOF'
#!/bin/bash
set -e
cd /var/www/litesite
cp data/litesite.db /root/litesite-backup-$(date +%F_%H%M).db 2>/dev/null || true
git pull
npm ci --omit=dev --no-audit --no-fund
pm2 reload litesite --update-env
pm2 status
curl -s http://127.0.0.1:3000/api/health; echo
EOF
chmod +x /root/update.sh
```

### 日常流程

本地（若本机访问 `github.com:443` 超时，先 `git config http.proxy http://127.0.0.1:7897`，推送时保持代理开启）：

```bash
git add -A
git commit -m "说明这次改了什么"
git push
```

服务器：

```bash
/root/update.sh
```

### 改完什么需要重启

| 改动位置 | 需要做什么 |
| --- | --- |
| `public/` 下的 HTML | 不用重启，Nginx 直接读磁盘 |
| `public/` 下的 CSS / JS | 不用重启，但要在 HTML 引用处加版本号（`/js/app.js?v=2`），否则老访客 30 天缓存内拿到旧文件 |
| `src/**`、`server.js` | `pm2 reload litesite` |
| `.env` | `pm2 reload litesite --update-env` |
| `package.json`（新增依赖） | `npm ci --omit=dev` 后 `pm2 reload litesite` |
| `ecosystem.config.js` | `pm2 delete litesite && pm2 start ecosystem.config.js && pm2 save` |
| `deploy/nginx.conf` | 手动同步到 `/etc/nginx/sites-available/litesite`（记得把 `example.com` 换成你的域名），再 `nginx -t && systemctl reload nginx`。`update.sh` 不会自动应用 Nginx 配置 |
| `src/db.js` 的表结构 | **不会自动迁移**，见下 |

### 改数据库表结构

`src/db.js` 用 `CREATE TABLE IF NOT EXISTS`，新增表会自动创建，**新增列不会**，需要手动执行：

```bash
cp /var/www/litesite/data/litesite.db /root/db-backup-$(date +%F).db
sqlite3 /var/www/litesite/data/litesite.db "ALTER TABLE projects ADD COLUMN demo_url TEXT DEFAULT '';"
pm2 reload litesite
```

### 回滚到上一个版本

```bash
cd /var/www/litesite
git log --oneline -10
git reset --hard <某个提交的哈希>
pm2 reload litesite
```

---

## 七、API 速查

| 方法 | 路径 | 说明 | 鉴权 |
| --- | --- | --- | --- |
| GET | `/api/health` | 健康检查（含内存读数） | 否 |
| GET | `/api/site` | 首屏数据：站点信息 + 主页信息 + 技能分组 + 统计 | 否 |
| GET | `/api/projects` | 作品列表 | 否 |
| GET | `/api/posts?limit=&offset=` | 文章列表（仅已发布） | 否 |
| GET | `/api/posts/:slug` | 文章详情（返回 Markdown 原文，浏览量 +1） | 否 |
| GET | `/api/messages?limit=` | 留言墙（不含邮箱与 IP） | 否 |
| POST | `/api/messages` | 提交留言（每 IP 10 分钟 3 条） | 否 |
| POST | `/api/admin/login` | 登录（失败限流） | 否 |
| POST | `/api/admin/logout` | 退出 | 是 |
| GET | `/api/admin/session` | 当前登录态 | 是 |
| GET | `/api/admin/stats` | 数据统计 + 进程内存 | 是 |
| GET/PUT | `/api/admin/profile` | 主页信息 | 是 |
| GET/POST/PUT/DELETE | `/api/admin/skills[/:id]` | 技能标签 | 是 |
| GET/POST/PUT/DELETE | `/api/admin/projects[/:id]` | 作品集 | 是 |
| POST | `/api/admin/upload` | 图片上传（单文件，类型与大小白名单） | 是 |
| DELETE | `/api/admin/uploads/:name` | 删除已上传图片 | 是 |
| GET/POST/PUT/DELETE | `/api/admin/posts[/:id]` | 博客文章 | 是 |
| GET/PATCH/DELETE | `/api/admin/messages[/:id]` | 留言管理 | 是 |
| POST | `/api/admin/password` | 修改密码 | 是 |

---

## 八、设计说明（为什么长这样）

- **颜色**：一套中性灰底 + 单一强调色（赭橙）。深浅两套主题共用同一组 RGB 变量，改主题只需要改一段变量；强调色只用于图形、下划线、悬停态，正文与按钮保持高对比的墨色，保证 WCAG AA。
- **形状**：全站统一圆角体系，卡片 16~20px，控件一律药丸形。
- **动效**：只有三种。滚动进场（14px 位移 + 淡入，IntersectionObserver，进场即解除观察）、主题切换的颜色过渡、卡片的图片轻微放大。全部在 `prefers-reduced-motion` 下自动关闭。
- **氛围**：一张极低透明度的 SVG 噪点纹理 + 两团柔和径向渐变，纯 CSS 实现，零额外请求，也零运行时开销。
- **排版**：正文 16.5px/1.78，标题用 Space Grotesk，正文用 Outfit，代码用系统等宽字体栈。
