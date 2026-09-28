# 从零部署到 2 核 1G VPS（完整步骤）

> 适用系统：Ubuntu 22.04 / 24.04 LTS，Debian 12 亦可（命令几乎一致）
> 全程约 20 分钟。文中 `example.com` 请替换成你自己的域名，`/var/www/litesite` 是部署目录。
> 有一条捷径：第 1~10 步可以用 `sudo ./deploy/deploy.sh` 一键完成，但**首次部署建议照着做一遍**，出问题时你知道每一步在干什么。

---

## 0. 开始之前

| 需要准备 | 说明 |
| --- | --- |
| VPS | 2 核 1G 起，Ubuntu 22.04/24.04 |
| 域名 | 已解析 A 记录到服务器 IP（申请证书必需） |
| 本地项目 | 本文档所在的项目目录 |

先在本地确认项目能跑起来（见 [README](../README.md) 第四节），再上传到服务器。

### DNS 解析

在域名服务商处添加两条 A 记录，都指向服务器公网 IP：

```
@      A   你的服务器IP
www    A   你的服务器IP
```

解析生效检查（本地执行）：

```bash
ping -c 2 example.com
```

---

## 1. 服务器初始化

SSH 登录（把 `root` 换成你的用户名，腾讯云/阿里云 Ubuntu 镜像默认用户通常是 `ubuntu`）：

```bash
ssh root@你的服务器IP
```

### 1.1 更新系统与安装基础工具

```bash
apt update && apt upgrade -y
apt install -y curl ca-certificates gnupg git ufw sqlite3 unzip
```

### 1.2 设置时区（日志时间才看得懂）

```bash
timedatectl set-timezone Asia/Shanghai
date
```

### 1.3 【强烈建议】给 1G 内存的机器加 1GB Swap

这是 1G 机器的**保命配置**。当物理内存紧张时，内核会把不活跃页换到 Swap，而不是直接触发 OOM Killer 杀掉你的进程。代价只是一点磁盘空间。

```bash
# 创建 1GB swap 文件
fallocate -l 1G /swapfile
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile

# 开机自动挂载
echo '/swapfile none swap sw 0 0' >> /etc/fstab

# 降低换出倾向（10 表示只在真的紧张时才用 swap，避免无谓的磁盘 IO）
sysctl vm.swappiness=10
echo 'vm.swappiness=10' >> /etc/sysctl.conf

# 确认
free -h
swapon --show
```

看到 `Swap: 1.0Gi` 就成功了。

### 1.4 （可选）关闭不需要的服务

1G 内存上，这些服务白吃内存，用不到就关掉：

```bash
# 按需关闭，不要盲目执行
systemctl disable --now snapd.service snapd.socket 2>/dev/null || true
```

---

## 2. 安装 Node.js 22 LTS

> **必须是 Node 22 或更高版本，不要用 Node 20。**
>
> 原因：`better-sqlite3` 的原生模块按 Node 的 ABI 版本分发预编译包。Node 20 的 ABI 是 `node-v115`，
> 而 `better-sqlite3` 从 v12 起只提供 `node-v127`（Node 22）及以上的预编译包。用 Node 20 会下载不到，
> 回退到本地编译并失败，报错形如 `Could not locate the bindings file` + 一长串 `better_sqlite3.node` 路径。

**不要用 `apt install nodejs`**，系统源里的版本太旧。用 NodeSource 官方源：

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs

# 验证
node -v     # 应输出 v22.x.x 或更高
npm -v
```

如果机器上已经装过 Node 20，先卸干净再装：

```bash
apt purge -y nodejs
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs
node -v
```

### 国内服务器提速（可选）

```bash
npm config set registry https://registry.npmmirror.com
```

### 关于原生模块 better-sqlite3 的预编译包

`better-sqlite3` 是原生模块，安装时会下载与当前 Node ABI 匹配的预编译二进制文件。
**国内服务器直连 GitHub 这一步经常超时**，配上国内镜像就能直接下载、完全不需要编译：

```bash
npm config set better_sqlite3_binary_host_mirror https://registry.npmmirror.com/-/binary/better-sqlite3
```

Node 22 对应 `node-v127`，镜像里有这个文件，安装是秒级的。装完用这条命令确认：

```bash
node -e "require('better-sqlite3'); console.log('原生模块 OK')"
```

只有在镜像里也找不到对应 ABI 文件时，才会回退到本地编译。本地编译需要 C++ 工具链，
2 核 1G 大约要 3~5 分钟且吃内存，**务必先加好 Swap**：

```bash
apt install -y build-essential python3
cd /var/www/litesite && npm rebuild better-sqlite3 --build-from-source
```

---

## 3. 上传项目

三种方式选一种。

### 方式 A：本地打包上传（推荐，最简单）

在**本地**项目**上一级目录**执行：

```bash
# 本地：打包（排除 node_modules 与本地环境变量文件）
tar --exclude='node_modules' --exclude='.npm-cache' --exclude='.env' \
    -czf litesite.tar.gz personal-site/

