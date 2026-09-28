# 运维与排错指南

面向 2 核 1G 的机器。所有命令假设项目在 `/var/www/litesite`，PM2 进程名 `litesite`。

---

## 一、巡检命令速查

```bash
# 进程状态（内存、CPU、重启次数）
pm2 status

# 实时资源监视（q 退出）
pm2 monit

# 最近 100 行日志
pm2 logs litesite --lines 100

# 服务自检（含进程内存）
curl -s http://127.0.0.1:3000/api/health

# 系统内存与 Swap
free -h

# 占用内存最高的 10 个进程
ps aux --sort=-%mem | head -n 11

# 磁盘
df -h

# Nginx 状态
systemctl status nginx --no-pager
```

### 正常状态的参考值

| 指标 | 正常范围 | 说明 |
| --- | --- | --- |
| `pm2 status` 里的 mem | 55 ~ 85 MB | 超过 120MB 就该查了 |
| `pm2 status` 里的 ↺（重启次数） | 长期稳定不涨 | 缓慢上涨说明有内存泄漏或崩溃 |
| `free -h` 的 available | > 200 MB | 低于 100MB 需要干预 |
| `free -h` 的 Swap used | 0 ~ 200 MB | 持续接近 1GB 说明物理内存不够用了 |
| CPU | 空闲时接近 0% | 个人站正常几乎不耗 CPU |

---

## 二、查看内存占用（三种口径，别混用）

```bash
# 口径 1：PM2 面板，最直观
pm2 status
pm2 describe litesite | grep -E 'memory|restarts|uptime|status'

# 口径 2：应用自报（V8 视角的 RSS 与堆）
curl -s http://127.0.0.1:3000/api/health
# {"ok":true,"uptime":86400,"rssMB":64.2,"heapMB":10.1}

# 口径 3：系统视角的进程实际占用
ps -o pid,rss,%mem,cmd -C node
# 注意：rss 单位是 KB，除以 1024 得到 MB
```

**怎么解读**：

- `heapMB` 是 V8 堆使用量，**它才是业务代码真正占用的内存**。这个值在 10MB 左右，说明代码本身极其轻。
- `rssMB` 是进程常驻内存，包含 Node 运行时、V8、原生模块（SQLite）。这部分有 50MB 左右的"地板"，无法再降。
- 两个值加起来才对得上系统看到的内存。

`--max-old-space-size=96` 限制的是 **堆**（heap），不是 RSS。所以堆一直很稳，RSS 也不会失控。

---

## 三、日志查看

### 3.1 应用日志（PM2）

```bash
# 实时跟随
pm2 logs litesite

# 最近 200 行且不跟随（排查完就走）
pm2 logs litesite --lines 200 --nostream

# 只看错误日志
pm2 logs litesite --err --lines 200 --nostream

# 直接看文件（日志文件位置见 ecosystem.config.js）
tail -n 200 /var/www/litesite/logs/err.log
tail -f /var/www/litesite/logs/out.log

# 清空日志（磁盘紧张时）
pm2 flush litesite
```

### 3.2 日志轮转（务必确认已配置）

PM2 默认**不切割日志**，跑几个月能把磁盘写满。确认轮转模块已安装：

```bash
pm2 list | grep logrotate        # 应该能看到 pm2-logrotate 模块
# 如果没有：
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 10M
pm2 set pm2-logrotate:retain 7
pm2 set pm2-logrotate:compress true
```

### 3.3 Nginx 日志

```bash
tail -f /var/log/nginx/access.log          # 访问日志
tail -f /var/log/nginx/error.log           # 错误日志（502 一般都在这）
grep ' 502 ' /var/log/nginx/access.log | tail -n 20
```

### 3.4 系统日志（查 OOM Killer 必用）

```bash
# 内核有没有杀过进程
dmesg -T | grep -iE 'killed process|out of memory' | tail -n 20

# 持久化的系统日志
journalctl -k --since "2 hours ago" | grep -i oom
```

---

## 四、服务重启与生命周期管理

```bash
cd /var/www/litesite

pm2 restart litesite              # 硬重启（中断连接）
pm2 reload litesite               # 平滑重载（本项目单进程，效果等同重启但更温和）
pm2 reload litesite --update-env  # 改了 .env 之后必须带这个参数才会生效
pm2 stop litesite                 # 停止
pm2 delete litesite               # 从 PM2 列表移除
pm2 start ecosystem.config.js     # 重新拉起
pm2 save                          # 保存进程列表（务必在改动后执行）
pm2 resurrect                     # 从保存的列表恢复
```

**改了哪些东西需要做什么：**

