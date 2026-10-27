// 仅用于环回媒体集成测试；凭据写入测试进程的私有临时目录，绝不输出。
import fs from 'node:fs';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { token, hashPassword } from '../src/security.js';

const [directory, portText, mediaPortText] = process.argv.slice(2);
if (!directory || !/^\d+$/.test(portText) || !/^\d+$/.test(mediaPortText)) throw Error('temporary directory, application port and media port required');
const password = token(), deviceToken = token();
const app = createApp({
  dataDir: path.join(directory, 'data'), source: 'simulator', host: '127.0.0.1', port: Number(portText),
  passwordHash: hashPassword(password), deviceToken, mediaToken: token(), mediaPublishToken: token(),
  mediaUrl: `http://127.0.0.1:${mediaPortText}`, heartbeatMs: 50,
});
const origin = await app.listen();
fs.writeFileSync(path.join(directory, 'access.local.json'), JSON.stringify({ origin, password, deviceToken }), { mode: 0o600, flag: 'wx' });
console.log('Loopback-only media test application ready; credentials omitted.');
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, async () => { await app.close(); process.exit(0); });
