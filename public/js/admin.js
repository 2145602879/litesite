/* =====================================================================
   litesite 管理后台脚本（原生 JavaScript）
   ---------------------------------------------------------------------
   一个文件管完后台所有交互，不引入前端框架与 UI 组件库。
   体积小、内存低，虚拟机上的浏览器打开也不吃力。
   ===================================================================== */
(function () {
  'use strict';

  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.prototype.slice.call((r || document).querySelectorAll(s));

  // ------------------------------------------------------------------
  // 基础工具
  // ------------------------------------------------------------------
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
    );
  }

  function toast(msg, isError) {
    const box = $('#toast');
    const el = document.createElement('div');
    el.className = 'toast-item' + (isError ? ' err' : '');
    el.textContent = msg;
    box.appendChild(el);
    setTimeout(() => el.remove(), 3200);
  }

  /** 后台请求：401 统一跳回登录视图 */
  async function api(path, options) {
    const res = await fetch(path, {
      credentials: 'same-origin',
      headers: options && options.body instanceof FormData ? undefined : { 'Content-Type': 'application/json' },
      ...options,
    });

    if (res.status === 401 && !path.endsWith('/login')) {
      showLogin('登录状态已失效，请重新登录');
      throw new Error('未登录');
    }
    let data = null;
    try {
      data = await res.json();
    } catch (_) {}
    if (!res.ok) throw new Error((data && data.error) || `请求失败（${res.status}）`);
    return data;
  }

  function fmtTime(iso) {
    if (!iso) return '暂无';
    const d = new Date(iso);
    if (isNaN(d)) return '暂无';
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  /** 上传单个文件，返回可访问的 URL */
  async function uploadFile(file) {
    const fd = new FormData();
    fd.append('file', file);
    const data = await api('/api/admin/upload', { method: 'POST', body: fd });
    return data.url;
  }

  // ------------------------------------------------------------------
  // 主题 / 导航 / 登录态
  // ------------------------------------------------------------------
  $('#themeBtn').addEventListener('click', () => {
    const root = document.documentElement;
    root.classList.add('theme-anim');
    const dark = root.classList.toggle('dark');
    try {
      localStorage.setItem('theme', dark ? 'dark' : 'light');
    } catch (_) {}
    setTimeout(() => root.classList.remove('theme-anim'), 400);
  });

  function showLogin(msg) {
    $('#appView').classList.add('booting', 'hidden');
    $('#loginView').classList.remove('booting', 'hidden');
    if (msg) {
      $('#loginHint').textContent = msg;
      $('#loginHint').style.color = '#d0453b';
    }
  }

  function showApp() {
    $('#loginView').classList.add('booting', 'hidden');
    $('#appView').classList.remove('booting', 'hidden');
  }

  // 视图切换
  const views = ['overview', 'profile', 'projects', 'posts', 'messages', 'security'];
  function switchView(name) {
    if (views.indexOf(name) < 0) name = 'overview';
    views.forEach((v) => {
      const panel = $(`[data-panel="${v}"]`);
      if (panel) panel.classList.toggle('hidden', v !== name);
    });
    $$('#sideNav .side-link').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
    $$('#tabNav .mini-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
    if (location.hash.slice(1) !== name) history.replaceState(null, '', `#${name}`);
  }

  $$('#sideNav .side-link, #tabNav .mini-btn').forEach((btn) =>
    btn.addEventListener('click', () => switchView(btn.dataset.view))
  );
  window.addEventListener('hashchange', () => switchView(location.hash.slice(1)));

  // ------------------------------------------------------------------
  // 登录 / 登出
  // ------------------------------------------------------------------
  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const hint = $('#loginHint');
    const btn = $('#loginBtn');
    hint.style.color = '';
    hint.textContent = '正在验证…';
    btn.disabled = true;
    try {
      await api('/api/admin/login', {
        method: 'POST',
        body: JSON.stringify({
          username: $('#loginUser').value.trim(),
          password: $('#loginPass').value,
        }),
      });
      $('#loginPass').value = '';
      hint.textContent = '';
      await boot();
    } catch (err) {
      hint.textContent = err.message;
      hint.style.color = '#d0453b';
    } finally {
      btn.disabled = false;
    }
  });

  $('#logoutBtn').addEventListener('click', async () => {
    try {
      await api('/api/admin/logout', { method: 'POST' });
    } catch (_) {}
    location.reload();
  });

  // ------------------------------------------------------------------
  // 概览
  // ------------------------------------------------------------------
  async function loadOverview() {
    const s = await api('/api/admin/stats');
    const cards = [
      { label: '作品', value: s.projects },
      { label: '已发布文章', value: s.posts },
      { label: '草稿', value: s.drafts },
      { label: '访客留言', value: s.messages },
    ];
    $('#statsGrid').innerHTML = cards
      .map(
        (c) => `
        <div class="rounded-card border border-line/10 bg-elev/50 p-5">
          <p class="text-[12px] uppercase tracking-[0.12em] text-muted">${esc(c.label)}</p>
          <p class="mt-2 font-display text-[30px] font-semibold leading-none">${esc(c.value)}</p>
        </div>`
      )
      .join('');

    const uptimeMin = Math.floor(s.uptime / 60);
    const items = [
      `Node 进程已运行 ${uptimeMin} 分钟，常驻内存 ${s.rssMB} MB`,
      s.projects === 0 ? '还没有作品，去「作品集」添加第一条' : `已有 ${s.projects} 条作品展示在首页`,
      s.posts === 0 ? '还没有发布文章，去「博客文章」写第一篇' : `已有 ${s.posts} 篇文章可以阅读`,
      '生产环境请确认 Nginx 已托管 /uploads/ 与静态文件，Node 只处理 /api/ 请求',
      '确认 PM2 已按 ecosystem.config.js 启动，max_memory_restart 生效',
      '确认已配置 HTTPS 证书，并在 .env 中把 COOKIE_SECURE 设为 true',
    ];
    $('#checklist').innerHTML = items
      .map(
        (t) => `<li class="flex gap-3"><span class="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-accent"></span><span>${esc(t)}</span></li>`
      )
      .join('');

    const badge = $('#memBadge');
    badge.textContent = `RSS ${s.rssMB} MB`;
    badge.title = 'Node 进程当前常驻内存';
    $('#secMem').textContent = `${s.rssMB} MB`;
  }

  // ------------------------------------------------------------------
  // 主页信息
  // ------------------------------------------------------------------
  const PROFILE_FIELDS = ['name', 'role', 'tagline', 'avatar', 'bio', 'location', 'email', 'website', 'github', 'twitter', 'weibo', 'wechat'];
  const fieldEl = (key) => $(`#pf${key.charAt(0).toUpperCase()}${key.slice(1)}`);

  async function loadProfile() {
    const { profile } = await api('/api/admin/profile');
    PROFILE_FIELDS.forEach((k) => {
      const el = fieldEl(k);
      if (el) el.value = profile[k] || '';
    });
    updateAvatarPreview();
  }

  function updateAvatarPreview() {
    const url = $('#pfAvatar').value.trim();
    const img = $('#avatarPreview');
    img.src = url || 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 40 40%22%3E%3Crect width=%2240%22 height=%2240%22 fill=%22%23ddd%22/%3E%3C/svg%3E';
  }

  $('#pfAvatar').addEventListener('input', updateAvatarPreview);

  $('#avatarUploadBtn').addEventListener('click', () => $('#avatarFile').click());
  $('#avatarFile').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const status = $('#avatarStatus');
    status.textContent = '上传中…';
    try {
      const url = await uploadFile(file);
      $('#pfAvatar').value = url;
      updateAvatarPreview();
      status.textContent = '已上传，记得点保存';
    } catch (err) {
      status.textContent = err.message;
    } finally {
      e.target.value = '';
    }
  });

  $('#profileForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const hint = $('#profileHint');
    const payload = {};
    PROFILE_FIELDS.forEach((k) => {
      const el = fieldEl(k);
      if (el) payload[k] = el.value.trim();
    });
    hint.textContent = '保存中…';
    try {
      await api('/api/admin/profile', { method: 'PUT', body: JSON.stringify(payload) });
      hint.textContent = '已保存，打开前台即可看到变化';
      toast('主页信息已保存');
    } catch (err) {
      hint.textContent = err.message;
    }
  });

  // ------------------------------------------------------------------
  // 技能标签
  // ------------------------------------------------------------------
  async function loadSkills() {
    const { items } = await api('/api/admin/skills');
    const table = $('#skillTable');
    if (!items.length) {
      table.innerHTML = '<tr><td class="text-muted">还没有技能标签，点右上角新增。</td></tr>';
      return;
    }
    table.innerHTML = `
      <thead><tr><th>名称</th><th>分类</th><th>熟练度</th><th>排序</th><th></th></tr></thead>
      <tbody>
        ${items
          .map(
            (s) => `
          <tr data-id="${s.id}">
            <td><input class="field !py-1.5 text-[14px]" data-k="name" value="${esc(s.name)}" maxlength="40" /></td>
            <td><input class="field !py-1.5 text-[14px]" data-k="category" value="${esc(s.category)}" maxlength="20" /></td>
            <td>
              <select class="field !py-1.5 text-[14px]" data-k="level">
                ${[1, 2, 3, 4, 5].map((n) => `<option value="${n}"${n === s.level ? ' selected' : ''}>${n}</option>`).join('')}
              </select>
            </td>
            <td><input class="field !py-1.5 w-20 text-[14px]" data-k="sort" type="number" value="${s.sort}" /></td>
            <td class="whitespace-nowrap">
              <button class="mini-btn" data-act="save">保存</button>
              <button class="mini-btn danger" data-act="del">删除</button>
            </td>
          </tr>`
          )
          .join('')}
      </tbody>`;
  }

  $('#addSkillBtn').addEventListener('click', async () => {
    const name = prompt('技能名称（例如 Node.js）');
    if (!name) return;
    const category = prompt('分类（例如 开发 / 设计 / 运维）', '开发') || '通用';
    try {
      await api('/api/admin/skills', { method: 'POST', body: JSON.stringify({ name, category, level: 3, sort: 0 }) });
      toast('技能已添加');
      loadSkills();
    } catch (err) {
      toast(err.message, true);
    }
  });

  $('#skillTable').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const tr = btn.closest('tr');
    const id = tr.dataset.id;
    if (btn.dataset.act === 'del') {
      if (!confirm('确定删除这条技能？')) return;
      try {
        await api(`/api/admin/skills/${id}`, { method: 'DELETE' });
        toast('已删除');
        loadSkills();
      } catch (err) {
        toast(err.message, true);
      }
      return;
    }
    // 保存
    const payload = {};
    $$('[data-k]', tr).forEach((el) => (payload[el.dataset.k] = el.value));
    try {
      await api(`/api/admin/skills/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
      toast('已保存');
    } catch (err) {
      toast(err.message, true);
    }
  });

  // ------------------------------------------------------------------
  // 作品集
  // ------------------------------------------------------------------
  const PROJECT_EDITOR = `
    <div id="projectEditor" class="hidden rounded-card border border-line/10 bg-elev/50 p-6">
      <h2 id="peTitle" class="font-display text-[18px] font-semibold">新增作品</h2>
      <div class="mt-5 grid gap-5 sm:grid-cols-2">
        <div class="flex flex-col gap-2">
          <label class="text-[13px] font-medium" for="prTitle">标题</label>
          <input id="prTitle" class="field" maxlength="100" />
        </div>
        <div class="flex flex-col gap-2">
          <label class="text-[13px] font-medium" for="prLink">项目链接</label>
          <input id="prLink" class="field" placeholder="https://..." />
        </div>
        <div class="flex flex-col gap-2 sm:col-span-2">
          <label class="text-[13px] font-medium" for="prDesc">描述</label>
          <textarea id="prDesc" rows="3" class="field resize-y" maxlength="1000"></textarea>
        </div>
        <div class="flex flex-col gap-2 sm:col-span-2">
          <label class="text-[13px] font-medium" for="prImage">图片地址</label>
          <div class="flex flex-wrap items-center gap-3">
            <input id="prImage" class="field min-w-[220px] flex-1" placeholder="/uploads/xxx.jpg 或 https://..." />
            <input id="prFile" type="file" accept="image/*" class="hidden" />
            <button type="button" id="prUploadBtn" class="btn-ghost">上传图片</button>
            <span id="prUploadStatus" class="text-[12.5px] text-muted"></span>
          </div>
        </div>
        <div class="flex flex-col gap-2">
          <label class="text-[13px] font-medium" for="prTags">标签（逗号分隔）</label>
          <input id="prTags" class="field" placeholder="产品设计,Node.js" />
        </div>
        <div class="flex items-center gap-6">
          <div class="flex flex-col gap-2">
            <label class="text-[13px] font-medium" for="prSort">排序</label>
            <input id="prSort" type="number" class="field w-24" value="0" />
          </div>
          <label class="mt-6 flex cursor-pointer items-center gap-2 text-[14px]">
            <input id="prFeatured" type="checkbox" class="h-4 w-4 accent-[rgb(var(--c-accent))]" />
            首页突出显示
          </label>
        </div>
      </div>
      <div class="mt-6 flex items-center gap-3">
        <button type="button" id="prSave" class="btn-primary">保存</button>
        <button type="button" id="prCancel" class="mini-btn">取消</button>
        <span id="prHint" class="text-[13px] text-muted"></span>
      </div>
    </div>`;

  (function mountProjectEditor() {
    const panel = $('[data-panel="projects"]');
    const tableWrap = $('.overflow-x-auto', panel);
    const holder = document.createElement('div');
    holder.innerHTML = PROJECT_EDITOR;
    panel.insertBefore(holder.firstElementChild, tableWrap);
  })();

  let editingProjectId = 0;

  function openProjectEditor(item) {
    editingProjectId = item ? item.id : 0;
    $('#peTitle').textContent = item ? '编辑作品' : '新增作品';
    $('#prTitle').value = item ? item.title : '';
    $('#prDesc').value = item ? item.description : '';
    $('#prImage').value = item ? item.image : '';
    $('#prLink').value = item ? item.link : '';
    $('#prTags').value = item ? item.tags : '';
    $('#prSort').value = item ? item.sort : 0;
    $('#prFeatured').checked = item ? !!item.featured : false;
    $('#prHint').textContent = '';
    $('#projectEditor').classList.remove('hidden');
    $('#projectEditor').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function closeProjectEditor() {
    $('#projectEditor').classList.add('hidden');
    editingProjectId = 0;
  }

  $('#prCancel').addEventListener('click', closeProjectEditor);
  $('#addProjectBtn').addEventListener('click', () => openProjectEditor(null));
  $('#prUploadBtn').addEventListener('click', () => $('#prFile').click());
  $('#prFile').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const status = $('#prUploadStatus');
    status.textContent = '上传中…';
    try {
      const url = await uploadFile(file);
      $('#prImage').value = url;
      status.textContent = '上传完成';
    } catch (err) {
      status.textContent = err.message;
    } finally {
      e.target.value = '';
    }
  });

  $('#prSave').addEventListener('click', async () => {
    const payload = {
      title: $('#prTitle').value.trim(),
      description: $('#prDesc').value.trim(),
      image: $('#prImage').value.trim(),
      link: $('#prLink').value.trim(),
      tags: $('#prTags').value.trim(),
      sort: Number($('#prSort').value) || 0,
      featured: $('#prFeatured').checked,
    };
    if (!payload.title) return toast('标题不能为空', true);
    try {
      if (editingProjectId) {
        await api(`/api/admin/projects/${editingProjectId}`, { method: 'PUT', body: JSON.stringify(payload) });
      } else {
        await api('/api/admin/projects', { method: 'POST', body: JSON.stringify(payload) });
      }
      toast('作品已保存');
      closeProjectEditor();
      loadProjects();
    } catch (err) {
      toast(err.message, true);
    }
  });

  let projectCache = [];

  async function loadProjects() {
    const { items } = await api('/api/admin/projects');
    projectCache = items;
    const table = $('#projectTable');
    if (!items.length) {
      table.innerHTML = '<tr><td class="text-muted">还没有作品，点右上角「新增作品」。</td></tr>';
      return;
    }
    table.innerHTML = `
      <thead><tr><th>预览</th><th>标题</th><th>标签</th><th>排序</th><th>链接</th><th></th></tr></thead>
      <tbody>
        ${items
          .map(
            (p) => `
          <tr data-id="${p.id}">
            <td>${
              p.image
                ? `<img src="${esc(p.image)}" alt="" width="64" height="44" loading="lazy"
                        class="h-11 w-16 rounded-lg border border-line/10 object-cover"
                        onerror="this.style.visibility='hidden'" />`
                : '<span class="text-muted">无图</span>'
            }</td>
            <td>
              <div class="font-medium">${esc(p.title)}${p.featured ? ' <span class="tag">突出</span>' : ''}</div>
              <div class="mt-1 max-w-[46ch] text-[13px] text-muted">${esc((p.description || '').slice(0, 70))}</div>
            </td>
            <td class="text-[13px] text-muted">${esc(p.tags || '-')}</td>
            <td class="font-mono text-[13px]">${p.sort}</td>
            <td>${
              p.link
                ? `<a class="mini-btn" href="${esc(p.link)}" target="_blank" rel="noopener noreferrer nofollow">打开</a>`
                : '-'
            }</td>
            <td class="whitespace-nowrap">
              <button class="mini-btn" data-act="edit">编辑</button>
              <button class="mini-btn danger" data-act="del">删除</button>
            </td>
          </tr>`
          )
          .join('')}
      </tbody>`;
  }

  $('#projectTable').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const id = Number(btn.closest('tr').dataset.id);
    const item = projectCache.find((p) => p.id === id);
    if (btn.dataset.act === 'edit') return openProjectEditor(item);
    if (!confirm(`确定删除作品「${item ? item.title : id}」？`)) return;
    try {
      await api(`/api/admin/projects/${id}`, { method: 'DELETE' });
      toast('已删除');
      loadProjects();
    } catch (err) {
      toast(err.message, true);
    }
  });

  // ------------------------------------------------------------------
  // 博客文章
  // ------------------------------------------------------------------
  let editingPostId = 0;
  let postCache = [];

  async function loadPosts() {
    const { items } = await api('/api/admin/posts?limit=100');
    postCache = items;
    const table = $('#postTable');
    if (!items.length) {
      table.innerHTML = '<tr><td class="text-muted">还没有文章，点右上角「写新文章」。</td></tr>';
      return;
    }
    table.innerHTML = `
      <thead><tr><th>标题</th><th>标签</th><th>状态</th><th>阅读</th><th>创建时间</th><th></th></tr></thead>
      <tbody>
        ${items
          .map(
            (p) => `
          <tr data-id="${p.id}">
            <td>
              <div class="font-medium">${esc(p.title)}</div>
              <div class="mt-1 font-mono text-[12px] text-muted">/${esc(p.slug)}</div>
            </td>
            <td class="text-[13px] text-muted">${esc(p.tags || '-')}</td>
            <td>${p.published ? '<span class="tag">已发布</span>' : '<span class="tag">草稿</span>'}</td>
            <td class="font-mono text-[13px]">${p.views}</td>
            <td class="font-mono text-[12.5px] text-muted">${esc(fmtTime(p.created_at))}</td>
            <td class="whitespace-nowrap">
              <button class="mini-btn" data-act="edit">编辑</button>
              ${
                p.published
                  ? `<a class="mini-btn" href="/#/post/${esc(p.slug)}" target="_blank" rel="noopener">预览</a>`
                  : ''
              }
              <button class="mini-btn danger" data-act="del">删除</button>
            </td>
          </tr>`
          )
          .join('')}
      </tbody>`;
  }

  function openEditor(post) {
    editingPostId = post ? post.id : 0;
    $('#editorTitle').textContent = post ? '编辑文章' : '写新文章';
    $('#poTitle').value = post ? post.title : '';
    $('#poSlug').value = post ? post.slug : '';
    $('#poSummary').value = post ? post.summary : '';
    $('#poTags').value = post ? post.tags : '';
    $('#poContent').value = post ? post.content : '';
    $('#poPublished').checked = post ? !!post.published : true;
    $('#editorHint').textContent = '';
    $('#postListWrap').classList.add('hidden');
    $('#postEditor').classList.remove('hidden');
    renderPreview();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function closeEditor() {
    $('#postEditor').classList.add('hidden');
    $('#postListWrap').classList.remove('hidden');
    editingPostId = 0;
  }

  function renderPreview() {
    const md = $('#poContent').value;
    $('#mdCount').textContent = `${md.length} 字`;
    const box = $('#mdPreview');
    if (window.marked && window.DOMPurify) {
      box.innerHTML = window.DOMPurify.sanitize(window.marked.parse(md, { gfm: true }), {
        USE_PROFILES: { html: true },
      });
    } else {
      box.textContent = md || '（预览库加载中，仍可正常保存）';
    }
  }

  let previewTimer = 0;
  $('#poContent').addEventListener('input', () => {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(renderPreview, 180); // 防抖，避免每次按键都重排
  });

  $('#newPostBtn').addEventListener('click', () => openEditor(null));
  $('#cancelPostBtn').addEventListener('click', closeEditor);

  $('#savePostBtn').addEventListener('click', async () => {
    const payload = {
      title: $('#poTitle').value.trim(),
      slug: $('#poSlug').value.trim(),
      summary: $('#poSummary').value.trim(),
      tags: $('#poTags').value.trim(),
      content: $('#poContent').value,
      published: $('#poPublished').checked,
    };
    if (!payload.title) return toast('标题不能为空', true);
    if (payload.content.trim().length < 1) return toast('正文不能为空', true);

    const hint = $('#editorHint');
    hint.textContent = '保存中…';
    try {
      if (editingPostId) {
        await api(`/api/admin/posts/${editingPostId}`, { method: 'PUT', body: JSON.stringify(payload) });
      } else {
        await api('/api/admin/posts', { method: 'POST', body: JSON.stringify(payload) });
      }
      toast('文章已保存');
      closeEditor();
      loadPosts();
    } catch (err) {
      hint.textContent = err.message;
      toast(err.message, true);
    }
  });

  $('#postTable').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const id = Number(btn.closest('tr').dataset.id);
    const post = postCache.find((p) => p.id === id);
    if (btn.dataset.act === 'del') {
      if (!confirm(`确定删除文章「${post ? post.title : id}」？该操作不可恢复。`)) return;
      try {
        await api(`/api/admin/posts/${id}`, { method: 'DELETE' });
        toast('已删除');
        loadPosts();
      } catch (err) {
        toast(err.message, true);
      }
      return;
    }
    // 编辑需要完整正文，单独拉一次详情
    try {
      const { post: full } = await api(`/api/admin/posts/${id}`);
      openEditor(full);
    } catch (err) {
      toast(err.message, true);
    }
  });

  // ------------------------------------------------------------------
  // 留言管理
  // ------------------------------------------------------------------
  async function loadMessages() {
    const { items, total } = await api('/api/admin/messages?limit=100');
    const table = $('#messageTable');
    if (!items.length) {
      table.innerHTML = '<tr><td class="text-muted">还没有访客留言。</td></tr>';
      return;
    }
    table.innerHTML = `
      <thead><tr><th>访客</th><th>内容</th><th>来源 IP</th><th>时间</th><th>状态</th><th></th></tr></thead>
      <tbody>
        ${items
          .map(
            (m) => `
          <tr data-id="${m.id}">
            <td>
              <div class="font-medium">${esc(m.name)}</div>
              ${m.email ? `<div class="mt-1 text-[12.5px] text-muted">${esc(m.email)}</div>` : ''}
            </td>
            <td class="max-w-[42ch] whitespace-pre-line text-[14px]">${esc(m.content)}</td>
            <td class="font-mono text-[12.5px] text-muted">${esc(m.ip)}</td>
            <td class="font-mono text-[12.5px] text-muted">${esc(fmtTime(m.created_at))}</td>
            <td>${m.approved ? '<span class="tag">显示中</span>' : '<span class="tag">已隐藏</span>'}</td>
            <td class="whitespace-nowrap">
              <button class="mini-btn" data-act="toggle">${m.approved ? '隐藏' : '显示'}</button>
              <button class="mini-btn danger" data-act="del">删除</button>
            </td>
          </tr>`
          )
          .join('')}
      </tbody>`;
    if (total > items.length) {
      table.insertAdjacentHTML(
        'afterend',
        `<p class="px-3 py-2 text-[13px] text-muted">共 ${total} 条，当前展示最近 ${items.length} 条。</p>`
      );
    }
  }

  $('#refreshMsgBtn').addEventListener('click', loadMessages);

  $('#messageTable').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const tr = btn.closest('tr');
    const id = Number(tr.dataset.id);
    const approvedNow = tr.querySelector('.tag').textContent === '显示中';
    try {
      if (btn.dataset.act === 'toggle') {
        await api(`/api/admin/messages/${id}`, {
          method: 'PATCH',
          body: JSON.stringify({ approved: !approvedNow }),
        });
        toast(approvedNow ? '已从前台隐藏' : '已在前台显示');
      } else {
        if (!confirm('确定删除这条留言？')) return;
        await api(`/api/admin/messages/${id}`, { method: 'DELETE' });
        toast('已删除');
      }
      loadMessages();
    } catch (err) {
      toast(err.message, true);
    }
  });

  // ------------------------------------------------------------------
  // 安全设置
  // ------------------------------------------------------------------
  $('#pwdForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const hint = $('#pwdHint');
    const current = $('#pwCurrent').value;
    const next = $('#pwNext').value;
    const confirmPwd = $('#pwConfirm').value;

    hint.style.color = '';
    if (next !== confirmPwd) {
      hint.textContent = '两次输入的新密码不一致';
      hint.style.color = '#d0453b';
      return;
    }
    if (next.length < 8 || !/[a-zA-Z]/.test(next) || !/[0-9]/.test(next)) {
      hint.textContent = '新密码至少 8 位，且需同时包含字母与数字';
      hint.style.color = '#d0453b';
      return;
    }
    hint.textContent = '提交中…';
    try {
      const res = await api('/api/admin/password', {
        method: 'POST',
        body: JSON.stringify({ currentPassword: current, newPassword: next }),
      });
      hint.textContent = res.message || '密码已更新';
      toast('密码已更新，请重新登录');
      setTimeout(() => location.reload(), 1500);
    } catch (err) {
      hint.textContent = err.message;
      hint.style.color = '#d0453b';
    }
  });

  async function loadSecurity() {
    const s = await api('/api/admin/session');
    $('#secUser').textContent = s.username;
    $('#secLast').textContent = fmtTime(s.lastLoginAt);
    $('#secWarn').classList.toggle('hidden', !s.secretIsEphemeral);
  }

  // ------------------------------------------------------------------
  // 启动
  // ------------------------------------------------------------------
  async function boot() {
    try {
      const session = await api('/api/admin/session');
      showApp();
      $('#secUser').textContent = session.username;
      $('#secLast').textContent = fmtTime(session.lastLoginAt);
      $('#secWarn').classList.toggle('hidden', !session.secretIsEphemeral);
      switchView(location.hash.slice(1) || 'overview');

      // 各个模块并行加载，某个失败不影响其它模块
      loadOverview().catch((e) => toast(`概览加载失败：${e.message}`, true));
      loadProfile().catch((e) => toast(`主页信息加载失败：${e.message}`, true));
      loadSkills().catch((e) => toast(`技能加载失败：${e.message}`, true));
      loadProjects().catch((e) => toast(`作品加载失败：${e.message}`, true));
      loadPosts().catch((e) => toast(`文章加载失败：${e.message}`, true));
      loadMessages().catch((e) => toast(`留言加载失败：${e.message}`, true));
      loadSecurity().catch(() => {});

      // 概览里的内存数字每分钟刷新一次，方便观察是否有持续上涨
      setInterval(() => {
        if (!$('[data-panel="overview"]').classList.contains('hidden')) {
          loadOverview().catch(() => {});
        }
      }, 60000);
    } catch (_) {
      showLogin('');
    }
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
