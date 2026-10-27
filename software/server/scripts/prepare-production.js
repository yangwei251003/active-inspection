import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { token, hashPassword } from '../src/security.js';
import { serverRoot } from '../src/config.js';
// 此脚本只写私密配置；不会登录、购买、开放端口或部署服务器。
const rl = createInterface({ input: process.stdin, output: process.stdout });
try {
  const dir = path.join(serverRoot, 'deploy', 'secrets');
  const configFile = path.join(dir, 'config.production.json'), envFile = path.join(serverRoot, 'deploy', '.env');
  if (fs.existsSync(configFile) || fs.existsSync(envFile)) throw new Error('Production files already exist; back them up and inspect them before replacing. Refusing partial overwrite.');
  const domain = (await rl.question('已拥有并指向常开服务器的域名（不含 https://）：')).trim();
  if (!/^(?=.{4,253}$)[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])$/.test(domain) || !domain.includes('.') || domain.includes('..')) throw new Error('Invalid domain.');
  const password = await rl.question('设置 14–256 字符管理口令（终端会显示输入，不要共享屏幕）：');
  if (password.length < 14 || password.length > 256) throw new Error('Invalid password length.');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const config = { production: true, host: '0.0.0.0', port: 8080, source: 'hardware', deviceId: 'inspection-01', passwordHash: hashPassword(password), deviceToken: token(), mediaToken: token(), mediaPublishToken: token(), secureCookies: true, publicOrigin: `https://${domain}`, dataDir: '/data', webDir: '/app/web', mediaUrl: 'http://mediamtx:8889' };
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  fs.writeFileSync(envFile, `DOMAIN=${domain}\nPUBLIC_MEDIA_HOST=${domain}\n`, { flag: 'wx', mode: 0o600 });
  console.log('生产配置已生成，未部署。设备 token 存在 secrets/config.production.json；不要上传、截图或分享。');
} finally { rl.close(); }