# 本地：上传
scp litesite.tar.gz root@你的服务器IP:/tmp/
```

在**服务器**上：

```bash
mkdir -p /var/www
cd /var/www
tar -xzf /tmp/litesite.tar.gz
mv personal-site litesite
cd /var/www/litesite
ls
```

> Windows 用户可以用 WinSCP / MobaXterm 图形化上传，或 PowerShell 里执行
> `scp .\litesite.zip root@IP:/tmp/` 然后服务器上 `unzip`。

### 方式 B：Git 仓库

```bash
cd /var/www
git clone https://github.com/你的账号/你的仓库.git litesite
cd litesite
```

### 方式 C：直接用一键脚本（脚本会从当前目录部署，需先把项目放到服务器）

见第 11 节。

---

## 4. 安装依赖

```bash
cd /var/www/litesite

# 只装生产依赖，跳过 devDependencies，省磁盘也省内存
npm ci --omit=dev --no-audit --no-fund

# 如果没有 package-lock.json（例如你删掉了），改用：
# npm install --omit=dev --no-audit --no-fund
```

验证原生模块与数据库初始化：

```bash
node -e "require('better-sqlite3'); console.log('better-sqlite3 加载正常')"
```

看到 `better-sqlite3 加载正常` 才能继续。如果报错，回到第 2 节处理预编译包问题。

---

## 5. 配置环境变量

```bash
cp .env.example .env
chmod 600 .env          # 里面有密码和密钥，收紧权限
nano .env
```

**必须修改的项**：

```ini
NODE_ENV=production
HOST=127.0.0.1          # 只监听本机，由 Nginx 对外，不要改成 0.0.0.0
PORT=3000
TRUST_PROXY=true

SITE_TITLE=你的站点名
SITE_URL=https://example.com

ADMIN_USERNAME=admin
ADMIN_PASSWORD=换成你自己的强密码      # 只在首次初始化数据库时生效

# 生成随机密钥（复制终端输出填进去）
# openssl rand -hex 32
SESSION_SECRET=把生成的长随机字符串填这里

# 配好 HTTPS 之后再改成 true（这一步别忘）
COOKIE_SECURE=false
```

生成密钥：

```bash
openssl rand -hex 32
```

其余项保持默认即可（限流次数、上传大小限制、数据库缓存等，[.env.example](../.env.example) 里每项都有注释）。

---

## 6. 初始化数据库

```bash
npm run seed
```

输出示例：

```
数据库文件： /var/www/litesite/data/litesite.db
---------------------------------------------
  profile       1 条
  skills        9 条
  projects      4 条
  posts         3 条
  messages      0 条 (空)
  users         1 条
---------------------------------------------
管理员账号： admin
```

`SQLite` 单文件就在 `data/litesite.db`，备份它就是备份全部内容。

---

## 7. 用 PM2 托管并设置内存上限

### 7.1 安装 PM2 与日志轮转

```bash
npm install -g pm2

# PM2 默认不切割日志，长时间运行会把磁盘写满，必须装轮转模块
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 10M
pm2 set pm2-logrotate:retain 7
pm2 set pm2-logrotate:compress true
```

### 7.2 确认内存限制配置

打开 `ecosystem.config.js`，确认这两行（默认已配好）：

```js
node_args: '--max-old-space-size=96',   // V8 堆上限 96MB
max_memory_restart: '150M',             // RSS 超过 150MB 自动重启
```

### 7.3 启动

```bash
cd /var/www/litesite
pm2 start ecosystem.config.js

