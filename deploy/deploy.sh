#!/usr/bin/env bash
# =====================================================================
#  litesite 一键部署脚本（Ubuntu 22.04 / 24.04，Debian 12 亦可）
# ---------------------------------------------------------------------
#  它会依次完成：
#    1. 系统更新与基础依赖
#    2. 安装 Node.js 22 LTS 与 PM2
#    3. 安装依赖（只装生产依赖）
#    4. 准备 .env 与数据目录
#    5. 用 PM2 启动并设置开机自启
#    6. 可选：安装并配置 Nginx
#
#  用法（在项目目录内执行）：
#    chmod +x deploy/deploy.sh
#    sudo ./deploy/deploy.sh
#
#  脚本是幂等的，重复执行不会破坏已有数据。
# =====================================================================
set -euo pipefail

APP_NAME="litesite"
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE_USER="${SUDO_USER:-$(whoami)}"
NODE_MAJOR=22

info()  { printf '\033[1;36m[%s]\033[0m %s\n' "$(date +%H:%M:%S)" "$1"; }
warn()  { printf '\033[1;33m[警告]\033[0m %s\n' "$1"; }
fail()  { printf '\033[1;31m[错误]\033[0m %s\n' "$1" >&2; exit 1; }

[[ $EUID -eq 0 ]] || fail "请用 sudo 执行本脚本（需要安装系统包）。"

# ---------------------------------------------------------------------
# 1. 系统更新与基础依赖
# ---------------------------------------------------------------------
info "更新 apt 索引并安装基础依赖"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl ca-certificates gnupg build-essential python3 sqlite3 git ufw

# ---------------------------------------------------------------------
# 2. Node.js 22 LTS
#    better-sqlite3 v12 只提供 Node 22+（ABI node-v127 及以上）的预编译包，
#    用 Node 20 会下载不到预编译文件并回退到本地编译。
# ---------------------------------------------------------------------
if command -v node >/dev/null 2>&1 && [[ "$(node -v | sed 's/v\([0-9]*\).*/\1/')" -ge "$NODE_MAJOR" ]]; then
  info "已安装 Node $(node -v)，跳过"
else
  info "安装 Node.js ${NODE_MAJOR}.x LTS（NodeSource 源）"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y nodejs
fi
[[ "$(node -v | sed 's/v\([0-9]*\).*/\1/')" -ge 22 ]] \
  || fail "Node 版本过低（$(node -v)），本项目需要 Node >= 22"

# ---------------------------------------------------------------------
# 3. PM2 + 日志轮转
# ---------------------------------------------------------------------
if ! command -v pm2 >/dev/null 2>&1; then
  info "全局安装 PM2"
  npm install -g pm2
fi

info "配置 PM2 日志轮转（防止日志把磁盘写满）"
pm2 install pm2-logrotate >/dev/null 2>&1 || warn "pm2-logrotate 安装失败，可稍后手动执行：pm2 install pm2-logrotate"
pm2 set pm2-logrotate:max_size 10M   >/dev/null 2>&1 || true
pm2 set pm2-logrotate:retain 7       >/dev/null 2>&1 || true
pm2 set pm2-logrotate:compress true  >/dev/null 2>&1 || true

# ---------------------------------------------------------------------
# 4. 项目依赖与目录
# ---------------------------------------------------------------------
cd "$APP_DIR"
info "项目目录：$APP_DIR"

mkdir -p data logs public/uploads
chown -R "$SERVICE_USER":"$SERVICE_USER" data logs public/uploads 2>/dev/null || true

if [[ ! -f .env ]]; then
  info "生成 .env（基于 .env.example）"
  cp .env.example .env
  SECRET="$(openssl rand -hex 32 2>/dev/null || head -c 32 /dev/urandom | xxd -p | tr -d '\n')"
  sed -i "s|^SESSION_SECRET=.*|SESSION_SECRET=${SECRET}|" .env
  chmod 600 .env
  warn "请立即编辑 .env：修改 ADMIN_PASSWORD、SITE_URL，并把 COOKIE_SECURE 设为 true（配好 HTTPS 之后）"
else
  info ".env 已存在，保持不变"
fi