| 改动 | 需要的操作 |
| --- | --- |
| `.env`（端口、密钥、站点信息、上传限制） | `pm2 reload litesite --update-env` |
| `ecosystem.config.js`（内存限制等） | `pm2 delete litesite && pm2 start ecosystem.config.js && pm2 save` |
| 服务端代码 `server.js` / `src/**` | `pm2 reload litesite` |
| 前端静态文件 `public/**` | 无需重启（直接在浏览器强制刷新即可） |
| Nginx 配置 | `nginx -t && systemctl reload nginx` |

---

## 五、重置管理员密码

### 方法 A：用项目自带的脚本（推荐）

```bash
cd /var/www/litesite
npm run reset-password -- admin 新的强密码
```

输出 `✓ 账号 "admin" 的密码已重置` 即成功。**无需重启服务**，旧登录会话会自动失效。

交互模式（不想在命令里暴露密码）：

```bash
npm run reset-password
# 按提示输入账号与新密码
```

### 方法 B：交互式直接写库

```bash
cd /var/www/litesite
node -e "
const bcrypt=require('bcryptjs');
const db=require('better-sqlite3')('data/litesite.db');
const hash=bcrypt.hashSync('新的强密码',10);
const r=db.prepare('UPDATE users SET password_hash=? WHERE username=?').run(hash,'admin');
console.log('受影响行数:', r.changes);
"
```

### 方法 C：登录被限流封禁了怎么办

连续输错密码会触发防爆破封禁（默认 15 分钟）。限流状态存在**内存**里，重启即清空：

```bash
pm2 reload litesite
```

或者干脆等封禁时间过去（接口会返回剩余秒数）。

### 修改账号名

```bash
cd /var/www/litesite
node -e "
const db=require('better-sqlite3')('data/litesite.db');
db.prepare('UPDATE users SET username=? WHERE username=?').run('新账号','admin');
console.log('已修改');
"
pm2 reload litesite
```

---

## 六、备份与恢复

需要备份的只有三样：**数据库文件、上传目录、配置文件**。

### 6.1 手动备份

```bash
mkdir -p /var/backups/litesite
STAMP=$(date +%F_%H%M)

# 数据库：用 sqlite3 的 .backup 生成一致性快照（不要直接 cp 正在写入的库）
sqlite3 /var/www/litesite/data/litesite.db ".backup '/var/backups/litesite/db_$STAMP.db'"

# 上传的图片
tar -czf /var/backups/litesite/uploads_$STAMP.tar.gz -C /var/www/litesite/public uploads

# 配置
tar -czf /var/backups/litesite/config_$STAMP.tar.gz \
    -C /var/www/litesite .env ecosystem.config.js \
    && cp /etc/nginx/sites-available/litesite /var/backups/litesite/nginx_$STAMP.conf

ls -lh /var/backups/litesite/
```

### 6.2 自动备份（每天凌晨 4 点，保留 30 天）

```bash
cat > /usr/local/bin/litesite-backup.sh <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
DEST=/var/backups/litesite
STAMP=$(date +%F_%H%M)
mkdir -p "$DEST"
sqlite3 /var/www/litesite/data/litesite.db ".backup '$DEST/db_$STAMP.db'"
gzip -f "$DEST/db_$STAMP.db"
tar -czf "$DEST/uploads_$STAMP.tar.gz" -C /var/www/litesite/public uploads
# 清理 30 天前的备份
find "$DEST" -type f -mtime +30 -delete
echo "[$(date '+%F %T')] backup done: $STAMP"
EOF

chmod +x /usr/local/bin/litesite-backup.sh
/usr/local/bin/litesite-backup.sh          # 先手动跑一次确认没报错

# 加入 crontab
( crontab -l 2>/dev/null; echo "0 4 * * * /usr/local/bin/litesite-backup.sh >> /var/log/litesite-backup.log 2>&1" ) | crontab -
crontab -l
```

### 6.3 恢复

```bash
cd /var/www/litesite
pm2 stop litesite

# 恢复数据库
cp /var/backups/litesite/db_2025-01-01_0400.db.gz /tmp/ && gunzip -f /tmp/db_2025-01-01_0400.db.gz
cp /tmp/db_2025-01-01_0400.db data/litesite.db
rm -f data/litesite.db-wal data/litesite.db-shm    # 清掉 WAL 残留，避免与新库不一致

# 恢复图片
tar -xzf /var/backups/litesite/uploads_2025-01-01_0400.tar.gz -C public/

pm2 start litesite
curl -s http://127.0.0.1:3000/api/health
```

---

## 七、内存过高怎么处理