pm2 status
# 期望看到 status = online，restart = 0，mem 在 60~80MB 之间
```

### 7.4 设置开机自启

```bash
pm2 save                                  # 保存当前进程列表
pm2 startup systemd                       # 按提示复制执行它输出的那行 sudo 命令
```

`pm2 startup` 会输出一行类似这样的命令，需要你复制并执行它：

```
sudo env PATH=$PATH:/usr/bin pm2 startup systemd -u root --hp /root
```

### 7.5 验证服务

```bash
curl -s http://127.0.0.1:3000/api/health
# {"ok":true,"uptime":10,"rssMB":64.2,"heapMB":10.1}
```

---

## 8. 配置 Nginx（静态资源归 Nginx，Node 只处理 API）

### 8.1 安装

```bash
apt install -y nginx
```

### 8.2 部署配置片段与站点配置

```bash
# 反代公共参数
cp /var/www/litesite/deploy/proxy_params_litesite.conf /etc/nginx/proxy_params_litesite

# 站点配置
cp /var/www/litesite/deploy/nginx.conf /etc/nginx/sites-available/litesite
ln -sf /etc/nginx/sites-available/litesite /etc/nginx/sites-enabled/litesite

# 移除默认站点（留着会抢占 80 端口）
rm -f /etc/nginx/sites-enabled/default

# 改域名：把 example.com 全部替换成你的域名
sed -i 's/example.com/你的域名/g' /etc/nginx/sites-available/litesite
nano /etc/nginx/sites-available/litesite     # 建议手动核对一遍
```

### 8.3 申请证书前，先临时跳过 HTTPS 跳转

`nginx.conf` 里的 HTTP 段默认会 301 跳到 HTTPS。**在还没有证书之前，这会导致 certbot 验证失败**，
所以先把它注释掉：

```bash
nano /etc/nginx/sites-available/litesite
```

找到 HTTP server 段里的：

```nginx
    location / {
        return 301 https://$host$request_uri;
    }
```

临时改为：

```nginx
    # location / {
    #     return 301 https://$host$request_uri;
    # }
    location / {
        proxy_pass http://litesite_node;
        include /etc/nginx/proxy_params_litesite;
    }
```

同时**把整个 HTTPS server 段（`listen 443` 那一段）暂时注释掉**，因为它引用的证书文件还不存在，`nginx -t` 会直接失败。

### 8.4 校验并重载

```bash
nginx -t
# 输出 syntax is ok / test is successful 才能继续
systemctl reload nginx
systemctl enable nginx
```

此时访问 `http://你的域名` 应该能看到网站了。

---

## 9. 防火墙放行端口

```bash
ufw allow 22/tcp        # SSH，务必先放行再启用，否则会把自己关在门外
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable
ufw status
```

期望输出：

```
22/tcp     ALLOW
80/tcp     ALLOW
443/tcp    ALLOW
```

> **注意**：Node 的 3000 端口**不需要放行**，它只监听 `127.0.0.1`，外部访问不到，这是刻意的安全设计。
> 腾讯云 / 阿里云还需要在控制台的**安全组**里放行 80、443（以及 22），云厂商的安全组优先级高于 ufw。

---

## 10. 申请 Let's Encrypt HTTPS 证书

### 10.1 安装 certbot

```bash
apt install -y certbot python3-certbot-nginx
```

### 10.2 申请并自动配置

```bash
certbot --nginx -d example.com -d www.example.com
```

交互过程：

1. 输入邮箱（用于证书到期提醒）；
2. 同意条款输入 `Y`；
3. 是否订阅邮件，按需选 `N`；
4. 询问是否把 HTTP 请求重定向到 HTTPS，**选 2（Redirect）**。

certbot 会自动把证书路径写进 Nginx 配置并重载。
它同时会帮你加回之前注释掉的 301 跳转，所以第 8.3 步注释掉的内容不必手动恢复。

### 10.3 恢复配置一致性

certbot 修改后的 `/etc/nginx/sites-available/litesite` 里已经有了 443 段和跳转。
如果你之前注释掉了 443 段，现在 certbot 会重新写入，检查一遍：

```bash
nginx -t && systemctl reload nginx
```

### 10.4 验证自动续期

Let's Encrypt 证书有效期 90 天。certbot 会自动创建续期任务：

```bash
systemctl list-timers | grep certbot
certbot renew --dry-run        # 干跑一次，确认续期没问题
```

### 10.5 【重要】开启 Secure Cookie

有了 HTTPS 之后，回到 `.env` 打开安全开关，否则浏览器在 HTTPS 页面下会拒绝非 Secure 的 Cookie 策略：

