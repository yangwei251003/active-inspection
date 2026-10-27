import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
export const serverRoot = fileURLToPath(new URL('../', import.meta.url));
export function loadConfig(filename = process.env.INSPECTION_CONFIG ?? path.join(serverRoot, 'config.local.json')) {
  const config = JSON.parse(fs.readFileSync(filename, 'utf8'));
  config.dataDir = path.resolve(serverRoot, config.dataDir ?? 'data');
  config.webDir = path.resolve(serverRoot, config.webDir ?? '../web');
  if (config.production) {
    if (!config.publicOrigin?.startsWith('https://') || !config.secureCookies || config.source !== 'hardware') throw new Error('Production requires HTTPS publicOrigin, secureCookies:true, and source:hardware.');
    if (!config.mediaUrl || !config.mediaToken || !config.mediaPublishToken) throw new Error('Production media configuration missing.');
  } else if (!['127.0.0.1', '::1'].includes(config.host ?? '127.0.0.1')) throw new Error('Development mode is loopback-only.');
  return config;
}