先判断是不是真的高。个人站空载 RSS 应该在 **60MB 上下**，持续超过 **120MB** 才算异常。

### 第一步：现场取证

```bash
pm2 status                                  # 看 mem 与 ↺ 次数
curl -s http://127.0.0.1:3000/api/health    # 看 rssMB / heapMB
free -h                                     # 看系统是否真的吃紧
ps aux --sort=-%mem | head -n 11            # 确认不是别的进程在吃内存
dmesg -T | grep -i 'killed process' | tail  # 确认内核有没有杀过进程
```

### 第二步：按现象对照原因

| 现象 | 可能原因 | 处理 |
| --- | --- | --- |
| RSS 稳步上涨，几天涨到 200MB+ | 内存泄漏（通常是反复累积的缓存或事件监听） | 先 `pm2 reload litesite` 恢复服务，再按第三步定位 |
| RSS 突然冲高然后进程重启 | 单次请求体过大 / 有人上传超大文件 | 检查 Nginx `client_max_body_size` 与 `.env` 的 `UPLOAD_MAX_KB` |
| `↺` 次数持续增长，日志无异常 | PM2 触发了 `max_memory_restart`（这正是它该干的事） | 说明 150M 阈值太紧或确实有泄漏，看第三步 |
| `free -h` 显示 available 很低，但 Node 只占 60MB | **是别的进程在吃内存**（MySQL、Docker、面板程序…） | `ps aux --sort=-%mem | head` 找出真凶；1G 机器上不要同时跑 MySQL、Docker 与面板 |
| 系统频繁使用 Swap | 物理内存不够 | 加 Swap（见 DEPLOY 第 1.3 节）或升级配置 |

### 第三步：定位泄漏（如果确实在涨）

```bash
# 1. 记录基线
curl -s http://127.0.0.1:3000/api/health

# 2. 反复打高频接口（把 <你的域名> 换成实际地址，本机测试用 127.0.0.1）
for i in $(seq 1 500); do curl -s http://127.0.0.1:3000/api/site > /dev/null; done

# 3. 再看一次
curl -s http://127.0.0.1:3000/api/health
```

**判定标准**：500 次请求后 RSS 增长应该在 5MB 以内，且之后不再继续涨（V8 会回收）。
项目在开发机上实测 300 次请求后增长 2.9MB，属于正常波动。

如果确实持续上涨：

```bash
# 常见元凶 1：日志写爆了内存缓冲（极少见，但先看日志大小）
du -sh /var/www/litesite/logs/

# 常见元凶 2：内存限流表被海量 IP 撑大（已内置 5000 键上限 + 定期清理，一般不会）
# 常见元凶 3：把大文件读进了内存（检查是否有人改了上传逻辑为 memoryStorage）
grep -rn "memoryStorage" /var/www/litesite/src/ || echo "未使用内存存储，正常"

# 最后手段：重启并观察是否能稳定
pm2 reload litesite
```

### 第四步：收紧护栏（临时应急）

如果暂时没空排查，先把阈值调紧，让它自动重启而不是拖死整台机器：

```bash
cd /var/www/litesite
nano ecosystem.config.js
#   node_args: '--max-old-space-size=64'
#   max_memory_restart: '110M'
pm2 delete litesite && pm2 start ecosystem.config.js && pm2 save
```

> 注意：把阈值设得过低会导致频繁重启（重启是有成本的），建议 100~150M 之间。

### 根治性的架构手段

1. **确保静态资源真的由 Nginx 托管**。检查 `.env` 里 `SERVE_STATIC=false`，
   并确认 `curl -I https://你的域名/css/app.css` 的响应头里有 `cache-control`（说明是 Nginx 返回的）。
   如果静态文件还在走 Node，每张图片、每个 CSS 都会占用 Node 的缓冲内存。
2. **限制上传体积**。图片建议先压缩到 300KB 以内，`.env` 的 `UPLOAD_MAX_KB` 保持 2048 或更低。
3. **不要在这台机器上再装 MySQL / Redis / Docker / 面板程序**。这是 1G 内存机器最容易被忽视的杀手。

---

## 八、服务自动退出 / 反复重启怎么处理

### 第一步：判断是谁杀的

```bash
pm2 status          # 看 status、↺ 次数、uptime
pm2 logs litesite --err --lines 80 --nostream
dmesg -T | grep -iE 'killed process|out of memory' | tail -n 20
```

**关键区分**：

