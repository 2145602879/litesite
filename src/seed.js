'use strict';
/**
 * 初始化 / 检查数据库
 * 用法：
 *   npm run seed            # 首次部署时执行，写入示例内容（已有数据不会覆盖）
 *   npm run seed -- --stat  # 只查看各表数据量
 *
 * 说明：require('../db') 时就会自动建表并补齐缺失的初始数据，
 *      本脚本主要提供一个可读的执行入口与结果汇报。
 */
require('dotenv').config();
const path = require('node:path');
const db = require('./db');
const config = require('./config');

const tables = ['profile', 'skills', 'projects', 'posts', 'messages', 'users'];

console.log('数据库文件：', path.resolve(config.db.file));
console.log('---------------------------------------------');
for (const t of tables) {
  const c = db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c;
  const flag = c === 0 ? ' (空)' : '';
  console.log(`  ${t.padEnd(10)} ${String(c).padStart(4)} 条${flag}`);
}
console.log('---------------------------------------------');
const admin = db.prepare('SELECT username FROM users ORDER BY id LIMIT 1').get();
console.log('管理员账号：', admin ? admin.username : '(未创建，请检查 .env)');
console.log('完成。启动服务：npm start  或  pm2 start ecosystem.config.js');
db.close();
