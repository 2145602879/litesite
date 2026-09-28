'use strict';
/**
 * GitHub 仓库抓取与内存缓存 —— 作品集的数据源。
 *
 * 为什么不放在前端抓：
 *   1. GitHub 匿名接口额度只有 60 次/小时（按 IP 计），前端直连会让每个访客
 *      各消耗一次额度，且拿不到缓存；
 *   2. 服务端抓一次、缓存住，所有访客共用，额度消耗可以忽略不计；
 *   3. 前端零外部请求，页面更快，也不受 GitHub 连通性影响。
 *
 * 内存策略（1G 机器的自我约束）：
 *   - 只保留前端真正要用的字段，GitHub 返回的其余 60 多个字段全部丢弃；
 *   - 描述截断到 180 字，话题最多 6 个；
 *   - 仓库条数由 GITHUB_MAX 限制（默认 12），缓存对象只有几十 KB；
 *   - 缓存采用 stale-while-revalidate：过期也先返回旧数据，后台静默刷新，
 *     保证访客永远不会为了等 GitHub 而卡住。
 */
const config = require('./config');

// GitHub 官方语言配色（常见项；未收录的语言按名称生成稳定色相）
const LANG_COLORS = {
  JavaScript: '#f1e05a',
  TypeScript: '#3178c6',
  Python: '#3572A5',
  HTML: '#e34c26',
  CSS: '#563d7c',
  SCSS: '#c6538c',
  Vue: '#41b883',
  Svelte: '#ff3e00',
  Java: '#b07219',
  'C#': '#178600',
  C: '#555555',
  'C++': '#f34b7d',
  Go: '#00ADD8',
  Rust: '#dea584',
  Ruby: '#701516',
  PHP: '#4F5D95',
  Shell: '#89e051',
  Bash: '#89e051',
  PowerShell: '#012456',
  Swift: '#F05138',
  Kotlin: '#A97BFF',
  Dart: '#00B4AB',
  Lua: '#000080',
  Perl: '#0298c3',
  R: '#198CE7',
  MATLAB: '#e16737',
  Julia: '#a270ba',
  Scala: '#c22d40',
  Haskell: '#5e5086',
  Elixir: '#6e4a7e',
  Clojure: '#db5855',
  Zig: '#ec915c',
  Nix: '#7e7eff',
  'Jupyter Notebook': '#DA5B0B',
  TeX: '#3D6117',
  Makefile: '#427819',
  Dockerfile: '#384d54',
  'Vim Script': '#199f4b',
  'Emacs Lisp': '#c065db',
  Assembly: '#6E4C13',
  Fortran: '#4d41b1',
  Groovy: '#4298b8',
  Batchfile: '#C1F12E',
  'Objective-C': '#438eff',
};

const colorCache = new Map(); // 语言 -> { hex, rgb }，避免重复计算

/** #RRGGBB -> "R G B"（配合站点既有的 rgb(var(--x) / alpha) 写法） */
function triplet(hex) {
  const n = Number.parseInt(hex.slice(1), 16);
  return `${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255}`;
}

/** HSL(0..360, 0..1, 0..1) -> #RRGGBB，用于给未收录语言生成稳定配色 */
function hslToHex(h, s, l) {
  const channel = (n) => {
    const k = (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const v = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(255 * v).toString(16).padStart(2, '0');
  };
  return `#${channel(0)}${channel(8)}${channel(4)}`;
}

/** 取语言配色；同一语言永远得到同一个颜色 */
function langColor(lang) {
  const key = lang || '';
  const hit = colorCache.get(key);
  if (hit) return hit;

  let hex = LANG_COLORS[key];
  if (!hex) {
    if (!key) {
      hex = '#6E7482'; // 没有语言信息时的中性灰
    } else {
      let h = 0;
      for (let i = 0; i < key.length; i += 1) h = (h * 31 + key.charCodeAt(i)) % 360;
      hex = hslToHex(h, 0.5, 0.56);
    }
  }
  const value = { hex, rgb: triplet(hex) };
  colorCache.set(key, value);
  return value;
}

/** 只接受 http/https，挡掉 javascript: 这类可能被塞进 href 的协议 */
function safeUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (!/^https?:\/\//i.test(raw)) return '';
  return raw.slice(0, 300);
}

/** 截断并按字符数计，中文不会被切坏（按码点切） */
function clip(text, max) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  return `${Array.from(s).slice(0, max).join('')}…`;
}

// ------------------------------------------------------------------
// 缓存状态：整个模块只持有这一份数据
// ------------------------------------------------------------------
const state = {
  at: 0, // 上次成功刷新的时间戳
  items: [], // 已裁剪的仓库列表
  error: '', // 最近一次失败原因（供 /api/health 与排错用）
  inflight: null, // 进行中的请求，避免并发重复抓取
  lastAttempt: 0, // 上次发起抓取的时间戳（用于重试退避）
  lastLogAt: 0,
};

// 两次抓取之间的最小间隔。抓取失败后拉长到 60 秒：
// 匿名接口按 IP 只有 60 次/小时，如果失败后每个访客请求都触发一次抓取，
// 额度会被瞬间打光，反而让站点更久拿不到数据。
const MIN_GAP_MS = 15000;
const MIN_GAP_AFTER_FAILURE_MS = 60000;

/** 当前生效的数据源：github 或 manual */
function source() {
  if (config.portfolio.source === 'manual') return 'manual';
  if (config.portfolio.source === 'github') return 'github';
  return config.github.username ? 'github' : 'manual';
}

function enabled() {
  return source() === 'github';
}

