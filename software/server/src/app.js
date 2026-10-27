import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { Journal } from './store.js';
import { token, equal, verifyPassword, RateLimiter } from './security.js';
import * as v from './validation.js';
import { jpegDimensions } from './evidence.js';

const TERMINAL = new Set(['completed', 'rejected', 'expired']);
const initialPresets = () => [50, 90, 130].map((pan, i) => ({ id: `p${i + 1}`, name: `观察点 ${i + 1}`, pan_deg: pan, tilt_deg: 90, roi: { x: 0.35, y: 0.35, w: 0.3, h: 0.3 }, expected_state: 'green' }));
const json = (res, code, value) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
async function body(req, max = 32_768, jsonBody = true) {
  let bytes = 0; const chunks = [];
  for await (const chunk of req) { bytes += chunk.length; if (bytes > max) v.fail('body_too_large', 413); chunks.push(chunk); }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!jsonBody) return text;
  if (!req.headers['content-type']?.startsWith('application/json')) v.fail('json_content_type_required', 415);
  try { return JSON.parse(text); } catch { v.fail('invalid_json'); }
}
function cookie(req) { return (req.headers.cookie ?? '').split(';').map(x => x.trim()).find(x => x.startsWith('inspection_session='))?.slice(19); }
function send(ws, payload) { if (ws?.readyState === WebSocket.OPEN) { if (ws.bufferedAmount > 1_000_000) return ws.close(1013, 'slow_client'); ws.send(JSON.stringify(payload)); } }

