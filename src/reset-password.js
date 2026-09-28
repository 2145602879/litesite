'use strict';
/**
 * 重置管理员密码（忘记密码时的救援脚本）
 * ---------------------------------------------------------------
 * 用法：
 *   npm run reset-password                     # 交互式输入
 *   npm run reset-password -- admin NewPass123 # 直接指定账号与新密码
 *
 * 注意：请在服务器上执行，改完无需重启服务（旧登录会话会自动失效）。
 */
require('dotenv').config();
const readline = require('node:readline');
const bcrypt = require('bcryptjs');
const db = require('./db');

function updatePassword(username, password) {
  const user = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (!user) {
    console.error(`✗ 账号 "${username}" 不存在。现有账号：` +
      db.prepare('SELECT username FROM users').all().map((u) => u.username).join(', '));
    process.exit(1);
  }
  if (password.length < 8) {
    console.error('✗ 密码至少 8 位');
    process.exit(1);
  }
  const hash = bcrypt.hashSync(password, 10);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, user.id);
  console.log(`✓ 账号 "${username}" 的密码已重置（旧登录会话全部失效）`);
  db.close();
}

const [, , argUser, argPass] = process.argv;

if (argUser && argPass) {
  updatePassword(argUser, argPass);
} else {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise((resolve) => rl.question(q, resolve));
  (async () => {
    const defaultUser = db.prepare('SELECT username FROM users ORDER BY id LIMIT 1').get();
    const username = (await ask(`账号 [${defaultUser ? defaultUser.username : 'admin'}]: `)).trim() ||
      (defaultUser ? defaultUser.username : 'admin');
    const password = (await ask('新密码（至少 8 位，输入时不回显请直接回车确认）: ')).trim();
    rl.close();
    updatePassword(username, password);
  })();
}