/** 失败日志限流：同一条错误最多每 5 分钟记一次，避免刷爆日志 */
function logError(message) {
  const now = Date.now();
  if (now - state.lastLogAt < 5 * 60 * 1000) return;
  state.lastLogAt = now;
  console.warn(`[github] 抓取失败：${message}（将继续使用缓存/兜底数据）`);
}

/** 挑选并按顺序排列：显式白名单优先，否则按星标数 + 最近推送排序 */
function pick(list) {
  const { repos: allow, excludeForks, excludeArchived, max } = config.github;

  const filtered = list.filter((r) => {
    if (!r || typeof r.name !== 'string') return false;
    if (excludeForks && r.fork) return false;
    if (excludeArchived && r.archived) return false;
    if (allow.length && !allow.includes(r.name)) return false;
    return true;
  });

  if (allow.length) {
    filtered.sort((a, b) => allow.indexOf(a.name) - allow.indexOf(b.name));
  } else {
    filtered.sort((a, b) => {
      const star = (b.stargazers_count || 0) - (a.stargazers_count || 0);
      if (star !== 0) return star;
      const ta = Date.parse(a.pushed_at || a.updated_at || 0) || 0;
      const tb = Date.parse(b.pushed_at || b.updated_at || 0) || 0;
      if (tb !== ta) return tb - ta;
      return a.name.localeCompare(b.name);
    });
  }
  return filtered.slice(0, max);
}

/** GitHub 原始对象 -> 前端要用的最小结构 */
function mapRepo(r) {
  const lang = r.language || '';
  const color = langColor(lang);
  return {
    id: `gh:${r.name}`,
    name: r.name,
    title: r.name, // 与手动作品集保持同名字段，前端模板可以直接复用
    description: clip(r.description, 180),
    link: safeUrl(r.html_url),
    homepage: safeUrl(r.homepage),
    language: lang,
    color: color.hex, // 语言色，前端画小圆点
    cover: color.rgb, // 语言色的 RGB 三元组，前端据此生成封面渐变
    stars: r.stargazers_count || 0,
    forks: r.forks_count || 0,
    // 话题最多 6 个，字段名沿用 tags，前端不必区分数据源
    tags: Array.isArray(r.topics) ? r.topics.slice(0, 6).map((t) => clip(t, 24)) : [],
    archived: !!r.archived,
    updatedAt: r.pushed_at || r.updated_at || '',
  };
}

/** 真正发起 HTTP 请求（Node 22 自带 fetch，无需 axios） */
async function fetchFromGitHub() {
  const { username, token, timeoutMs } = config.github;
  const url =
    `https://api.github.com/users/${encodeURIComponent(username)}/repos` +
    '?per_page=100&sort=updated&direction=desc&type=owner';

  const headers = {
    // GitHub 强制要求带 User-Agent，否则 403
    'User-Agent': 'litesite/1.0 (personal homepage)',
    Accept: 'application/vnd.github+json',
  };
  // 配了令牌就用令牌：额度从 60/小时 提到 5000/小时，也能读私有仓库
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok) {
    const hint = res.status === 403 || res.status === 404 ? '（检查用户名或额度）' : '';
    throw new Error(`GitHub API 返回 ${res.status}${hint}`);
  }
  const raw = await res.json();
  if (!Array.isArray(raw)) throw new Error('GitHub 返回格式异常');
  return pick(raw).map(mapRepo);
}

/** 触发一次刷新；并发调用会复用同一个 Promise */
function refresh() {
  if (!enabled()) return Promise.resolve(state.items);
  if (state.inflight) return state.inflight;

  const started = Date.now();
  state.lastAttempt = started;
  state.inflight = fetchFromGitHub()
    .then((items) => {
      state.items = items;
      state.at = Date.now();
      state.error = '';
      console.log(
        `[github] 已更新仓库列表：${items.length} 个，耗时 ${Date.now() - started}ms`
      );
      return items;
    })
    .catch((err) => {
      state.error = err.message || String(err);
      logError(state.error);
      return state.items;
    })
    .finally(() => {
      state.inflight = null;
    });

  return state.inflight;
}

/**
 * 取仓库列表。
 * 返回值语义：
 *   null  -> 当前是手动数据源，调用方应回退到数据库里的作品
 *   []    -> GitHub 数据源已启用但还没抓到（首次启动的瞬间），前端会显示骨架
 */
function list() {
  if (!enabled()) return null;

  const now = Date.now();
  const ttl = config.github.cacheMinutes * 60 * 1000;
  const hasData = state.items.length > 0;
  const expired = hasData && now - state.at > ttl;

  // 过期就先返回旧数据并后台刷新，访客不会为了等 GitHub 而卡住。
  // 同时限制最小重试间隔：失败后退避到 60 秒，避免访客请求把匿名额度打光。
  const minGap = state.error ? MIN_GAP_AFTER_FAILURE_MS : MIN_GAP_MS;
  if ((!hasData || expired) && now - state.lastAttempt > minGap) refresh();

  return state.items;
}

/** 进程启动时预热一次，让第一位访客就能看到内容 */
function warmup() {
  if (enabled()) refresh();
}

/** 供 /api/health 与后台概览使用的诊断信息 */
function stats() {
  return {
    source: source(),
    count: state.items.length,
    refreshedAt: state.at ? new Date(state.at).toISOString() : '',
    lastAttemptAt: state.lastAttempt ? new Date(state.lastAttempt).toISOString() : '',
    refreshing: !!state.inflight,
    error: state.error,
  };
}

module.exports = { list, warmup, stats, refresh, source, enabled, langColor };
