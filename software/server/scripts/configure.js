import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { hashPassword, token } from '../src/security.js';
import { serverRoot } from '../src/config.js';
const target = path.join(serverRoot, 'config.local.json');
if (fs.existsSync(target)) throw new Error('config.local.json exists; edit deliberately or back it up. Refusing overwrite.');
const rl = createInterface({ input: process.stdin, output: process.stdout });
try {
  console.log('此步骤仅生成本机私密配置，不会发布。终端输入口令时会显示字符，避免共享屏幕。');
  const password = await rl.question('设置至少 14 字符登录口令：');
  if (password.length < 14 || password.length > 256) throw new Error('Password must contain 14–256 characters.');
  const config = { production: false, host: '127.0.0.1', port: 8080, source: 'hardware', deviceId: 'inspection-01', passwordHash: hashPassword(password), deviceToken: token(), mediaToken: token(), mediaPublishToken: token(), secureCookies: false, dataDir: 'data', webDir: '../web', mediaUrl: null };
  fs.writeFileSync(target, JSON.stringify(config, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log('已创建 config.local.json（被 git 忽略）。设备令牌仅保存在该文件，未输出。');
} finally { rl.close(); }