| 证据 | 结论 |
| --- | --- |
| `dmesg` 里有 `Killed process ... (node)` | **被内核 OOM Killer 杀的**，属于内存问题，见第七节 |
| `↺` 次数在涨但 `dmesg` 干净 | PM2 因超过 `max_memory_restart` 主动重启，或进程自身崩溃 |
| 日志里有 `Error:` / `throw` 堆栈 | 代码抛错导致进程退出，按堆栈修 |
| 日志里有 `EADDRINUSE` | 3000 端口被占用（可能有两个实例） |
| 日志里什么都没有就退出了 | 手动 `node server.js` 前台运行，亲眼看到报错 |

### 第二步：查看退出码

```bash
pm2 describe litesite | grep -iE 'exit|restart|status|uptime'
```

| 退出码 | 含义 | 处理 |
| --- | --- | --- |
| `0` | 正常退出（收到 SIGTERM 或被 stop） | 一般无需处理 |
| `1` | 未捕获异常 | 看 `logs/err.log` 的堆栈 |
| `137` | 被 SIGKILL 杀死（128+9） | 几乎可以确定是 OOM，见第七节 |
| `143` | 收到 SIGTERM（128+15） | 部署脚本或 `pm2 reload` 导致，正常 |

### 第三步：手动前台运行定位

PM2 会吞掉一些早期错误。停掉 PM2 手动跑一次，报错会直接打在屏幕上：

```bash
pm2 stop litesite
cd /var/www/litesite
node server.js
# 观察输出，Ctrl+C 结束
```

常见输出与对策：

| 输出 | 原因 | 解决 |
| --- | --- | --- |
| `Cannot find module 'better-sqlite3'` | 依赖没装 | `npm ci --omit=dev` |
| `Could not locate the bindings file` | **Node 版本低于 22**（无对应 ABI 的预编译包），或预编译包没下载成功 | 先 `node -v` 确认 >= 22；再配镜像后 `npm rebuild better-sqlite3`，仍失败则 `npm rebuild better-sqlite3 --build-from-source`（需 build-essential，先加好 Swap） |
| `EADDRINUSE :::3000` | 端口被占 | `lsof -i:3000` 找到进程并结束，或改 `.env` 的 PORT |
| `SQLITE_CANTOPEN` | `data/` 目录不存在或权限不对 | `mkdir -p data && chown -R $USER data` |
| `EACCES` 写上传目录 | `public/uploads` 权限不对 | `chown -R $USER public/uploads` |
| `SESSION_SECRET 未设置` 警告 | `.env` 没配密钥 | 补上 `SESSION_SECRET`，否则每次重启都要重新登录 |

定位完成后：

```bash
pm2 start ecosystem.config.js
pm2 save
```

### 第四步：防止"反复重启把日志刷爆"

`ecosystem.config.js` 里已经配置了：

```js
max_restarts: 10,      // 60 秒内最多重启 10 次
min_uptime: '20s',     // 存活不足 20 秒不算启动成功
restart_delay: 3000,   // 每次重启间隔 3 秒
```

如果超过上限，PM2 会把状态标记为 `errored` 并停止尝试。这时**不要再无脑 `pm2 restart`**，
一定要先按第三步找到根因。

---

## 九、可选：一个极简的监控告警脚本

1G 的机器不需要 Prometheus。一个 cron 脚本足够。

```bash
cat > /usr/local/bin/litesite-watch.sh <<'EOF'
#!/usr/bin/env bash
# 每 5 分钟检查一次：服务是否存活、内存是否超标、磁盘是否将满
set -uo pipefail
LOG=/var/log/litesite-watch.log
STAMP=$(date '+%F %T')

# 1. 服务存活（走 HTTP，比看进程更真实）
if ! curl -sf --max-time 5 http://127.0.0.1:3000/api/health > /tmp/ls_health.json; then
    echo "$STAMP [严重] 服务无响应，正在重启" >> "$LOG"
    pm2 restart litesite >> "$LOG" 2>&1
    exit 0
fi

RSS=$(grep -o '"rssMB":[0-9.]*' /tmp/ls_health.json | cut -d: -f2)
AVAIL=$(free -m | awk '/^Mem:/ {print $7}')
DISK=$(df / | awk 'NR==2 {print $5}' | tr -d '%')

# 2. 内存阈值（MB）
if [ "${RSS%.*}" -gt 130 ]; then
    echo "$STAMP [警告] Node RSS=${RSS}MB 超过 130MB" >> "$LOG"
fi
if [ "$AVAIL" -lt 80 ]; then
    echo "$STAMP [警告] 系统可用内存仅 ${AVAIL}MB" >> "$LOG"
fi
# 3. 磁盘（%）
if [ "$DISK" -gt 85 ]; then
    echo "$STAMP [警告] 根分区已用 ${DISK}%" >> "$LOG"
fi

# 4. 日志超过 5MB 就轮转（PM2 的 logrotate 之外再兜一层）
for f in /var/www/litesite/logs/*.log; do
    [ -f "$f" ] || continue
    SIZE=$(stat -c%s "$f")
    if [ "$SIZE" -gt 5242880 ]; then
        mv "$f" "$f.$(date +%s)" && gzip -f "$f".* 2>/dev/null
        echo "$STAMP [信息] 已轮转 $f" >> "$LOG"
    fi
done

# 只保留最近 500 行记录
tail -n 500 "$LOG" > "$LOG.tmp" 2>/dev/null && mv "$LOG.tmp" "$LOG"
EOF

chmod +x /usr/local/bin/litesite-watch.sh
( crontab -l 2>/dev/null; echo "*/5 * * * * /usr/local/bin/litesite-watch.sh" ) | crontab -
```

