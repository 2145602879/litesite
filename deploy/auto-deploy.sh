#!/bin/bash
# ============================================================
#  litesite 自动部署（由 cron 定时调用，默认每 3 分钟一次）
#
#  设计取舍：为什么是「服务器拉」而不是「GitHub 推」
#    推模式需要给 GitHub 开放入站 SSH、把私钥存到第三方 Secrets；
#    拉模式只依赖部署时已经配好的那只只读 Deploy Key，不新增任何对外暴露面。
#    代价是最多延迟一个轮询周期，对个人站点完全可以接受。
#
#  省流设计：
#    先用 git ls-remote 取远端分支的提交号（约 1KB），一致就直接退出；
#    只有真的出现新提交才 git fetch。避免每轮都完整抓取。
#
#  失败时的行为：不 reset、不重启，线上继续跑旧版本，只在日志里留下原因。
# ============================================================
set -uo pipefail

APP_DIR=/var/www/litesite
BRANCH=main
LOG=/var/log/litesite-deploy.log
LOCK=/var/lock/litesite-auto-deploy.lock
MAX_LOG_BYTES=1048576

# cron 的 PATH 极简，不显式声明会找不到 git / npm / pm2 / curl
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

log() { echo "[$(date '+%F %T')] $*"; }

# 串行化：上一轮还没跑完就直接退出，避免 npm / pm2 重入
exec 9>"$LOCK" || exit 0
flock -n 9 || exit 0

# 日志自截断：超过 1MB 只保留最后 2000 行（1G 的机器，磁盘也要省）
if [ -f "$LOG" ] && [ "$(stat -c%s "$LOG" 2>/dev/null || echo 0)" -gt "$MAX_LOG_BYTES" ]; then
  tail -n 2000 "$LOG" > "$LOG.tmp" 2>/dev/null && mv "$LOG.tmp" "$LOG"
fi

command -v git >/dev/null || { log "错误：找不到 git"; exit 1; }
command -v pm2 >/dev/null || { log "错误：找不到 pm2"; exit 1; }

cd "$APP_DIR" || { log "错误：找不到 $APP_DIR"; exit 1; }

# ---------- 1. 轻量检查：远端有没有新提交 ----------
REMOTE=$(git ls-remote origin "refs/heads/$BRANCH" 2>/dev/null | awk '{print $1}')
if [ -z "$REMOTE" ]; then
  log "无法读取远端分支（网络或部署密钥问题），本轮跳过"
  exit 0
fi

LOCAL=$(git rev-parse HEAD 2>/dev/null)
if [ "$LOCAL" = "$REMOTE" ]; then
  exit 0   # 无更新：静默退出，不写日志，否则日志会被每 3 分钟刷屏
fi

log "发现新提交：${LOCAL:0:7} -> ${REMOTE:0:7}"

# ---------- 2. 只在新提交确实存在时才真正抓取 ----------
if ! git fetch --quiet origin "$BRANCH"; then
  log "git fetch 失败，本轮中止（线上仍是旧版本）"
  exit 1
fi

# 依赖是否需要重装：只在 package.json / package-lock.json 变化时才 npm ci
DEPS_CHANGED=0
if ! git diff --quiet "$LOCAL" "$REMOTE" -- package-lock.json package.json 2>/dev/null; then
  DEPS_CHANGED=1
fi

# ---------- 3. 备份数据库（失败不阻断部署）----------
if [ -f data/litesite.db ]; then
  cp data/litesite.db "/root/litesite-backup-$(date +%F_%H%M).db" 2>/dev/null || true
  # 只保留最近 10 份，防止把磁盘塞满
  ls -1t /root/litesite-backup-*.db 2>/dev/null | tail -n +11 | xargs -r rm -f
fi

# ---------- 4. 对齐代码 ----------
# 服务器上不直接改源码，所以用硬重置保证一定收敛到远端状态；
# .env / data / node_modules / public/uploads 都在 .gitignore 里，不受影响。
if ! git reset --hard "$REMOTE" >/dev/null 2>&1; then
  log "git reset 失败，已中止（线上仍是旧版本）"
  exit 1
fi

# ---------- 5. 依赖 ----------
if [ "$DEPS_CHANGED" = "1" ]; then
  log "package-lock.json 有变化，重装依赖"
  if ! npm ci --omit=dev --no-audit --no-fund; then
    log "npm ci 失败！代码已更新但依赖未装好，请手动处理"
    exit 1
  fi
else
  log "依赖无变化，跳过 npm ci"
fi

# ---------- 6. 平滑重启 + 自检 ----------
pm2 reload litesite --update-env || pm2 restart litesite
sleep 2

HEALTH=$(curl -s --max-time 5 http://127.0.0.1:3000/api/health 2>/dev/null || true)
if echo "$HEALTH" | grep -q '"ok":true'; then
  log "部署完成，健康检查通过：$HEALTH"
else
  log "部署后健康检查失败：${HEALTH:-（无响应）}  请查看 pm2 logs litesite"
  exit 1
fi
