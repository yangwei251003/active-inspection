import fs from 'node:fs';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { connectSimulator } from '../src/simulator.js';
import { hashPassword, token } from '../src/security.js';
import { serverRoot } from '../src/config.js';
// 只供本机隔离浏览器联调；随机测试口令不输出日志且退出即作废。
const directory = path.join(serverRoot, 'data', 'ui-test'); fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
const accessFile = path.join(directory, 'access.local.json');
const password = token(), deviceToken = token();
const app = createApp({ source: 'simulator', passwordHash: hashPassword(password), deviceToken, dataDir: directory, port: 0 });
const origin = await app.listen();
fs.writeFileSync(accessFile, JSON.stringify({ origin, password, pid: process.pid }), { mode: 0o600 });
const sim = connectSimulator({ url: origin.replace('http:', 'ws:') + '/ws/device', deviceToken });
console.log(`Local simulator ready at ${origin}. Test credentials are in data/ui-test/access.local.json; do not print them.`);
let stopping = false;
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => { if (stopping) return; stopping = true; sim.terminate(); await app.close(); fs.rmSync(accessFile, { force: true }); process.exit(0); });