export function createApp(options) {
  const config = { host: '127.0.0.1', port: 8080, source: 'hardware', deviceId: 'inspection-01', sessionMs: 8 * 3600_000, commandTtlMs: 5000, heartbeatMs: 1000, offlineMs: 10_000, secureCookies: false, mediaUrl: null, mediaToken: null, mediaPublishToken: null, ...options };
  const commandTtlByType = Object.fromEntries(Object.entries({ move: 10_000, preset: 10_000, mode: 5_000, capture: 15_000, recheck: 15_000 }).map(([type, duration]) => [type, options.commandTtlMs ?? duration]));
  if (!Object.values(commandTtlByType).every(value => Number.isInteger(value) && value > 0 && value <= 30_000)) throw new Error('Command lifetime must be 1–30000 ms.');
  if (!['hardware', 'simulator'].includes(config.source) || !v.identifier(config.deviceId)) throw new Error('invalid_source_or_device_id');
  if (!config.passwordHash || !/^[0-9a-f]{32}:[0-9a-f]{64}$/.test(config.passwordHash)) throw new Error('A configured scrypt password hash is required.');
  if (typeof config.deviceToken !== 'string' || config.deviceToken.length < 32) throw new Error('A separate device token of at least 32 characters is required.');
  if (config.mediaUrl && (!config.mediaToken || config.mediaToken.length < 32 || !config.mediaPublishToken || config.mediaPublishToken.length < 32)) throw new Error('Distinct media reader/publisher tokens are required.');
  if (config.mediaUrl && new Set([config.deviceToken, config.mediaToken, config.mediaPublishToken]).size !== 3) throw new Error('Device and media tokens must be distinct.');
  let origin = config.publicOrigin ? new URL(config.publicOrigin).origin : null;
  if (config.publicOrigin && config.publicOrigin !== origin) throw new Error('publicOrigin must be an origin without path.');
  const journal = new Journal(path.join(config.dataDir, config.source));
  const sessions = new Map(), clients = new Set(), commands = new Map(), requests = new Map(), events = [], eventKeys = new Set(), mediaSessions = new Map();
  const evidenceById = new Map(), evidenceByEvent = new Map();
  const evidenceDir = path.join(config.dataDir, config.source, 'evidence'); fs.mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
  let evidenceBytes = 0;
  let presets = initialPresets(), presetsRevision = 1, device = null, deviceReady = false, closed = false, fatal = null;
  const presetHistory = new Map([[1, presets]]);
  const state = { device_id: config.deviceId, source: config.source, online: false, last_seen: null, mode: 'paused', pan_deg: 90, tilt_deg: 90, position_source: 'commanded', active_preset: null, observations: [], video: { whep_url: '/media/inspection/whep', available: false }, pending_commands: [], presets_revision: 1, presets_applied_revision: null, limits: v.LIMITS };
  for (const row of journal.rows) {
    if (row.kind === 'presets') { presets = v.presets(row.data.presets); presetsRevision = row.data.revision; presetHistory.set(presetsRevision, presets); }
    if (row.kind === 'command') { commands.set(row.data.command_id, row.data); requests.set(row.data.request_id, row.data.command_id); }
    if (row.kind === 'event') { events.push(row.data); if (row.data.device_event_id) eventKeys.add(row.data.device_event_id); }
    if (row.kind === 'evidence') { evidenceById.set(row.data.id, row.data); evidenceByEvent.set(row.data.event_id, row.data); evidenceBytes += row.data.bytes; }
  }
  // 重启绝不恢复执行旧动作。将未完成命令落盘为过期，防止用户误以为还会执行。
  for (const command of commands.values()) if (!TERMINAL.has(command.status)) { command.status = 'expired'; command.reason = 'server_restarted'; command.updated_at = new Date().toISOString(); journal.append('command', command); }
  function snapshot() { return { ...state, presets_revision: presetsRevision, pending_commands: [...commands.values()].filter(c => !TERMINAL.has(c.status)), storage_fault: fatal }; }
  function broadcast(payload) { for (const ws of clients) send(ws, payload); }
  function publishState() { broadcast({ type: 'state', state: snapshot() }); }
  function record(kind, data) { try { journal.append(kind, data); } catch { fatal = 'storage_unavailable'; device?.close(1011, 'storage_unavailable'); throw Object.assign(new Error(fatal), { status: 503 }); } }
  function updateCommand(command, status, reason = null) {
    const updated = { ...command, status, updated_at: new Date().toISOString(), reason };
    record('command', updated); commands.set(updated.command_id, updated);
    broadcast({ type: 'command_status', command: updated }); publishState(); return updated;
  }
  function addEvent(value) {
    const event = { id: randomUUID(), at: new Date().toISOString(), preset_id: null, state: 'unknown', confidence: 0, evidence_url: null, ...value, source: config.source };
    record('event', event); events.push(event); if (event.device_event_id) eventKeys.add(event.device_event_id);
    broadcast({ type: 'event', event }); return event;
  }
  function disconnect(ws, reason) {
    if (device !== ws) return;
    device = null; deviceReady = false; state.online = false; state.video.available = false; state.presets_applied_revision = null;
    for (const command of [...commands.values()]) if (!TERMINAL.has(command.status)) updateCommand(command, 'rejected', reason);
    addEvent({ kind: 'device_offline', reason }); publishState();
  }
  const loginLimit = new RateLimiter(config.loginLimit ?? 8, 60_000), commandLimit = new RateLimiter(40, 1000), upgradeLimit = new RateLimiter(30, 60_000), evidenceLimit = new RateLimiter(4, 1000);
  function originOk(req) { return req.headers.origin === origin; }
  function session(req) {
    const id = cookie(req), entry = sessions.get(id);
    if (!entry || Date.now() >= entry.until) { sessions.delete(id); return null; }
    return { id, ...entry };
  }
  function authenticate(req, mutation = false) {
    const s = session(req); if (!s) v.fail('authentication_required', 401);
    if (mutation && (!originOk(req) || !equal(req.headers['x-csrf-token'], s.csrf))) v.fail('csrf_rejected', 403);
    return s;
  }
  function securityHeaders(res) {
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  }
  // WHEP/WHIP 信令代理。媒体包走 ICE；此代理不会把视频字节经 JSON/WebSocket 搬运。
  async function mediaProxy(req, res, url, s, publishing = false) {
    if (!config.mediaUrl) v.fail('media_not_configured', 503);
    const endpoint = publishing ? 'whip' : 'whep';
    const basePath = `/media/inspection/${endpoint}`;
    if (!(url.pathname === basePath || url.pathname.startsWith(basePath + '/'))) v.fail('not_found', 404);
    if (!['OPTIONS', 'POST', 'PATCH', 'DELETE'].includes(req.method)) v.fail('method_not_allowed', 405);
    if (req.method === 'POST' && url.pathname !== basePath) v.fail('invalid_media_session');
    if (['PATCH', 'DELETE'].includes(req.method) && !mediaSessions.has(url.pathname)) v.fail('unknown_media_session', 404);
    const mediaSession = mediaSessions.get(url.pathname);
    const owner = publishing ? 'device' : s.id;
    if (mediaSession && mediaSession.owner !== owner) v.fail('media_session_forbidden', 403);
    if (mediaSessions.size >= 32 && req.method === 'POST') v.fail('media_session_limit', 429);
    const headers = { Authorization: `Bearer ${publishing ? config.mediaPublishToken : config.mediaToken}` };
    for (const name of ['content-type', 'if-match']) if (req.headers[name]) headers[name] = req.headers[name];
    const upstream = new URL(url.pathname.slice('/media'.length), config.mediaUrl);
    // 先验证客户端正文，再把媒体进程不可达映射为可诊断的网关错误。
    const requestBody = ['POST', 'PATCH'].includes(req.method) ? await body(req, 262_144, false) : undefined;
    let response;
    try {
      response = await fetch(upstream, { method: req.method, headers, body: requestBody, redirect: 'manual', signal: AbortSignal.timeout(12_000) });
    } catch (error) {
      v.fail(error.name === 'TimeoutError' ? 'media_upstream_timeout' : 'media_upstream_unavailable', error.name === 'TimeoutError' ? 504 : 502);
    }
    for (const name of ['content-type', 'etag', 'accept-patch', 'link']) if (response.headers.has(name)) res.setHeader(name, response.headers.get(name));
    const location = response.headers.get('location');
    if (location && response.status === 201) {
      const resolved = new URL(location, upstream);
      if (resolved.origin !== upstream.origin || !resolved.pathname.startsWith(`/inspection/${endpoint}/`)) v.fail('invalid_media_upstream_location', 502);
      const local = '/media' + resolved.pathname;
      mediaSessions.set(local, { owner, until: s?.until ?? Date.now() + 8 * 3600_000, publishing });
      res.setHeader('Location', local);
    }
    if (req.method === 'DELETE' && response.ok) mediaSessions.delete(url.pathname);
    res.writeHead(response.status); res.end(Buffer.from(await response.arrayBuffer()));
  }
  async function handler(req, res) {
    securityHeaders(res);
    try {
      const url = new URL(req.url, 'http://local');
      if (url.search.length > 2048) v.fail('query_too_long');
      if (req.method === 'GET' && url.pathname === '/api/health') return json(res, fatal ? 503 : 200, { ok: !fatal, service: 'active-inspection', protocol: 1, source: config.source });
      if (url.pathname === '/api/session') {
        if (req.method === 'GET') { const s = session(req); return json(res, 200, s ? { authenticated: true, csrf_token: s.csrf, source: config.source } : { authenticated: false, source: config.source }); }
        if (req.method === 'POST') {
          if (!originOk(req)) v.fail('origin_rejected', 403);
          if (!loginLimit.accept(req.socket.remoteAddress)) v.fail('login_rate_limited', 429);
          const input = await body(req);
          if (!v.object(input) || !verifyPassword(input.password, config.passwordHash)) v.fail('invalid_credentials', 401);
          if (sessions.size >= 100) v.fail('session_limit', 429);
          // 登录成功轮换标识，避免会话固定；旧连接一起撤销。
          const old = cookie(req); if (old) { sessions.delete(old); for (const ws of clients) if (ws.sessionId === old) ws.close(1008, 'session_replaced'); }
          const id = token(), csrf = token(); sessions.set(id, { csrf, until: Date.now() + config.sessionMs });
          res.setHeader('Set-Cookie', `inspection_session=${id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(config.sessionMs / 1000)}${config.secureCookies ? '; Secure' : ''}`);
          return json(res, 200, { authenticated: true, csrf_token: csrf, source: config.source });
        }
        if (req.method === 'DELETE') {
          const s = authenticate(req, true); sessions.delete(s.id);
          for (const ws of clients) if (ws.sessionId === s.id) ws.close(1008, 'logged_out');
          res.setHeader('Set-Cookie', `inspection_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${config.secureCookies ? '; Secure' : ''}`);
          return json(res, 200, { authenticated: false });
        }
        v.fail('method_not_allowed', 405);
      }
      // 媒体服务器在内部 Docker 网络回调；返回规则与控制口令完全分离。
      if (url.pathname === '/internal/media-auth') {
        if (req.method !== 'POST') v.fail('method_not_allowed', 405);
        const input = await body(req);
        const valid = v.object(input) && input.protocol === 'webrtc' && input.path === 'inspection' && ((input.action === 'read' && equal(input.token, config.mediaToken)) || (input.action === 'publish' && equal(input.token, config.mediaPublishToken)));
        return json(res, valid ? 200 : 403, { ok: !!valid });
      }
      if (url.pathname.startsWith('/media/inspection/whip')) {
        if (!equal(req.headers.authorization, `Bearer ${config.deviceToken}`)) v.fail('device_authentication_required', 401);
        return await mediaProxy(req, res, url, null, true);
      }
      if (url.pathname.startsWith('/media/')) {
        const s = authenticate(req, req.method !== 'OPTIONS');
        return await mediaProxy(req, res, url, s);
      }
      if (url.pathname === '/api/device/evidence') {
        if (req.method !== 'POST') v.fail('method_not_allowed', 405);
        if (!equal(req.headers.authorization, `Bearer ${config.deviceToken}`) || req.headers['x-device-id'] !== config.deviceId) v.fail('device_authentication_required', 401);
        if (!evidenceLimit.accept(config.deviceId)) v.fail('evidence_rate_limited', 429);
        if (req.headers['content-type'] !== 'image/jpeg') v.fail('jpeg_content_type_required', 415);
        const eventId = url.searchParams.get('event_id'); if (!v.identifier(eventId)) v.fail('invalid_event_id');
        if (Number(req.headers['content-length']) > 524_288) v.fail('body_too_large', 413);
        let total = 0; const chunks = [];
        for await (const chunk of req) { total += chunk.length; if (total > 524_288) v.fail('body_too_large', 413); chunks.push(chunk); }
        const data = Buffer.concat(chunks), dimensions = jpegDimensions(data), digest = createHash('sha256').update(data).digest('hex');
        const existing = evidenceByEvent.get(eventId);
        if (existing) { if (existing.sha256 !== digest) v.fail('evidence_event_conflict', 409); return json(res, 200, { evidence: existing, replay: true }); }
        if (evidenceBytes + data.length > 128 * 1024 * 1024) v.fail('evidence_storage_full', 507);
        const id = randomUUID(), filename = path.join(evidenceDir, id + '.jpg');
        const fd = fs.openSync(filename, 'wx', 0o600); try { fs.writeFileSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        const evidence = { id, event_id: eventId, sha256: digest, bytes: data.length, ...dimensions, source: config.source, device_id: config.deviceId, at: new Date().toISOString(), evidence_url: '/api/evidence/' + id };
        record('evidence', evidence); evidenceById.set(id, evidence); evidenceByEvent.set(eventId, evidence); evidenceBytes += data.length;
        return json(res, 201, { evidence });
      }
      if (url.pathname.startsWith('/api/')) {
        const s = authenticate(req, !['GET', 'HEAD', 'OPTIONS'].includes(req.method));
        if (fatal && req.method !== 'GET') v.fail('storage_unavailable', 503);
        if (req.method === 'GET' && /^\/api\/evidence\/[0-9a-f-]{36}$/.test(url.pathname)) {
          const id = url.pathname.split('/').at(-1), metadata = evidenceById.get(id);
          if (!metadata) v.fail('not_found', 404);
          const filename = path.join(evidenceDir, id + '.jpg'); let data;
          try { data = fs.readFileSync(filename); } catch { v.fail('evidence_missing', 410); }
          if (createHash('sha256').update(data).digest('hex') !== metadata.sha256) v.fail('evidence_integrity_failed', 410);
          res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': data.length, 'Content-Disposition': `inline; filename="${id}.jpg"`, 'Content-Security-Policy': "default-src 'none'; sandbox" });
          res.end(data); return;
        }
        if (req.method === 'GET' && url.pathname === '/api/state') return json(res, 200, snapshot());
        if (req.method === 'GET' && ['/api/events', '/api/commands'].includes(url.pathname)) {
          const limit = Number(url.searchParams.get('limit') ?? 50);
          if (!Number.isInteger(limit) || limit < 1 || limit > 500) v.fail('invalid_limit');
          return json(res, 200, url.pathname === '/api/events' ? { events: events.slice(-limit).reverse(), source: config.source } : { commands: [...commands.values()].slice(-limit).reverse() });
        }
        if (url.pathname === '/api/presets') {
          if (req.method === 'GET') return json(res, 200, { presets, revision: presetsRevision });
          if (req.method === 'PUT') {
            const input = await body(req); const next = v.presets(input?.presets);
            if (state.mode === 'patrol' || [...commands.values()].some(c => !TERMINAL.has(c.status))) v.fail('pause_and_finish_commands_before_editing', 409);
            record('presets', { presets: next, revision: presetsRevision + 1 }); presets = next; presetsRevision++; state.presets_applied_revision = null;
            presetHistory.set(presetsRevision, presets);
            if (deviceReady) send(device, { type: 'presets', revision: presetsRevision, presets });
            broadcast({ type: 'presets', revision: presetsRevision });
            publishState(); return json(res, 200, { presets, revision: presetsRevision });
          }
        }
        if (req.method === 'POST' && url.pathname === '/api/commands') {
          if (!commandLimit.accept(s.id)) v.fail('command_rate_limited', 429);
          const input = v.command(await body(req), presets);
          const existingId = requests.get(input.request_id), existing = commands.get(existingId);
          if (existing) {
            if (existing.type !== input.type || JSON.stringify(existing.args) !== JSON.stringify(input.args)) v.fail('request_id_conflict', 409);
            return json(res, 200, { command: existing, replay: true });
          }
          if (!state.online || !deviceReady) v.fail('device_offline', 409);
          if ((input.type === 'preset' || (input.type === 'mode' && input.args.mode === 'patrol')) && state.presets_applied_revision !== presetsRevision) v.fail('presets_not_synced', 409);
          if ([...commands.values()].filter(c => !TERMINAL.has(c.status)).length >= 4) v.fail('command_queue_full', 429);
          const now = Date.now();
          const command = { ...input, command_id: randomUUID(), created_at: new Date(now).toISOString(), expires_at: new Date(now + commandTtlByType[input.type]).toISOString(), updated_at: new Date(now).toISOString(), status: 'queued', source: config.source, reason: null };
          record('command', command); commands.set(command.command_id, command); requests.set(command.request_id, command.command_id);
          send(device, { type: 'command', command }); broadcast({ type: 'command_status', command }); publishState();
          return json(res, 202, { command });
        }
        v.fail('not_found', 404);
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') v.fail('method_not_allowed', 405);
      const webRoot = path.resolve(config.webDir ?? fileURLToPath(new URL('../../web/', import.meta.url)));
      let decoded; try { decoded = decodeURIComponent(url.pathname); } catch { v.fail('bad_path'); }
      if (decoded.includes('\\') || decoded.includes('\0') || decoded.split('/').some(p => p.startsWith('.'))) v.fail('not_found', 404);
      const requested = path.resolve(webRoot, '.' + (decoded === '/' ? '/index.html' : decoded));
      if (!requested.startsWith(webRoot + path.sep)) v.fail('not_found', 404);
      let stat; try { stat = fs.statSync(requested); } catch { v.fail('not_found', 404); }
      if (!stat.isFile() || !fs.realpathSync(requested).startsWith(fs.realpathSync(webRoot) + path.sep)) v.fail('not_found', 404);
      const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' }[path.extname(requested)];
      if (!mime) v.fail('not_found', 404);
      res.writeHead(200, { 'Content-Type': mime, 'Content-Length': stat.size }); if (req.method === 'HEAD') res.end(); else fs.createReadStream(requested).pipe(res);
    } catch (error) { if (!res.headersSent) json(res, error.status ?? 500, { error: error.status ? error.message : 'internal_error' }); else res.destroy(); }
  }
  const server = http.createServer(handler);
  server.requestTimeout = 15_000; server.headersTimeout = 10_000;
  const deviceWss = new WebSocketServer({ noServer: true, maxPayload: 32_768, perMessageDeflate: false });
  const clientWss = new WebSocketServer({ noServer: true, maxPayload: 4096, perMessageDeflate: false });
  server.on('upgrade', (req, socket, head) => {
    const reject = status => { socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`); };
    if (!upgradeLimit.accept(req.socket.remoteAddress)) return reject('429 Too Many Requests');
    if (req.url === '/ws/device') {
      if (!equal(req.headers.authorization, `Bearer ${config.deviceToken}`)) return reject('401 Unauthorized');
      if (device) return reject('409 Conflict');
      deviceWss.handleUpgrade(req, socket, head, ws => deviceWss.emit('connection', ws, req));
    } else if (req.url === '/ws/client') {
      const s = session(req); if (!s) return reject('401 Unauthorized'); if (!originOk(req)) return reject('403 Forbidden');
      clientWss.handleUpgrade(req, socket, head, ws => { ws.sessionId = s.id; clientWss.emit('connection', ws, req); });
    } else reject('404 Not Found');
  });
  clientWss.on('connection', ws => {
    clients.add(ws); send(ws, { type: 'state', state: snapshot() });
    ws.on('message', () => ws.close(1008, 'client_socket_is_read_only'));
    ws.on('error', () => {}); ws.on('close', () => clients.delete(ws));
  });
  deviceWss.on('connection', ws => {
    device = ws; ws.lastSequence = -1; ws.rate = new RateLimiter(50, 1000); ws.seen = Date.now();
    const helloDeadline = setTimeout(() => { if (!deviceReady) ws.close(1008, 'hello_timeout'); }, 3000);
    ws.on('error', () => {});
    ws.on('close', () => { clearTimeout(helloDeadline); try { disconnect(ws, 'device_disconnected'); } catch {} });
    ws.on('message', (raw, binary) => {
      try {
        if (binary || !ws.rate.accept('connection')) v.fail('device_message_rejected');
        let msg; try { msg = JSON.parse(raw.toString()); } catch { v.fail('invalid_json'); }
        if (!v.object(msg)) v.fail('invalid_device_message');
        if (!deviceReady) {
          if (msg.type !== 'hello' || msg.protocol !== 1 || msg.device_id !== config.deviceId || msg.source !== config.source) v.fail('hello_mismatch');
          deviceReady = true; clearTimeout(helloDeadline); state.online = true; state.last_seen = new Date().toISOString(); ws.seen = Date.now();
          send(ws, { type: 'hello_ack', protocol: 1, server_time: new Date().toISOString(), command_ttl_ms: config.commandTtlMs, command_ttl_by_type: commandTtlByType });
          send(ws, { type: 'presets', revision: presetsRevision, presets }); addEvent({ kind: 'device_online' }); publishState(); return;
        }
        // 每个连接递增 seq；TLS 连接本身隔离旧连接，事件 event_id 提供跨重连幂等。
        if (!Number.isSafeInteger(msg.seq) || msg.seq <= ws.lastSequence || msg.seq > 0x7fffffff) v.fail('sequence_replay_or_out_of_order');
        ws.lastSequence = msg.seq; ws.seen = Date.now(); state.last_seen = new Date().toISOString();
        if (msg.type === 'presets_ack') {
          if (msg.revision !== presetsRevision || !['applied', 'rejected'].includes(msg.status)) v.fail('invalid_presets_ack');
          state.presets_applied_revision = msg.status === 'applied' ? msg.revision : null;
        } else if (msg.type === 'telemetry') {
          const data = msg.state ?? msg;
          const p = v.pose(data); if (!v.MODES.includes(data.mode)) v.fail('invalid_mode');
          if (data.active_preset != null && !presets.some(p => p.id === data.active_preset)) v.fail('unknown_preset');
          const observations = data.observations ?? [];
          if (!Array.isArray(observations) || observations.length > 3) v.fail('invalid_observations');
          Object.assign(state, p, { mode: data.mode, active_preset: data.active_preset ?? null, observations: observations.map(o => ({ ...v.observation(o, presets), source: config.source })) });
          state.video.available = !!config.mediaUrl && data.video?.available === true;
        } else if (msg.type === 'event') {
          const input = msg.event ?? msg;
          // 离线补传必须按采集时配置追溯。旧事件不得套用重连后的 ROI/点位。
          if (input.preset_revision != null && (!Number.isSafeInteger(input.preset_revision) || input.preset_revision < 1)) v.fail('invalid_event_preset_revision');
          const eventPresets = presetHistory.get(input.preset_revision);
          const matchesRevision = eventPresets?.some(p => p.id === input.preset_id) === true;
          const parsed = v.deviceEvent(input, eventPresets ?? [], !matchesRevision);
          const configurationStatus = matchesRevision ? (input.preset_revision === presetsRevision ? 'current' : 'historical') : 'unresolved';
          const configurationReason = matchesRevision ? null : input.preset_revision == null ? 'missing_preset_revision' : eventPresets ? 'preset_not_in_revision' : 'unknown_preset_revision';
          if (parsed.evidence_url && evidenceByEvent.get(input.event_id)?.evidence_url !== parsed.evidence_url) v.fail('unknown_or_mismatched_evidence');
          if (!eventKeys.has(input.event_id)) addEvent({ ...parsed, preset_revision: input.preset_revision ?? null, configuration_status: configurationStatus, configuration_reason: configurationReason, device_event_id: input.event_id, device_at: typeof input.at === 'string' && Number.isFinite(Date.parse(input.at)) ? input.at : null });
          send(ws, { type: 'event_ack', event_id: input.event_id });
        } else if (msg.type === 'ack') {
          const command = commands.get(msg.command_id);
          if (!command) v.fail('unknown_command');
          if (TERMINAL.has(command.status)) { send(ws, { type: 'ack_rejected', command_id: msg.command_id, reason: 'terminal_command' }); return; }
          if (Date.now() >= Date.parse(command.expires_at)) { updateCommand(command, 'expired', 'deadline_exceeded'); send(ws, { type: 'ack_rejected', command_id: msg.command_id, reason: 'expired' }); return; }
          if (!['acknowledged', 'completed', 'rejected'].includes(msg.status) || (msg.status === 'completed' && command.status !== 'acknowledged') || (msg.status === 'acknowledged' && command.status !== 'queued')) v.fail('invalid_ack_transition');
          updateCommand(command, msg.status, msg.status === 'rejected' ? String(msg.reason ?? 'device_rejected').slice(0, 160) : null);
        } else if (msg.type !== 'heartbeat') v.fail('unknown_device_message');
        publishState();
      } catch (error) { send(ws, { type: 'error', error: error.status ? error.message : 'storage_unavailable' }); ws.close(1008, 'protocol_error'); }
    });
  });
  const timer = setInterval(() => {
    if (closed) return;
    try {
      const now = Date.now();
      for (const c of [...commands.values()]) if (!TERMINAL.has(c.status) && now >= Date.parse(c.expires_at)) updateCommand(c, 'expired', 'deadline_exceeded');
      if (device && now - device.seen > config.offlineMs) { const ws = device; disconnect(ws, 'heartbeat_timeout'); ws.terminate(); }
      for (const [id, s] of sessions) if (now >= s.until) { sessions.delete(id); for (const ws of clients) if (ws.sessionId === id) ws.close(1008, 'session_expired'); }
      for (const [key, value] of mediaSessions) if (now >= value.until || (!value.publishing && !sessions.has(value.owner))) {
        mediaSessions.delete(key);
        // 注销/到期时主动终止已经建立的播放会话，撤销不仅限于 HTTP 请求。
        if (config.mediaUrl) fetch(new URL(key.slice(6), config.mediaUrl), { method: 'DELETE', headers: { Authorization: `Bearer ${value.publishing ? config.mediaPublishToken : config.mediaToken}` }, signal: AbortSignal.timeout(2000) }).catch(() => {});
      }
    } catch { fatal = 'storage_unavailable'; }
  }, config.heartbeatMs);
  timer.unref();
  return {
    config, server, snapshot,
    async listen() { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(config.port, config.host, resolve); }); if (!origin) origin = `http://${config.host}:${server.address().port}`; return origin; },
    async close() { closed = true; clearInterval(timer); for (const ws of [...clients, ...deviceWss.clients]) ws.terminate(); deviceWss.close(); clientWss.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); journal.close(); },
  };
}