```bash
nano /var/www/litesite/.env
# COOKIE_SECURE=true  （同时 NODE_ENV 必须是 production）
pm2 reload litesite --update-env
```

### 10.6 证书申请失败排查

| 报错 | 原因 | 解决 |
| --- | --- | --- |
| `Timeout during connect` | 80 端口没放行 / 云安全组未开 | 检查 `ufw status` 和云控制台安全组 |
| `Invalid response ... 301` | HTTP 段还在强制跳转 HTTPS | 按第 8.3 步注释掉跳转再试 |
| `DNS problem: NXDOMAIN` | 域名没解析到本机 | `ping 你的域名` 确认 IP 正确 |
| `too many failed authorizations` | 试太多次被限流 | 等 1 小时，或先用 `--dry-run` 测试 |

---

## 11. 一键部署脚本（可选）

项目自带 `deploy/deploy.sh`，把第 1~10 步里可自动化的部分串了起来（系统更新、Node、PM2、依赖、.env、启动、Nginx、防火墙），**并且是幂等的**，重复执行不会破坏已有数据。

```bash
cd /var/www/litesite
chmod +x deploy/deploy.sh
sudo ./deploy/deploy.sh
```

脚本会：

- 安装 Node 22 与 PM2，配置日志轮转
- 生成 `.env` 并自动填入随机 `SESSION_SECRET`（若 `.env` 已存在则不覆盖）
- 安装生产依赖并验证 `better-sqlite3` 可用
- 用 PM2 启动并设置开机自启
- 安装 Nginx 与配置片段（站点配置若是首次会复制，**已存在则不覆盖**，避免冲掉你的证书配置）
- 放行 22/80/443

脚本跑完后仍需手动完成三件事：

1. 编辑 `.env`：`SITE_URL`、`ADMIN_PASSWORD`
2. 编辑 `/etc/nginx/sites-available/litesite`：替换域名
3. 申请证书：`certbot --nginx -d 你的域名`

---

## 12. 部署验收清单

```bash
# 1. 进程状态：online，内存 < 100MB
pm2 status

# 2. 健康检查
curl -s http://127.0.0.1:3000/api/health

# 3. 前台可访问（应返回 HTML）
curl -sI https://你的域名 | head -n 1        # HTTP/2 200

# 4. 静态资源由 Nginx 返回，响应头里应有缓存策略
curl -sI https://你的域名/css/app.css | grep -i cache-control
# 期望：cache-control: public, max-age=2592000

# 5. 上传目录同样由 Nginx 托管
curl -sI https://你的域名/uploads/ | head -n 1

# 6. 安全响应头
curl -sI https://你的域名 | grep -iE 'strict-transport|content-security|x-frame'

# 7. 数据库文件不可通过 HTTP 访问（应返回 403 或 404）
curl -sI https://你的域名/data/litesite.db | head -n 1
```

最后，用浏览器打开 `https://你的域名/admin`，用 `.env` 里的账号登录，
**立刻到「安全设置」里修改密码**，然后逐项检查：主页信息、作品、博客、留言是否都能正常增删改。

---

## 13. 常见坑速查

| 现象 | 原因 | 解决 |
| --- | --- | --- |
| `pm2 status` 里 restart 次数一直涨 | 端口被占 / .env 语法错误 / 原生模块缺失 | `pm2 logs litesite --lines 50` 看报错 |
| 访问域名显示 Nginx 默认页 | 没删 `sites-enabled/default` | `rm -f /etc/nginx/sites-enabled/default && systemctl reload nginx` |
| 502 Bad Gateway | Node 没起来或端口不对 | `pm2 status`、`curl 127.0.0.1:3000/api/health` |
| 登录后台成功但一刷新就退出登录 | `COOKIE_SECURE=true` 但你在用 HTTP 访问 | 用 HTTPS 访问，或临时把 `COOKIE_SECURE` 设为 false |
| 上传图片报「图片太大」 | 超过 `UPLOAD_MAX_KB`，或 Nginx `client_max_body_size` 太小 | 同时调大 `.env` 的 `UPLOAD_MAX_KB` 与 nginx.conf 的 `client_max_body_size` |
| `npm ci` 报 better-sqlite3 编译失败 | 预编译包下载超时 | 见第 2 节的镜像配置 |
| 报 `Could not locate the bindings file` | **Node 版本低于 22**（没有对应 ABI 的预编译包），或预编译包没下下来 | 先 `node -v` 确认 >= 22，再配第 2 节的镜像 |
| 修改代码后页面没变 | 浏览器缓存了静态资源 | 强制刷新（Ctrl+F5）；静态资源缓存 30 天，是预期行为 |

