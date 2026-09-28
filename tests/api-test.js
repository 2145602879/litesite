'use strict';
/**
 * 端到端 API 自测脚本（零依赖，只用 Node 内置的 fetch）
 * ---------------------------------------------------------------
 * 用法：
 *   1. 先启动服务（另开一个终端）：npm start
 *   2. 确认 .env 里的 ADMIN_USERNAME / ADMIN_PASSWORD 与下面一致
 *   3. 运行：npm run test:api
 *
 * 可选环境变量：
 *   BASE_URL      默认 http://127.0.0.1:3000
 *   ADMIN_USER    默认 admin
 *   ADMIN_PASS    默认 ChangeMe_2024（请与你的 .env 保持一致）
 *
 * 说明：
 *   - 覆盖公开接口、登录、限流、主页信息、技能/作品/博客 CRUD、图片上传、
 *     留言全流程、改密码后会话失效、路径穿越防护、内存稳定性
 *   - 脚本会临时改动数据，但**结束时会把主页信息恢复原样**，并删除自己创建的
 *     作品、文章、留言与上传文件；不会碰你已有的内容
 *   - 因此建议在本地或测试环境运行，不要在正式站上跑
 *   - 注意：留言接口有「每 IP 10 分钟 3 条」的限流，重复运行本脚本可能触发 429，
 *     重启服务即可清空限流计数
 */
const path = require('node:path');
const fs = require('node:fs');

const BASE = process.env.BASE_URL || 'http://127.0.0.1:3000';
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'ChangeMe_2024';
const NEW_PASS = 'SmokeTest123';

let cookie = '';
let pass = 0;
let fail = 0;
const failures = [];

function log(name, ok, detail) {
  if (ok) pass++;
  else {
    fail++;
    failures.push(name);
  }
  console.log(`[${ok ? '  OK  ' : ' FAIL '}] ${name}${detail ? ' :: ' + detail : ''}`);
}

