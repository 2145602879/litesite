#!/bin/bash
# ============================================================
#  一次性设置：作品集数据源 + 自动部署
#
#  用法（服务器上、root 身份）：
#    bash /var/www/litesite/deploy/enable-auto-deploy.sh <GitHub用户名>
#  例：
#    bash /var/www/litesite/deploy/enable-auto-deploy.sh 2145602879
#
#  会做四件事：
#    1. 把作品集数据源写进 .env（幂等，重复执行只会更新值）
#    2. 自检服务器能否访问 GitHub API，并打印读到的公开仓库数
#    3. 安装 /root/litesite-auto-deploy.sh 与每 3 分钟一次的 cron
#    4. 重启服务并打印健康检查结果
# ============================================================
set -uo pipefail

APP_DIR=/var/www/litesite
ENV_FILE="$APP_DIR/.env"
USERNAME="${1:-}"
CRON_FILE=/etc/cron.d/litesite-auto-deploy
AUTO_SCRIPT=/root/litesite-auto-deploy.sh

if [ "$(id -u)" != "0" ]; then
  echo "请用 root 身份运行：先执行 sudo -i，再运行本脚本" >&2
  exit 1
fi

if [ -z "$USERNAME" ]; then
  echo "用法：bash $0 <GitHub用户名>" >&2
  exit 1
fi

if [ ! -f "$ENV_FILE" ]; then
  echo "找不到 $ENV_FILE（请先把 .env 配好）" >&2
  exit 1
fi

cd "$APP_DIR" || exit 1

# ---------- 1. 写入 .env（幂等）----------
set_env() {
  local key="$1" value="$2"
  if grep -qE "^${key}=" "$ENV_FILE"; then
    sed -i "s|^${key}=.*|${key}=${value}|" "$ENV_FILE"
  else
    printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"
  fi
  echo "   已设置 $key=$value"
}

echo "-> 写入作品集配置到 .env"
set_env PORTFOLIO_SOURCE github
set_env GITHUB_USERNAME "$USERNAME"
set_env GITHUB_MAX 12
set_env GITHUB_CACHE_MINUTES 30

# ---------- 2. 连通性自检 ----------
echo "-> 自检：服务器能否访问 api.github.com"
UA='User-Agent: litesite-setup'
if curl -sf --max-time 12 -H "$UA" \
     "https://api.github.com/users/${USERNAME}" >/dev/null 2>&1; then
  COUNT=$(curl -s --max-time 12 -H "$UA" \
            "https://api.github.com/users/${USERNAME}/repos?per_page=100&type=owner" \
          | grep -o '"full_name"' | wc -l)
  echo "   可以访问，读到 ${COUNT} 个仓库（含私有的话需要配 GITHUB_TOKEN）"
else
  echo "   !! 访问失败：作品集会回退到后台手动录入的数据。"
  echo "      如果服务器需要走代理才能访问 GitHub，请在这里配置后再重试。"
fi

# ---------- 3. 安装自动部署 ----------
echo "-> 安装自动部署脚本"
if [ ! -f "$APP_DIR/deploy/auto-deploy.sh" ]; then
  echo "   找不到 deploy/auto-deploy.sh，请先 git pull 拉取最新代码" >&2
  exit 1
fi
install -m 755 "$APP_DIR/deploy/auto-deploy.sh" "$AUTO_SCRIPT"
echo "   $AUTO_SCRIPT"

echo "-> 安装 cron（每 3 分钟检查一次新提交）"
cat > "$CRON_FILE" <<'EOF'
# litesite 自动部署：每 3 分钟检查远端是否有新提交，有就拉取并平滑重启
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
*/3 * * * * root /root/litesite-auto-deploy.sh >> /var/log/litesite-deploy.log 2>&1
EOF
chmod 644 "$CRON_FILE"

# Debian/Ubuntu 是 cron，RHEL 系是 crond，两个都试一下
systemctl enable --now cron >/dev/null 2>&1 || systemctl enable --now crond >/dev/null 2>&1 || true
if systemctl is-active --quiet cron 2>/dev/null || systemctl is-active --quiet crond 2>/dev/null; then
  echo "   cron 服务运行中"
else
  echo "   !! cron 服务未运行，请检查 systemctl status cron"
fi

# ---------- 4. 生效并自检 ----------
echo "-> 重启服务使其读取新的 .env"
pm2 reload litesite --update-env >/dev/null 2>&1 || pm2 restart litesite >/dev/null 2>&1
sleep 3

echo "-> 健康检查"
HEALTH=$(curl -s --max-time 6 http://127.0.0.1:3000/api/health 2>/dev/null)
echo "   $HEALTH"

if echo "$HEALTH" | grep -q '"source":"github"'; then
  echo
  echo "完成：作品集已切到 GitHub 数据源。"
  echo "  线上查看：打开你的域名，滚到「作品集」一节"
  echo "  下次本地 git push 后，最多 3 分钟线上自动更新。"
else
  echo
  echo "注意：健康检查里没看到 source=github，可能还没抓到或配置未生效。"
  echo "  排查：pm2 logs litesite --lines 30"
fi

echo
echo "查看部署日志：tail -f /var/log/litesite-deploy.log"
echo "手动跑一次：  /root/litesite-auto-deploy.sh"