---

## 14. 更新部署（以后每次改代码）

线上代码通过 Git 拉取。**不要直接在服务器上改源码**，否则下次拉取会冲突。

### 14.1 一次性配置（部署时做一遍）

在服务器上生成只读部署密钥：

```bash
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

ssh -T git@github.com          # 出现 Hi <用户名>/<仓库名>! 即成功

cd /var/www/litesite
git init -b main
git remote add origin git@github.com:<你的用户名>/litesite.git
git fetch origin
git reset --hard origin/main
git branch --set-upstream-to=origin/main main
```

`git reset --hard` 只覆盖被 Git 跟踪的文件；`.env`、`data/`、`node_modules/`、`public/uploads/` 都在 `.gitignore` 里，不受影响。

### 14.2 更新脚本

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

以后本地 `git push`，服务器执行 `/root/update.sh` 即可。

> 本地推送如果卡在连接 github.com，说明本机没走代理：
> `git config http.proxy http://127.0.0.1:7897`（端口按你自己的代理改），推送时保持代理开启。

### 14.3 重启范围对照

| 改动位置 | 需要做什么 |
| --- | --- |
| `public/` 下的 HTML | 不用重启，Nginx 直接读磁盘 |
| `public/` 下的 CSS / JS | 不用重启，但要在 HTML 引用处加版本号（`/js/app.js?v=2`），否则老访客 30 天缓存内拿到旧文件 |
| `src/**`、`server.js` | `pm2 reload litesite` |
| `.env` | `pm2 reload litesite --update-env` |
| `package.json`（新增依赖） | `npm ci --omit=dev` 后 `pm2 reload litesite` |
| `ecosystem.config.js` | `pm2 delete litesite && pm2 start ecosystem.config.js && pm2 save` |
| `deploy/nginx.conf` | 手动同步到 `/etc/nginx/sites-available/litesite`（把 `example.com` 换成你的域名）→ `nginx -t && systemctl reload nginx` |
| `src/db.js` 表结构 | 新增表会自动创建；**新增列不会**，需手动 `ALTER TABLE`，先备份 `data/litesite.db` |

### 14.4 数据库结构变更

`src/db.js` 用 `CREATE TABLE IF NOT EXISTS`，新增表会自动创建，新增列不会：

```bash
cp /var/www/litesite/data/litesite.db /root/db-backup-$(date +%F).db
sqlite3 /var/www/litesite/data/litesite.db "ALTER TABLE projects ADD COLUMN demo_url TEXT DEFAULT '';"
pm2 reload litesite
```

### 14.5 回滚

```bash
cd /var/www/litesite
git log --oneline -10
git reset --hard <上一个提交的哈希>
pm2 reload litesite
```

> **关于重启时的空窗**：`pm2 reload` 在 fork 单进程模式下是「先停后起」，约有 1 秒窗口。
> 由于站点配置里有 `error_page 500 502 503 504 /404.html;`，这一瞬的请求会看到 404 页，属于预期行为。
> 想让接口在这段时间返回明确的 503 JSON，在 `/etc/nginx/sites-available/litesite` 里加：
>
> ```nginx
> location @api_restarting {
>     default_type application/json;
>     return 503 '{"ok":false,"error":"服务正在重启，请稍后重试"}';
> }
> ```
>
> 并在 `location /api/ {` 内首行写 `error_page 500 502 503 504 = @api_restarting;`，然后 `nginx -t && systemctl reload nginx`。

---

## 15. 启用自动部署（可选，但推荐）

到这里为止，更新线上站点的流程是「本地 `git push`，再登服务器敲 `/root/update.sh`」。
如果连这一步都想省掉，可以让服务器自己轮询仓库：**push 之后 3 分钟内自动上线**。

### 15.1 一条命令启用

```bash
sudo -i
cd /var/www/litesite
git pull
bash deploy/enable-auto-deploy.sh 你的GitHub用户名
```

需要 root，因为要写 `/etc/cron.d` 下的 cron 文件。脚本是幂等的，重复执行不会重复安装。

它会依次做四件事：

