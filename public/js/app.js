/* =====================================================================
   litesite 前台脚本（原生 JavaScript，无框架、无构建步骤）
   ---------------------------------------------------------------------
   体积约 8KB，未压缩状态下也远小于任何前端框架的运行时。
   职责：
     1. 拉取 /api/site 渲染首屏
     2. 渲染作品集 / 博客列表 / 技能 / 联系方式 / 留言墙
     3. 主题切换、移动端菜单、滚动进场
     4. 文章阅读层（Markdown 在浏览器端渲染）
   ===================================================================== */
(function () {
  'use strict';

  // ------------------------------------------------------------------
  // 工具
  // ------------------------------------------------------------------
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.prototype.slice.call((root || document).querySelectorAll(sel));

  /** 统一请求封装：自动带 Cookie，自动抛错 */
  async function api(path, options) {
    const res = await fetch(path, {
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      ...options,
    });
    let data = null;
    try {
      data = await res.json();
    } catch (_) {
      /* 非 JSON 响应（例如 502） */
    }
    if (!res.ok) throw new Error((data && data.error) || `请求失败（${res.status}）`);
    return data;
  }

  /** HTML 转义：所有插入 innerHTML 的动态文本都必须过这一层 */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
    );
  }

  /** 时间格式化：数据库存 UTC，这里转成访客本地时间 */
  function fmtDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d)) return '';
    return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
  }

  /** 图片加载失败时的兜底：给一个渐变块，而不是破图图标 */
  const FALLBACK_IMG =
    "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 10'%3E%3Cdefs%3E%3ClinearGradient id='g' x1='0' y1='0' x2='1' y2='1'%3E%3Cstop offset='0' stop-color='%23E25814' stop-opacity='.22'/%3E%3Cstop offset='1' stop-color='%23CA8A0C' stop-opacity='.10'/%3E%3C/linearGradient%3E%3C/defs%3E%3Crect width='16' height='10' fill='url(%23g)'/%3E%3C/svg%3E";
  window.__imgFallback = function (el) {
    el.onerror = null;
    el.src = FALLBACK_IMG;
  };

  const state = { posts: [], offset: 0, limit: 4, total: 0, profile: null };

  // ------------------------------------------------------------------
  // 1. 主题切换
  // ------------------------------------------------------------------
  (function initTheme() {
    const btn = $('#themeBtn');
    if (!btn) return;
    btn.addEventListener('click', () => {
      const root = document.documentElement;
      root.classList.add('theme-anim'); // 只在切换瞬间开启颜色过渡
      const dark = root.classList.toggle('dark');
      try {
        localStorage.setItem('theme', dark ? 'dark' : 'light');
      } catch (_) {}
      setTimeout(() => root.classList.remove('theme-anim'), 400);
    });
  })();

  // ------------------------------------------------------------------
  // 2. 移动端菜单
  // ------------------------------------------------------------------
  (function initMenu() {
    const btn = $('#menuBtn');
    const panel = $('#mobileNav');
    if (!btn || !panel) return;
    const toggle = (open) => {
      panel.classList.toggle('hidden', !open);
      btn.setAttribute('aria-expanded', String(open));
    };
    btn.addEventListener('click', () => toggle(panel.classList.contains('hidden')));
    $$('a', panel).forEach((a) => a.addEventListener('click', () => toggle(false)));
  })();

  // ------------------------------------------------------------------
  // 3. 滚动进场（IntersectionObserver，比 scroll 事件省 CPU）
  // ------------------------------------------------------------------
  function observeReveals(root) {
    const items = $$('.reveal:not(.is-in)', root || document);
    if (!items.length) return;
    if (!('IntersectionObserver' in window)) {
      items.forEach((el) => el.classList.add('is-in'));
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (!e.isIntersecting) return;
          e.target.classList.add('is-in');
          io.unobserve(e.target); // 进场一次即解除观察，不留监听
        });
      },
      { rootMargin: '0px 0px -8% 0px', threshold: 0.08 }
    );
    items.forEach((el) => io.observe(el));
  }

  // ------------------------------------------------------------------
  // 4. 首屏数据
  // ------------------------------------------------------------------
  async function loadSite() {
    const data = await api('/api/site');
    const p = data.profile || {};
    state.profile = p;

    // 站点名与 SEO
    const title = p.name ? `${p.name} | ${p.role || '个人主页'}` : data.site.title;
    document.title = title;
    if (data.site.description) {
      const meta = $('meta[name="description"]');
      if (meta) meta.setAttribute('content', data.site.description);
    }

    // 文本绑定：全部走 textContent，天然免疫 XSS
    const text = {
      name: p.name,
      role: p.role,
      tagline: p.tagline,
      bio: p.bio,
      location: p.location,
      brandName: p.name,
      statProjects: data.stats.projects,
      statPosts: data.stats.posts,
      year: new Date().getFullYear(),
    };
    Object.keys(text).forEach((key) => {
      $$(`[data-bind="${key}"]`).forEach((el) => {
        if (text[key] === undefined || text[key] === null) return;
        el.textContent = String(text[key]);
      });
    });

    // 头像：有自定义地址就替换，失败时兜底
    if (p.avatar) {
      $$('[data-bind="avatar"]').forEach((img) => {
        img.src = p.avatar;
      });
    }

    renderSkills(data.skills || []);
    renderContacts(p);
  }

  // ------------------------------------------------------------------
  // 5. 技能
  // ------------------------------------------------------------------
  function renderSkills(groups) {
    const box = $('#skillGroups');
    if (!box) return;
    if (!groups.length) {
      box.innerHTML = '<p class="text-[15px] text-muted">还没有添加技能标签。</p>';
      return;
    }
    box.innerHTML = groups
      .map(
        (g) => `
        <div class="reveal">
          <div class="mb-4 flex items-center gap-3">
            <h3 class="font-display text-[15px] font-semibold tracking-tight">${esc(g.category)}</h3>
            <span class="h-px flex-1 bg-line/10"></span>
          </div>
          <ul class="grid gap-x-8 gap-y-3.5 sm:grid-cols-2">
            ${g.items
              .map((s) => {
                const lv = Math.max(1, Math.min(5, Number(s.level) || 3));
                const bars = [1, 2, 3, 4, 5]
                  .map((i) => `<i class="${i <= lv ? 'on' : ''}"></i>`)
                  .join('');
                return `<li class="flex items-center justify-between gap-4">
                          <span class="text-[15px] text-fg/90">${esc(s.name)}</span>
                          <span class="level" aria-label="熟练度 ${lv} / 5" role="img">${bars}</span>
                        </li>`;
              })
              .join('')}
          </ul>
        </div>`
      )
      .join('');
    observeReveals(box);
  }

  // ------------------------------------------------------------------
  // 6. 联系方式
  // ------------------------------------------------------------------
  function renderContacts(p) {
    const box = $('#contactList');
    if (!box) return;
    const social = p.social || {};
    const rows = [];

    if (p.email) {
      rows.push({ label: '邮箱', value: p.email, href: `mailto:${p.email}`, copy: p.email });
    }
    if (p.website) rows.push({ label: '网站', value: p.website.replace(/^https?:\/\//, ''), href: p.website });
    if (social.github) rows.push({ label: 'GitHub', value: social.github.replace(/^https?:\/\//, ''), href: social.github });
    if (social.twitter) rows.push({ label: 'X / Twitter', value: social.twitter.replace(/^https?:\/\//, ''), href: social.twitter });
    if (social.weibo) rows.push({ label: '微博', value: social.weibo.replace(/^https?:\/\//, ''), href: social.weibo });
    if (social.wechat) rows.push({ label: '微信', value: social.wechat, copy: social.wechat });

    if (!rows.length) {
      box.innerHTML = '<li class="py-4 text-[15px] text-muted">还没有填写联系方式。</li>';
      return;
    }

    box.innerHTML = rows
      .map(
        (r, i) => `
        <li class="flex items-center justify-between gap-4 py-4">
          <span class="w-24 shrink-0 text-[13px] uppercase tracking-[0.12em] text-muted">${esc(r.label)}</span>
          ${
            r.href
              ? `<a href="${esc(r.href)}" target="_blank" rel="noopener noreferrer nofollow"
                    class="min-w-0 flex-1 truncate text-[15px] text-fg/90 transition-colors hover:text-accent">${esc(r.value)}</a>`
              : `<span class="min-w-0 flex-1 truncate font-mono text-[14px] text-fg/90">${esc(r.value)}</span>`
          }
          ${
            r.copy
              ? `<button type="button" class="copy-btn shrink-0 rounded-full border border-line/15 px-3 py-1 text-[12.5px] text-muted transition-colors hover:text-fg"
                    data-copy="${esc(r.copy)}" data-idx="${i}">复制</button>`
              : '<span class="w-[46px] shrink-0"></span>'
          }
        </li>`
      )
      .join('');

    // 复制到剪贴板：失败时退化为选中提示，不弹一堆 alert
    $$('.copy-btn', box).forEach((btn) => {
      btn.addEventListener('click', async () => {
        const val = btn.getAttribute('data-copy');
        try {
          await navigator.clipboard.writeText(val);
          btn.textContent = '已复制';
        } catch (_) {
          btn.textContent = '复制失败';
        }
        setTimeout(() => (btn.textContent = '复制'), 1600);
      });
    });
  }

  // ------------------------------------------------------------------
  // 7. 作品集
  //    数据源可能是 GitHub 公开仓库（后端抓取 + 缓存），也可能是后台手动录入。
  //    GitHub 卡片刻意不加载任何外部图片：封面由「仓库语言配色」现场生成渐变，
  //    既省流量与解码内存，也不会因为占位图服务在国内打不开而变成灰块。
  // ------------------------------------------------------------------

  /** 相对时间：作品集里「3 天前更新」比「2026.09.23」更有信息量 */
  function fmtAgo(iso) {
    const t = Date.parse(iso || '');
    if (!t) return '';
    const diff = Date.now() - t;
    const hour = 3600000;
    const day = 24 * hour;
    if (diff < hour) return '刚刚更新';
    if (diff < day) return `${Math.floor(diff / hour)} 小时前更新`;
    if (diff < 30 * day) return `${Math.floor(diff / day)} 天前更新`;
    if (diff < 365 * day) return `${Math.floor(diff / (30 * day))} 个月前更新`;
    return `${fmtDate(iso)} 更新`;
  }

  const ICON_STAR =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3.6l2.7 5.5 6 .9-4.3 4.2 1 6L12 17.4 6.6 20.2l1-6L3.3 10l6-.9z"/></svg>';
  const ICON_FORK =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="6.5" cy="18" r="2.5"/><circle cx="17.5" cy="6" r="2.5"/><path d="M6.5 15.5V8.5A2.5 2.5 0 019 6h6"/></svg>';

  /**
   * 计算每张卡占几列（栅格共 6 列）。
   * 规则：成对出「4 + 2」并隔行镜像（[4,2] [2,4] [4,2] …），落单的最后一张铺满 6 列。
   * 隔行镜像比机械重复更有节奏，也和首页骨架屏的排布一致，减少数据到位时的位移。
   * 任何条数下每一行都正好填满，不会出现「最后一行只剩一张窄卡、右边空一块」。
   */
  function layoutSpans(total) {
    const spans = [];
    let i = 0;
    let flip = false;
    while (i < total) {
      if (total - i === 1) {
        spans.push(6);
        i += 1;
      } else if (flip) {
        spans.push(2, 4);
        i += 2;
        flip = false;
      } else {
        spans.push(4, 2);
        i += 2;
        flip = true;
      }
    }
    return spans.slice(0, total);
  }

  /**
   * 仓库封面：用语言配色生成渐变 + 首字母水印，纯 CSS，零外部请求。
   * 语言信息刻意不压在封面上（标签压图是最容易显廉价的做法），
   * 而是放进下方元信息行，沿用 GitHub 自己的「色点 + 语言名」约定。
   */
  function repoCover(item, ratio) {
    const initial = String(item.title || item.name || '?').trim().charAt(0).toUpperCase();
    return `
      <div class="card-media repo-cover ${ratio}" style="--cover:${esc(item.cover || '120 126 140')}">
        <span class="repo-mark" aria-hidden="true">${esc(initial)}</span>
        <div class="repo-cover-body">
          <h3 class="card-title repo-name">${esc(item.title)}</h3>
        </div>
      </div>`;
  }

  /** 仓库元信息：语言、更新时间、星标、分支、在线预览 */
  function repoMeta(item) {
    const bits = [];
    if (item.language) {
      bits.push(
        `<span class="repo-lang"><i style="background:${esc(item.color || '')}"></i>${esc(item.language)}</span>`
      );
    }
    const ago = fmtAgo(item.updatedAt);
    if (ago) bits.push(`<span class="repo-ago">${esc(ago)}</span>`);
    if (item.stars > 0) bits.push(`<span class="repo-stat">${ICON_STAR}${item.stars}</span>`);
    if (item.forks > 0) bits.push(`<span class="repo-stat">${ICON_FORK}${item.forks}</span>`);
    if (item.archived) bits.push('<span class="repo-archived">已归档</span>');
    // 有线上地址的项目额外给一个入口：必须抬到拉伸链接之上才点得到
    if (item.homepage) {
      bits.push(
        `<a class="repo-live" href="${esc(item.homepage)}" target="_blank" rel="noopener noreferrer nofollow">在线预览</a>`
      );
    }
    return bits.length ? `<div class="repo-meta">${bits.join('')}</div>` : '';
  }

  /**
   * 加载作品集。
   * attempt 用于冷启动重试：服务刚重启时后端可能还没抓到 GitHub 数据，
   * 此时先保留骨架屏等一会儿再试，而不是直接告诉访客「作品还在整理中」。
   */
  async function loadProjects(attempt) {
    const grid = $('#projectGrid');
    if (!grid) return;
    const tries = attempt || 0;
    try {
      const data = await api('/api/projects');
      const items = data.items || [];

      if (data.pending && tries < 3) {
        setTimeout(() => loadProjects(tries + 1), 1200);
        return; // 不动骨架屏
      }

      // 首屏统计里的「作品」数量跟随真实数据源，避免和列表对不上
      $$('[data-bind="statProjects"]').forEach((el) => {
        el.textContent = String(items.length);
      });

      if (!items.length) {
        // 取不到数据和「确实还没有作品」是两回事，不要说错话
        if (data.error) console.warn('[作品集] 数据源异常：', data.error);
        grid.innerHTML = data.error
          ? '<p class="text-[15px] text-muted">作品集暂时取不到数据，稍后刷新看看。</p>'
          : '<p class="text-[15px] text-muted">作品还在整理中，稍后再来看看。</p>';
        return;
      }

      const spans = layoutSpans(items.length);
      grid.innerHTML = items
        .map((item, i) => {
          // 不对称网格：4 列宽 + 2 列窄交替，落单的一张铺满整行
          const col = spans[i] || 2;
          const span =
            col === 6 ? 'md:col-span-6' : col === 4 ? 'md:col-span-4' : 'md:col-span-2';
          const ratio =
            col === 6 ? 'aspect-[21/9]' : col === 4 ? 'aspect-[16/10]' : 'aspect-[4/3]';

          const tags = (item.tags || [])
            .slice(0, 4)
            .map((t) => `<span class="tag">${esc(t)}</span>`)
            .join('');

          const arrow = `
            <svg class="work-arrow mt-1 h-5 w-5 shrink-0 text-muted" viewBox="0 0 24 24" fill="none"
                 stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M7 17L17 7M9 7h8v8" /></svg>`;

          // 有 cover 字段的是 GitHub 仓库卡片，否则是后台手动录入的作品
          if (item.cover) {
            // 覆盖整卡的透明链接：这样整张卡都能点，又不会和「在线预览」
            // 形成嵌套 <a>（那是无效 HTML）。标题保持纯文本，由覆盖层承接点击。
            return `
              <div class="work-card reveal block ${span}">
                <a class="work-overlay" href="${esc(item.link)}" target="_blank"
                   rel="noopener noreferrer nofollow" aria-label="${esc(item.title)}（在 GitHub 打开）"></a>
                ${repoCover(item, ratio)}
                <div class="mt-5 flex items-start justify-between gap-4">
                  <div class="min-w-0">
                    ${
                      item.description
                        ? `<p class="max-w-[46ch] text-[14.5px] leading-relaxed text-muted">${esc(item.description)}</p>`
                        : '<p class="max-w-[46ch] text-[14.5px] leading-relaxed text-muted/70">这个仓库还没写简介，点进去看看代码吧。</p>'
                    }
                    ${repoMeta(item)}
                    ${tags ? `<div class="mt-4 flex flex-wrap gap-2">${tags}</div>` : ''}
                  </div>
                  ${arrow}
                </div>
              </div>`;
          }

          // 手动录入的作品：沿用原来的图片卡片
          const w = col === 2 ? 640 : col === 6 ? 1200 : 1000;
          const h = col === 2 ? 480 : col === 6 ? 514 : 620;
          const img = item.image || `https://picsum.photos/seed/lite-${item.id}/${w}/${h}`;
          const inner = `
            <div class="card-media ${ratio}">
              <img src="${esc(img)}" alt="${esc(item.title)} 项目预览" width="${w}" height="${h}"
                   loading="lazy" decoding="async" onerror="window.__imgFallback(this)" />
            </div>
            <div class="mt-5 flex items-start justify-between gap-4">
              <div class="min-w-0">
                <h3 class="card-title font-display text-[19px] font-semibold tracking-tight">${esc(item.title)}</h3>
                <p class="mt-2 max-w-[46ch] text-[14.5px] leading-relaxed text-muted">${esc(item.description)}</p>
                ${tags ? `<div class="mt-4 flex flex-wrap gap-2">${tags}</div>` : ''}
              </div>
              ${item.link ? arrow : ''}
            </div>`;

          return item.link
            ? `<a class="work-card reveal block ${span}" href="${esc(item.link)}" target="_blank" rel="noopener noreferrer nofollow">${inner}</a>`
            : `<div class="work-card reveal block ${span}">${inner}</div>`;
        })
        .join('');

      observeReveals(grid);
    } catch (err) {
      grid.innerHTML = `<p class="text-[15px] text-muted">作品加载失败：${esc(err.message)}</p>`;
    }
  }

  // ------------------------------------------------------------------
  // 8. 博客列表
  // ------------------------------------------------------------------
  function postRowTemplate(post) {
    const tags = (post.tags || []).slice(0, 3).map((t) => `<span class="tag">${esc(t)}</span>`).join('');
    return `
      <article class="post-row reveal" data-slug="${esc(post.slug)}">
        <time class="font-mono text-[12.5px] text-muted" datetime="${esc(post.createdAt || '')}">${esc(fmtDate(post.createdAt))}</time>
        <div class="min-w-0">
          <h3 class="post-title cursor-pointer font-display text-[20px] font-semibold leading-snug tracking-tight sm:text-[22px]">
            <button type="button" class="open-post text-left" data-slug="${esc(post.slug)}">${esc(post.title)}</button>
          </h3>
          ${post.summary ? `<p class="mt-2 max-w-[68ch] text-[14.5px] leading-relaxed text-muted">${esc(post.summary)}</p>` : ''}
          ${tags ? `<div class="mt-3.5 flex flex-wrap gap-2">${tags}</div>` : ''}
        </div>
        <div class="flex items-center gap-4 md:justify-end">
          <span class="font-mono text-[12px] text-muted">${Number(post.views) || 0} 次阅读</span>
          <svg class="work-arrow h-4 w-4 text-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M5 12h14M13 6l6 6-6 6" />
          </svg>
        </div>
      </article>`;
  }

  async function loadPosts(reset) {
    const box = $('#postList');
    const more = $('#loadMoreBtn');
    if (!box) return;
    if (reset) {
      state.offset = 0;
      box.innerHTML = '<div class="skeleton-post"></div><div class="skeleton-post"></div>';
    }
    try {
      const data = await api(`/api/posts?limit=${state.limit}&offset=${state.offset}`);
      state.total = data.total;
      state.offset += data.items.length;

      if (reset) box.innerHTML = '';
      if (!state.total) {
        box.innerHTML = '<p class="py-8 text-[15px] text-muted">还没有发布文章。去管理后台写第一篇吧。</p>';
        if (more) more.classList.add('hidden');
        return;
      }
      box.insertAdjacentHTML('beforeend', data.items.map(postRowTemplate).join(''));
      if (more) more.classList.toggle('hidden', state.offset >= state.total);
      observeReveals(box);
    } catch (err) {
      box.innerHTML = `<p class="py-8 text-[15px] text-muted">文章加载失败：${esc(err.message)}</p>`;
    }
  }

  // ------------------------------------------------------------------
  // 9. 文章阅读层
  // ------------------------------------------------------------------
  const reader = $('#reader');

  function renderMarkdown(md) {
    // 优先用 marked + DOMPurify；CDN 不可用时退化为纯文本，功能不中断
    if (window.marked && window.DOMPurify) {
      const html = window.marked.parse(String(md || ''), { gfm: true, breaks: false });
      return window.DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
    }
    return `<pre>${esc(md)}</pre>`;
  }

  async function openPost(slug) {
    if (!reader) return;
    $('#readerTitle').textContent = '加载中';
    $('#readerMeta').textContent = '';
    $('#readerBody').innerHTML = '<div class="skeleton h-40"></div>';
    $('#readerPrev').classList.add('hidden');
    if (typeof reader.showModal === 'function') reader.showModal();
    else reader.setAttribute('open', '');

    try {
      const { post, next } = await api(`/api/posts/${encodeURIComponent(slug)}`);
      $('#readerTitle').textContent = post.title;
      const tags = (post.tags || []).join(' · ');
      $('#readerMeta').textContent = `${fmtDate(post.createdAt)}  ·  ${post.views} 次阅读${tags ? `  ·  ${tags}` : ''}`;
      $('#readerBody').innerHTML = renderMarkdown(post.content);
      const prevBtn = $('#readerPrev');
      if (next) {
        prevBtn.classList.remove('hidden');
        prevBtn.textContent = `上一篇：${next.title}`;
        prevBtn.onclick = () => openPost(next.slug);
      }
      // 同步地址栏，便于分享与刷新（不影响服务端路由）
      history.replaceState(null, '', `#/post/${post.slug}`);
    } catch (err) {
      $('#readerBody').innerHTML = `<p class="text-[15px] text-muted">文章打开失败：${esc(err.message)}</p>`;
    }
  }

  if (reader) {
    $('#readerClose').addEventListener('click', () => reader.close());
    // 点击遮罩关闭
    reader.addEventListener('click', (e) => {
      if (e.target === reader) reader.close();
    });
    reader.addEventListener('close', () => {
      history.replaceState(null, '', window.location.pathname + window.location.search);
    });
    document.addEventListener('click', (e) => {
      const btn = e.target.closest('.open-post');
      if (btn) openPost(btn.getAttribute('data-slug'));
    });
  }

  // ------------------------------------------------------------------
  // 10. 留言表单
  // ------------------------------------------------------------------
  (function initMessageForm() {
    const form = $('#messageForm');
    if (!form) return;
    const hint = $('#msgHint');
    const count = $('#msgCount');
    const submit = $('#msgSubmit');
    const content = $('#msgContent');

    content.addEventListener('input', () => {
      count.textContent = `${content.value.length} / 1000`;
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = $('#msgName').value.trim();
      const email = $('#msgEmail').value.trim();
      const body = content.value.trim();

      // 前端先做一轮校验，减少无效请求
      if (!name) return setHint('请填写称呼', true);
      if (body.length < 2) return setHint('留言内容太短了', true);

      submit.disabled = true;
      submit.textContent = '发送中…';
      setHint('');
      try {
        const data = await api('/api/messages', {
          method: 'POST',
          body: JSON.stringify({ name, email, content: body }),
        });
        form.reset();
        count.textContent = '0 / 1000';
        setHint('留言已提交，谢谢你');
        prependGuestbook(data.item);
      } catch (err) {
        setHint(err.message, true);
      } finally {
        submit.disabled = false;
        submit.textContent = '发送留言';
      }
    });

    function setHint(msg, isError) {
      hint.textContent = msg || '';
      hint.style.color = isError ? '#d0453b' : '';
    }
  })();

  // ------------------------------------------------------------------
  // 11. 留言墙
  // ------------------------------------------------------------------
  function guestCard(m) {
    return `
      <figure class="reveal rounded-card border border-line/10 bg-elev/50 p-5">
        <blockquote class="text-[14.5px] leading-relaxed text-fg/90">${esc(m.content)}</blockquote>
        <figcaption class="mt-4 flex items-center gap-2 text-[12.5px] text-muted">
          <span class="font-medium text-fg/80">${esc(m.name)}</span>
          <span>·</span>
          <time datetime="${esc(m.createdAt || '')}">${esc(fmtDate(m.createdAt))}</time>
        </figcaption>
      </figure>`;
  }

  function prependGuestbook(item) {
    const box = $('#guestbook');
    if (!box || !item) return;
    const empty = box.querySelector('[data-empty]');
    if (empty) box.innerHTML = '';
    box.insertAdjacentHTML('afterbegin', guestCard(item));
    observeReveals(box);
  }

  async function loadGuestbook() {
    const box = $('#guestbook');
    if (!box) return;
    try {
      const { items, total } = await api('/api/messages?limit=6');
      if (!items.length) {
        box.innerHTML =
          '<p data-empty class="text-[15px] text-muted sm:col-span-2 lg:col-span-3">还没有人留言，你可以是第一个。</p>';
        return;
      }
      box.innerHTML = items.map(guestCard).join('');
      if (total > items.length) {
        box.insertAdjacentHTML(
          'beforeend',
          `<p class="text-[13px] text-muted sm:col-span-2 lg:col-span-3">共 ${total} 条留言，这里展示最近 ${items.length} 条。</p>`
        );
      }
      observeReveals(box);
    } catch (err) {
      box.innerHTML = `<p class="text-[15px] text-muted">留言加载失败：${esc(err.message)}</p>`;
    }
  }

  // ------------------------------------------------------------------
  // 12. 启动
  // ------------------------------------------------------------------
  document.addEventListener('DOMContentLoaded', () => {
    observeReveals();

    const more = $('#loadMoreBtn');
    if (more) more.addEventListener('click', () => loadPosts(false));

    // 首屏内容优先，其余并行拉取，互不阻塞
    loadSite().catch((err) => console.warn('站点信息加载失败：', err.message));
    loadProjects();
    loadPosts(true);
    loadGuestbook();

    // 支持直接打开 /#/post/xxx 深链
    const m = /^#\/post\/(.+)$/.exec(window.location.hash || '');
    if (m) openPost(decodeURIComponent(m[1]));
  });
})();