info "安装生产依赖（跳过 devDependencies，节省磁盘与内存）"
# 原生模块的预编译包走国内镜像，避免直连 GitHub 超时后回退到本地编译（1G 机器编译很吃力）
export npm_config_better_sqlite3_binary_host_mirror="https://registry.npmmirror.com/-/binary/better-sqlite3"
if [[ -f package-lock.json ]]; then
  npm ci --omit=dev --no-audit --no-fund
else
  npm install --omit=dev --no-audit --no-fund
fi

# better-sqlite3 是原生模块，验证一下能否正常加载
info "校验原生模块与数据库初始化"
node -e "require('better-sqlite3'); console.log('better-sqlite3 加载正常')" \
  || fail "better-sqlite3 加载失败：先确认 Node >= 22（node -v），或安装 build-essential 后执行 npm rebuild better-sqlite3 --build-from-source"
node src/seed.js

# ---------------------------------------------------------------------
# 5. PM2 启动 + 开机自启
# ---------------------------------------------------------------------
info "启动 / 重启 PM2 进程"
if pm2 describe "$APP_NAME" >/dev/null 2>&1; then
  pm2 reload ecosystem.config.js --update-env
else
  pm2 start ecosystem.config.js
fi
pm2 save

info "配置开机自启（生成 systemd 服务）"
env PATH="$PATH:$(dirname "$(command -v node)")" pm2 startup systemd -u "$SERVICE_USER" --hp "$(getent passwd "$SERVICE_USER" | cut -d: -f6)" >/dev/null 2>&1 \
  && info "已生成 pm2-${SERVICE_USER} 服务" \
  || warn "开机自启配置失败，请手动执行：pm2 startup 并按其提示操作"

# ---------------------------------------------------------------------
# 6. Nginx（可选）
# ---------------------------------------------------------------------
if [[ "${INSTALL_NGINX:-yes}" == "yes" ]]; then
  info "安装 Nginx"
  apt-get install -y nginx
  install -m 644 deploy/proxy_params_litesite.conf /etc/nginx/proxy_params_litesite

  if [[ ! -f /etc/nginx/sites-available/litesite ]]; then
    install -m 644 deploy/nginx.conf /etc/nginx/sites-available/litesite
    ln -sf /etc/nginx/sites-available/litesite /etc/nginx/sites-enabled/litesite
    [[ -e /etc/nginx/sites-enabled/default ]] && rm -f /etc/nginx/sites-enabled/default
    warn "请编辑 /etc/nginx/sites-available/litesite，把 example.com 换成你的真实域名，然后执行："
    warn "  nginx -t && systemctl reload nginx"
  else
    info "Nginx 站点配置已存在，未覆盖（避免冲掉你的域名与证书配置）"
  fi
fi

# ---------------------------------------------------------------------
# 7. 防火墙
# ---------------------------------------------------------------------
if command -v ufw >/dev/null 2>&1; then
  info "放行 22 / 80 / 443（Node 的 3000 端口只监听 127.0.0.1，无需对外开放）"
  ufw allow 22/tcp  >/dev/null 2>&1 || true
  ufw allow 80/tcp  >/dev/null 2>&1 || true
  ufw allow 443/tcp >/dev/null 2>&1 || true
  ufw --force enable >/dev/null 2>&1 || true
  ufw status | head -n 12
fi

# ---------------------------------------------------------------------
# 完成
# ---------------------------------------------------------------------
echo
info "部署完成。接下来请："
cat <<'NEXT'
  1. 编辑 .env：设置 SITE_URL、ADMIN_PASSWORD（首次初始化数据库时生效）
  2. 编辑 /etc/nginx/sites-available/litesite，把 example.com 换成你的域名
  3. nginx -t && systemctl reload nginx
  4. 申请 HTTPS 证书：
       apt-get install -y certbot python3-certbot-nginx
       certbot --nginx -d example.com -d www.example.com
     证书就位后，把 .env 的 COOKIE_SECURE 改为 true，再 pm2 reload litesite
  5. 查看状态：
       pm2 status
       pm2 logs litesite --lines 50
       curl -s http://127.0.0.1:3000/api/health
  6. 登录后台修改密码：https://你的域名/admin
NEXT