1. 幂等写入 `.env` 的作品集配置（`PORTFOLIO_SOURCE=github`、`GITHUB_USERNAME=<参数>`、`GITHUB_MAX=12`、`GITHUB_CACHE_MINUTES=30`），已有同名键就原地覆盖，不会写出重复行
2. 自检服务器能否访问 `api.github.com`，并打印读到的仓库数，网络不通会直接提示
3. 安装 `/root/litesite-auto-deploy.sh` 与 `/etc/cron.d/litesite-auto-deploy`
4. 重启服务，并打印一次健康检查

装好之后会多出这三个文件：

| 路径 | 作用 |
| --- | --- |
| `/root/litesite-auto-deploy.sh` | 部署脚本本体，也可以手动执行一次 |
| `/etc/cron.d/litesite-auto-deploy` | cron 定义，每 3 分钟调用一次上面的脚本 |
| `/var/log/litesite-deploy.log` | 部署日志，超过 1 MB 自动只保留最后 2000 行 |

### 15.2 每次轮询做了什么

1. 用 `git ls-remote` 取远端分支的提交号（约 1 KB）与本地比对，一致就静默退出
2. 只有真有新提交才 `git fetch`，然后备份数据库，只保留最近 10 份
3. `git reset --hard <远端提交号>`
4. 仅当 `package.json` / `package-lock.json` 发生变化时才 `npm ci --omit=dev`
5. `pm2 reload litesite --update-env`
6. 最后跑一次健康检查

两个关键取舍：

- **失败不落地**：任何一步出错都不会执行 `git reset` 与 `pm2 reload`，线上继续跑旧版本。一次失败的部署最多是「更新没生效」，不会把站点搞挂
- **`flock` 串行化**：上一轮还没跑完时，下一轮直接退出，不会出现两个部署脚本同时改工作区

> ⚠️ 服务器上的 `/var/www/litesite` 是**部署目标，不是开发环境**。脚本用 `git reset --hard <远端提交号>`
> 对齐代码，所以任何直接在服务器上改的源码都会在下一轮被覆盖。要改代码请在本地改、提交、push。
> `.env`、`data/`、`node_modules/`、`public/uploads/` 都在 `.gitignore` 里，不受影响。

### 15.3 查看与排错

```bash
# 实时看部署日志
tail -f /var/log/litesite-deploy.log

# 不想等 3 分钟，手动触发一轮
/root/litesite-auto-deploy.sh

# cron 服务本身是否在跑
systemctl status cron

# 工作区停在哪次提交、有没有被改脏
git -C /var/www/litesite log --oneline -3
git -C /var/www/litesite status --short

# 作品集抓取状态（在本地电脑上也能看，不用登服务器）
curl -s https://你的域名/api/health
```

常见现象对照：

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 日志里完全没有新记录 | cron 没生效 | `systemctl status cron`；确认 `/etc/cron.d/litesite-auto-deploy` 存在且权限是 `644` |
| 每轮都提示没有新提交 | 远端分支不叫 `main`，或者确实还没推新提交 | `git -C /var/www/litesite log --oneline -3`，和 GitHub 上的最新提交对一下 |
| 日志里 `npm ci` 被杀 | 1G 内存装依赖时触发 OOM Killer | 按本文 1.3 节给机器加 1GB Swap，或改用手动 `/root/update.sh` |
| 更新成功但页面没变 | 浏览器缓存了旧的静态资源 | 在 HTML 引用处加版本号（`/js/app.js?v=2`），见 14.3 |
| 作品集是空的 | GitHub 抓取失败，或用户名写错 | `curl -s http://127.0.0.1:3000/api/health` 看 `portfolio.error` |

### 15.4 关闭自动部署

```bash
rm /etc/cron.d/litesite-auto-deploy
```

删掉 cron 文件即可，`/root/litesite-auto-deploy.sh` 留着不影响任何东西（想彻底清理可以一并删掉）。
关闭后回到 14.2 的手动流程，两种方式不冲突，随时可以再启用。

> **为什么是「服务器定时拉」而不是「GitHub Actions 推」**
>
> 推模式需要给 GitHub 开放入站 SSH，或者把私钥放进仓库 Secrets，还要应对 GCP OS Login 的配置差异。
> 拉模式直接复用部署时已经配好的**只读 Deploy Key**：服务器不需要接受任何入站连接，也不需要额外凭据，
> 暴露面更小。代价是更新最多延迟一个轮询周期（3 分钟），对个人站完全可以接受。
