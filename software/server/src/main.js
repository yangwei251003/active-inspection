import { createApp } from './app.js';
import { loadConfig } from './config.js';
const app = createApp(loadConfig());
const origin = await app.listen();
console.log(`Active Inspection ready: ${origin}; source=${app.config.source}; physical verification pending.`);
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { if (stopping) return; stopping = true; await app.close(); process.exit(0); });