查看告警记录：

```bash
tail -n 50 /var/log/litesite-watch.log
```

---

## 十、安全加固清单

| 项目 | 状态 | 说明 |
| --- | --- | --- |
| 密码 bcrypt 存储 | 内置 | 10 轮哈希，数据库里看不到明文 |
| 登录防爆破 | 内置 | 默认 5 次失败封禁 15 分钟，可按 `.env` 调整 |
| 会话安全 | 内置 | HMAC 签名 + httpOnly + SameSite=Lax，改密码即踢掉全部旧会话 |
| 上传类型白名单 | 内置 | 只允许 jpg/png/webp/gif/svg，随机文件名防路径穿越 |
| 请求体体积限制 | 内置 | 默认 128KB，防大 body 撑爆内存 |
| 安全响应头 | 内置 | CSP、X-Frame-Options、HSTS（HTTPS 下） |
| 数据库文件不可下载 | 内置 | Nginx 层已拒绝 `.db` / `data/` 路径 |
| 后台不被搜索引擎收录 | 内置 | `/admin` 与 `/api` 返回 `X-Robots-Tag: noindex` |
| SSH 禁止密码登录 | **建议手动做** | 改用密钥登录，能挡掉 99% 的爆破 |
| 自动安全更新 | **建议手动做** | `apt install unattended-upgrades` |
| fail2ban 防 SSH 爆破 | **建议手动做** | `apt install fail2ban` |

手动加固示例：

```bash
# 1. 改用 SSH 密钥登录（先在本地把公钥传上去再操作，不要把自己锁在外面）
# 本地执行：ssh-copy-id root@你的服务器IP
nano /etc/ssh/sshd_config
#   PasswordAuthentication no
#   PermitRootLogin prohibit-password
systemctl restart ssh

# 2. 自动安全更新
apt install -y unattended-upgrades
dpkg-reconfigure -plow unattended-upgrades

# 3. fail2ban
apt install -y fail2ban
systemctl enable --now fail2ban
fail2ban-client status sshd
```

> 注意：fail2ban 与 unattended-upgrades 都会常驻少量内存（各约 10~20MB），
> 1G 的机器上可以接受，但如果你还装了 MySQL 或 Docker，就要重新权衡了。

---

## 十一、故障速查总表

| 症状 | 最可能的原因 | 一条命令定位 |
| --- | --- | --- |
| 网站打不开，502 | Node 挂了 | `pm2 logs litesite --err --lines 50 --nostream` |
| 网站打不开，Nginx 默认页 | 默认站点没删 | `ls /etc/nginx/sites-enabled/` |
| 图片不显示 | uploads 目录权限 / Nginx alias 路径错 | `ls -l /var/www/litesite/public/uploads` |
| 上传图片报 413 | Nginx `client_max_body_size` 太小 | `grep client_max_body_size /etc/nginx/sites-available/litesite` |
| 后台登录后刷新就退出 | `COOKIE_SECURE` 与访问协议不匹配 | `grep COOKIE_SECURE /var/www/litesite/.env` |
| 密码对了但提示错误 | 被限流封禁 | 看返回的剩余秒数，或 `pm2 reload litesite` |
| 页面样式全乱 | Tailwind CDN 被墙 / 被 CSP 拦 | 浏览器 F12 看 Console 与 Network |
| 改了 `.env` 没生效 | 没带 `--update-env` | `pm2 reload litesite --update-env` |
| 磁盘满了 | 日志或备份堆积 | `du -sh /var/log /var/backups /var/www/litesite/logs` |
| 时间不对 | 时区未设置 | `timedatectl set-timezone Asia/Shanghai` |
| 证书过期告警 | 自动续期没生效 | `certbot renew --dry-run` |
