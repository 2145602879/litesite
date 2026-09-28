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
  // 7. 作品集（不对称网格：4 列宽 + 2 列窄交替，避免"三张一样的卡片"）
  // ------------------------------------------------------------------
  async function loadProjects() {
    const grid = $('#projectGrid');
    if (!grid) return;
    try {
      const { items } = await api('/api/projects');
      if (!items.length) {
        grid.innerHTML =
          '<p class="text-[15px] text-muted">作品还在整理中，稍后再来看看。</p>';
        return;
      }

      grid.innerHTML = items
        .map((item, i) => {
          const wide = i % 4 === 0 || i % 4 === 3;
          const span = wide ? 'md:col-span-4' : 'md:col-span-2';
          const ratio = wide ? 'aspect-[16/10]' : 'aspect-[4/3]';
          // 按展示尺寸请求图片，减少带宽与解码内存
          const w = wide ? 1000 : 640;
          const h = wide ? 620 : 480;
          const img = item.image || `https://picsum.photos/seed/lite-${item.id}/${w}/${h}`;
          const tags = (item.tags || [])
            .slice(0, 4)
            .map((t) => `<span class="tag">${esc(t)}</span>`)
            .join('');
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
              ${
                item.link
                  ? `<svg class="work-arrow mt-1 h-5 w-5 shrink-0 text-muted" viewBox="0 0 24 24" fill="none"
                        stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                       <path d="M7 17L17 7M9 7h8v8" /></svg>`
                  : ''
              }
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