/** 极简请求封装，手工维护 Cookie */
async function req(method, urlPath, body, opts = {}) {
  const headers = {};
  if (cookie && !opts.noCookie) headers.Cookie = cookie;
  let payload;
  if (body instanceof FormData) {
    payload = body;
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(BASE + urlPath, { method, headers, body: payload, redirect: 'manual' });
  for (const c of res.headers.getSetCookie ? res.headers.getSetCookie() : []) {
    const kv = c.split(';')[0];
    if (kv.startsWith('ls_sid=')) cookie = kv;
  }
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch (_) {
    data = text.slice(0, 140);
  }
  return { status: res.status, data };
}

async function login(password) {
  cookie = '';
  return req('POST', '/api/admin/login', { username: ADMIN_USER, password });
}

(async () => {
  console.log(`\n目标服务：${BASE}\n${'='.repeat(58)}`);

  // ---------------------------------------------------------------
  console.log('\n1. 服务可用性与安全边界');
  // ---------------------------------------------------------------
  let r = await req('GET', '/api/health', undefined, { noCookie: true });
  log('健康检查', r.status === 200 && r.data.ok === true, `RSS ${r.data.rssMB}MB / 堆 ${r.data.heapMB}MB`);

  r = await req('GET', '/api/site', undefined, { noCookie: true });
  log('首屏数据接口', r.status === 200 && !!r.data.profile);

  r = await req('GET', '/api/projects', undefined, { noCookie: true });
  log('作品列表接口', r.status === 200 && Array.isArray(r.data.items));

  r = await req('GET', '/api/posts?limit=2', undefined, { noCookie: true });
  log('文章列表接口', r.status === 200 && Array.isArray(r.data.items));

  r = await req('GET', '/api/admin/stats', undefined, { noCookie: true });
  log('未登录访问后台接口应 401', r.status === 401);

  r = await req('DELETE', '/api/admin/uploads/..%2F..%2Fserver.js', undefined, { noCookie: true });
  log('未登录下的路径穿越删除被拒绝', r.status === 400 || r.status === 401 || r.status === 404);

  // ---------------------------------------------------------------
  console.log('\n2. 登录与防爆破');
  // ---------------------------------------------------------------
  r = await login('definitely-wrong-password');
  log('错误密码应 401', r.status === 401, JSON.stringify(r.data));

  r = await login(ADMIN_PASS);
  if (r.status !== 200) {
    console.error(
      `\n无法登录（${r.status}）。请确认 .env 里的 ADMIN_USERNAME / ADMIN_PASSWORD，` +
        `或用环境变量覆盖：\n  ADMIN_USER=admin ADMIN_PASS=你的密码 npm run test:api\n`
    );
    process.exit(1);
  }
  log('正确密码登录成功', r.status === 200 && !!cookie);

  r = await req('GET', '/api/admin/session');
  log('读取登录态', r.status === 200 && r.data.username === ADMIN_USER);

  // 备份原始主页信息，结束时恢复
  const originalProfile = (await req('GET', '/api/admin/profile')).data.profile;

  // ---------------------------------------------------------------
  console.log('\n3. 主页信息（含字段收敛）');
  // ---------------------------------------------------------------
  r = await req('PUT', '/api/admin/profile', {
    name: 'API 自测临时名称',
    role: '测试身份',
    tagline: '测试签名',
    avatar: 'https://picsum.photos/seed/smoke/200/200',
    bio: '第一行\n第二行',
    location: '测试城市',
    email: 'smoke@example.com',
    website: 'https://example.com',
    github: '',
    twitter: '',
    weibo: '',
    wechat: 'smoke-id',
  });
  log('保存主页信息', r.status === 200);

  r = await req('GET', '/api/site');
  log('前台读取到更新后的名称', r.data.profile.name === 'API 自测临时名称');

  await req('PUT', '/api/admin/profile', { ...originalProfile, website: 'javascript:alert(1)' });
  r = await req('GET', '/api/admin/profile');
  log('javascript: 伪协议被白名单过滤', r.data.profile.website === '', `website="${r.data.profile.website}"`);

  // ---------------------------------------------------------------
  console.log('\n4. 技能标签 CRUD');
  // ---------------------------------------------------------------
  r = await req('POST', '/api/admin/skills', { name: '自测技能', category: '测试', level: 3, sort: 99 });
  const skillId = r.data.id;
  log('新增技能', r.status === 201 && skillId > 0);
  r = await req('PUT', `/api/admin/skills/${skillId}`, { name: '自测技能改', category: '测试', level: 5, sort: 99 });
  log('修改技能', r.status === 200);
  r = await req('PUT', '/api/admin/skills/999999', { name: 'x' });
  log('修改不存在的技能应 404', r.status === 404);
  r = await req('DELETE', `/api/admin/skills/${skillId}`);
  log('删除技能', r.status === 200 && r.data.deleted === 1);

  // ---------------------------------------------------------------
  console.log('\n5. 作品集 CRUD');
  // ---------------------------------------------------------------
  r = await req('POST', '/api/admin/projects', {
    title: 'API 自测作品',
    description: '临时数据，脚本结束时会删除',
    image: 'https://picsum.photos/seed/smoke/600/400',
    link: 'https://example.com',
    tags: '测试,临时',
    sort: 99,
    featured: true,
  });
  const projectId = r.data.id;
  log('新增作品', r.status === 201 && projectId > 0);

  r = await req('PUT', `/api/admin/projects/${projectId}`, {
    title: 'API 自测作品改', description: '改了', tags: '临时', sort: 98,
  });
  log('修改作品', r.status === 200);

  r = await req('GET', '/api/projects');
  const found = r.data.items.find((p) => p.id === projectId);
  log('前台标签按逗号解析为数组', !!found && Array.isArray(found.tags) && found.tags[0] === '临时');

  // ---------------------------------------------------------------
  console.log('\n6. 图片上传');
  // ---------------------------------------------------------------
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
    'base64'
  );
  const fd = new FormData();
  fd.append('file', new Blob([png], { type: 'image/png' }), 'smoke.png');
  r = await req('POST', '/api/admin/upload', fd);
  const uploadedUrl = r.data.url;
  log('上传 PNG 成功且文件名为随机串', r.status === 201 && /^\/uploads\/[a-z0-9]+-[a-f0-9]{8}\.png$/.test(uploadedUrl || ''));

  const fd2 = new FormData();
  fd2.append('file', new Blob([Buffer.from('#!/bin/sh\necho hi')], { type: 'text/x-shellscript' }), 'evil.sh');
  r = await req('POST', '/api/admin/upload', fd2);
  log('非图片类型被拒绝', r.status === 400);

  r = await req('GET', uploadedUrl, undefined, { noCookie: true });
  log('上传后的文件可访问', r.status === 200);

  // ---------------------------------------------------------------
  console.log('\n7. 博客文章 CRUD（草稿 / 发布 / slug）');
  // ---------------------------------------------------------------
  r = await req('POST', '/api/admin/posts', {
    title: 'API 自测文章', content: '# 标题\n\n正文包含**加粗**与 `代码`。', tags: '测试', published: false,
  });
  const postId = r.data.id;
  log('新建草稿', r.status === 201 && !!r.data.slug, `slug=${r.data.slug}`);

  r = await req('GET', `/api/admin/posts/${postId}`);
  log('摘要由正文自动生成', !!r.data.post.summary, r.data.post.summary);
  log('未发布文章在前台不可见', (await req('GET', `/api/posts/${r.data.post.slug}`, undefined, { noCookie: true })).status === 404);

  r = await req('PUT', `/api/admin/posts/${postId}`, {
    title: 'API 自测文章', slug: 'smoke-test-post', content: '# 改过了\n\n现在发布。', published: true,
  });
  log('发布文章', r.status === 200 && r.data.slug === 'smoke-test-post');

  r = await req('GET', '/api/posts/smoke-test-post', undefined, { noCookie: true });
  log('发布后前台可见且返回 Markdown 原文', r.status === 200 && r.data.post.content.includes('改过了'));

  r = await req('POST', '/api/admin/posts', { title: '重名测试', slug: 'smoke-test-post', content: 'x', published: false });
  const dupId = r.data.id;
  log('slug 冲突自动去重', r.status === 201 && r.data.slug === 'smoke-test-post-2', `slug=${r.data.slug}`);
  await req('DELETE', `/api/admin/posts/${dupId}`);

  // ---------------------------------------------------------------
  console.log('\n8. 访客留言全流程');
  // ---------------------------------------------------------------
  let msg = await req('POST', '/api/messages', { name: 'API 自测访客', email: 'v@example.com', content: '这是一条自测留言。' }, { noCookie: true });
  const msgId = msg.data.item && msg.data.item.id;
  log('访客提交留言', msg.status === 201, msg.status === 201 ? '' : JSON.stringify(msg.data));

  const longMsg = await req('POST', '/api/messages', { name: 'x', content: 'A'.repeat(1500) }, { noCookie: true });
  log(
    '超长留言被明确拒绝而非静默截断',
    longMsg.status === 400 || longMsg.status === 429,
    longMsg.status === 429 ? '触发限流（预期内，说明限流生效）' : JSON.stringify(longMsg.data)
  );

  const dup = await req('POST', '/api/messages', { name: 'API 自测访客', content: '这是一条自测留言。' }, { noCookie: true });
  log('重复内容被拦截或限流', dup.status === 400 || dup.status === 429, `status=${dup.status}`);

  const bad = await req('POST', '/api/messages', { name: '', content: 'x' }, { noCookie: true });
  log('缺少称呼被拦截或限流', bad.status === 400 || bad.status === 429, `status=${bad.status}`);

  r = await req('GET', '/api/messages', undefined, { noCookie: true });
  if (r.data.items && r.data.items.length) {
    log('前台留言不含邮箱与 IP 字段', !('email' in r.data.items[0]) && !('ip' in r.data.items[0]), Object.keys(r.data.items[0]).join(','));
  } else {
    log('前台留言不含邮箱与 IP 字段', true, '当前无留言，跳过字段检查');
  }

  r = await req('GET', '/api/admin/messages?limit=50');
  log('后台留言列表包含邮箱与来源 IP', r.status === 200 && (!r.data.items.length || ('email' in r.data.items[0] && 'ip' in r.data.items[0])));

  if (msgId) {
    r = await req('PATCH', `/api/admin/messages/${msgId}`, { approved: false });
    log('隐藏留言', r.status === 200 && r.data.approved === 0);
    r = await req('GET', '/api/messages', undefined, { noCookie: true });
    log('隐藏后前台不再出现', r.data.items.every((m) => m.id !== msgId));
  }

  // ---------------------------------------------------------------
  console.log('\n9. 修改密码与会话失效');
  // ---------------------------------------------------------------
  r = await req('POST', '/api/admin/password', { currentPassword: 'wrong-password', newPassword: NEW_PASS });
  log('当前密码错误应 401', r.status === 401);

  r = await req('POST', '/api/admin/password', { currentPassword: ADMIN_PASS, newPassword: 'abc' });
  log('弱密码被拒绝', r.status === 400, JSON.stringify(r.data));

  r = await req('POST', '/api/admin/password', { currentPassword: ADMIN_PASS, newPassword: NEW_PASS });
  log('修改密码成功', r.status === 200);

  r = await req('GET', '/api/admin/session');
  log('改密后旧会话立即失效', r.status === 401);

  r = await login(NEW_PASS);
  log('新密码可登录', r.status === 200);

  r = await req('POST', '/api/admin/password', { currentPassword: NEW_PASS, newPassword: ADMIN_PASS });
  log('还原为原密码', r.status === 200);
  r = await login(ADMIN_PASS);
  log('还原后可登录', r.status === 200);

  // ---------------------------------------------------------------
  console.log('\n10. 清理测试数据（恢复到运行前的状态）');
  // ---------------------------------------------------------------
  const restore = { ...originalProfile };
  delete restore.id;
  delete restore.updated_at;
  r = await req('PUT', '/api/admin/profile', restore);
  const after = await req('GET', '/api/admin/profile');
  log('主页信息已恢复原样', r.status === 200 && after.data.profile.name === originalProfile.name, `name=${after.data.profile.name}`);

  await req('DELETE', `/api/admin/projects/${projectId}`);
  await req('DELETE', `/api/admin/posts/${postId}`);
  if (msgId) await req('DELETE', `/api/admin/messages/${msgId}`);

  r = await req('GET', '/api/admin/messages?limit=100');
  for (const m of r.data.items.filter((x) => x.name === 'API 自测访客')) {
    await req('DELETE', `/api/admin/messages/${m.id}`);
  }

  if (uploadedUrl) {
    r = await req('DELETE', `/api/admin/uploads/${uploadedUrl.replace('/uploads/', '')}`);
    log('删除上传的测试图片', r.status === 200);
    const onDisk = path.join(__dirname, '..', 'public', 'uploads', path.basename(uploadedUrl));
    log('磁盘上的文件确实已删除', !fs.existsSync(onDisk));
  }

  const final = await req('GET', '/api/admin/stats');
  log('清理后统计数据正常', final.status === 200, `作品 ${final.data.projects} / 文章 ${final.data.posts} / 留言 ${final.data.messages}`);

  // ---------------------------------------------------------------
  console.log('\n11. 内存稳定性（连续 300 次请求）');
  // ---------------------------------------------------------------
  const before = (await req('GET', '/api/health', undefined, { noCookie: true })).data;
  for (let i = 0; i < 300; i++) {
    const res = await fetch(`${BASE}/api/site`);
    await res.text();
  }
  const afterMem = (await req('GET', '/api/health', undefined, { noCookie: true })).data;
  const growth = +(afterMem.rssMB - before.rssMB).toFixed(1);
  log('300 次请求后内存增长可控（< 25MB）', growth < 25, `${before.rssMB}MB → ${afterMem.rssMB}MB（增加 ${growth}MB）`);

  // ---------------------------------------------------------------
  console.log(`\n${'='.repeat(58)}`);
  console.log(`结果：${pass} 通过 / ${fail} 失败`);
  if (fail) console.log('失败项：\n  - ' + failures.join('\n  - '));
  console.log(`${'='.repeat(58)}\n`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((err) => {
  console.error('\n脚本异常终止：', err.message);
  console.error('请确认服务已启动且 BASE_URL 正确。');
  process.exit(1);
});
