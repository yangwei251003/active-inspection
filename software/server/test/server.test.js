import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { createApp } from '../src/app.js';
import { token, hashPassword } from '../src/security.js';
import { connectSimulator } from '../src/simulator.js';

const pause = ms => new Promise(r => setTimeout(r, ms));
async function until(check, timeout = 2000) { const end = Date.now() + timeout; while (Date.now() < end) { if (await check()) return; await pause(10); } throw new Error('condition timed out'); }
async function fixture(t, override = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inspection-server-'));
  const password = 'test-only-password-14+', deviceToken = token();
  const config = { dataDir: dir, source: 'simulator', deviceToken, passwordHash: hashPassword(password), port: 0, heartbeatMs: 20, ...override };
  const app = createApp(config), origin = await app.listen();
  let closed = false; const cleanup = [];
  t.after(async () => { if (!closed) await app.close(); for (const close of cleanup) await close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const call = async (route, method = 'GET', data, auth = null, extra = {}) => {
    const headers = { Origin: origin };
    if (auth) { headers.Cookie = auth.cookie; headers['X-CSRF-Token'] = auth.csrf; }
    if (data !== undefined) headers['Content-Type'] = 'application/json';
    Object.assign(headers, extra);
    return fetch(origin + route, { method, headers, body: data !== undefined ? JSON.stringify(data) : undefined });
  };
  const login = async () => { const res = await call('/api/session', 'POST', { password }); assert.equal(res.status, 200); return { cookie: res.headers.get('set-cookie').split(';')[0], csrf: (await res.json()).csrf_token }; };
  return { dir, config, app, origin, call, login, onCleanup: close => cleanup.push(close), stop: async () => { await app.close(); closed = true; } };
}
async function rawDevice(f, hello = {}) {
  const ws = new WebSocket(f.origin.replace('http:', 'ws:') + '/ws/device', { headers: { Authorization: `Bearer ${f.config.deviceToken}` } });
  ws.on('error', () => {}); const messages = []; ws.on('message', raw => messages.push(JSON.parse(raw)));
  await once(ws, 'open'); ws.send(JSON.stringify({ type: 'hello', protocol: 1, device_id: 'inspection-01', source: 'simulator', ...hello }));
  await until(() => messages.some(m => m.type === 'presets') || ws.readyState === WebSocket.CLOSED);
  return { ws, messages };
}
function postCommand(f, auth, request = 'request-01', type = 'move', args = { pan_deg: 100, tilt_deg: 90 }) { return f.call('/api/commands', 'POST', { request_id: request, type, args }, auth); }

test('authentication, strict Origin/CSRF, safe cookies, static traversal, logout', async t => {
  const f = await fixture(t);
  assert.equal((await f.call('/api/state')).status, 401);
  assert.deepEqual(await (await f.call('/api/session')).json(), { authenticated: false, source: 'simulator' });
  assert.equal((await f.call('/api/session', 'POST', { password: 'wrong' })).status, 401);
  assert.equal((await f.call('/api/session', 'POST', { password: 'wrong' }, null, { Origin: 'https://evil.example' })).status, 403);
  const res = await f.call('/api/session', 'POST', { password: 'test-only-password-14+' });
  assert.match(res.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  const auth = { cookie: res.headers.get('set-cookie').split(';')[0], csrf: (await res.json()).csrf_token };
  assert.equal((await f.call('/api/state', 'GET', undefined, auth)).status, 200);
  assert.equal((await f.call('/api/commands', 'POST', {}, auth, { 'X-CSRF-Token': 'wrong' })).status, 403);
  assert.equal((await f.call('/api/commands', 'POST', {}, auth, { Origin: 'http://evil.local' })).status, 403);
  assert.equal((await f.call('/%2e%2e%5cserver/config.local.json')).status, 404);
  assert.equal((await f.call('/api/session', 'DELETE', undefined, auth)).status, 200);
  assert.equal((await f.call('/api/state', 'GET', undefined, auth)).status, 401);
});

test('rate limiting and source isolation refuse wrong identities', async t => {
  const f = await fixture(t, { loginLimit: 2 });
  for (let i = 0; i < 2; i++) assert.equal((await f.call('/api/session', 'POST', { password: 'wrong' })).status, 401);
  assert.equal((await f.call('/api/session', 'POST', { password: 'wrong' })).status, 429);
  const wrong = new WebSocket(f.origin.replace('http:', 'ws:') + '/ws/device', { headers: { Authorization: 'Bearer incorrect' } });
  const status = await new Promise(resolve => { wrong.on('unexpected-response', (_req, res) => { resolve(res.statusCode); res.resume(); wrong.terminate(); }); wrong.on('error', () => {}); });
  assert.equal(status, 401);
  const device = await rawDevice(f, { source: 'hardware' });
  assert.equal(f.app.snapshot().online, false);
  assert(device.messages.some(m => m.error === 'hello_mismatch'));
});

test('presets reject duplicate IDs/ROI overflow, persist, require applied revision', async t => {
  const f = await fixture(t), auth = await f.login();
  const current = (await (await f.call('/api/presets', 'GET', undefined, auth)).json()).presets;
  const badRoi = structuredClone(current); badRoi[0].roi = { x: 0.9, y: 0, w: 0.2, h: 0.1 };
  assert.equal((await f.call('/api/presets', 'PUT', { presets: badRoi }, auth)).status, 400);
  assert.equal((await f.call('/api/presets', 'PUT', { presets: [current[0], current[0]] }, auth)).status, 400);
  const badAngle = structuredClone(current); badAngle[0].pan_deg = 151;
  assert.equal((await f.call('/api/presets', 'PUT', { presets: badAngle }, auth)).status, 400);
  const d = await rawDevice(f);
  assert.equal((await postCommand(f, auth, 'unsynced', 'preset', { preset_id: 'p1' })).status, 409);
  d.ws.send(JSON.stringify({ type: 'presets_ack', seq: 0, revision: 1, status: 'applied' }));
  await until(() => f.app.snapshot().presets_applied_revision === 1);
  current[0].name = '新名称';
  assert.equal((await f.call('/api/presets', 'PUT', { presets: current }, auth)).status, 200);
  await until(() => d.messages.some(m => m.type === 'presets' && m.revision === 2));
  assert.equal(f.app.snapshot().presets_applied_revision, null);
  d.ws.close();
  await f.stop();
  const restarted = createApp(f.config); const origin2 = await restarted.listen();
  const login = await fetch(origin2 + '/api/session', { method: 'POST', headers: { Origin: origin2, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'test-only-password-14+' }) });
  const stored = await (await fetch(origin2 + '/api/presets', { headers: { Cookie: login.headers.get('set-cookie').split(';')[0] } })).json();
  assert.equal(stored.presets[0].name, '新名称'); assert.equal(stored.revision, 2);
  await restarted.close();
});

test('command lifecycle, idempotency, conflict and reported position are honest', async t => {
  const f = await fixture(t), auth = await f.login();
  assert.equal((await postCommand(f, auth)).status, 409);
  const sim = connectSimulator({ url: f.origin.replace('http:', 'ws:') + '/ws/device', deviceToken: f.config.deviceToken });
  t.after(() => sim.terminate());
  await until(() => f.app.snapshot().presets_applied_revision === 1);
  const first = await postCommand(f, auth), command = (await first.json()).command;
  assert.equal(first.status, 202); assert.equal(command.status, 'queued');
  assert.equal(f.app.snapshot().pan_deg, 90, 'a queued command must not claim movement happened');
  const duplicate = await (await postCommand(f, auth)).json(); assert.equal(duplicate.command.command_id, command.command_id); assert.equal(duplicate.replay, true);
  assert.equal((await postCommand(f, auth, 'request-01', 'move', { pan_deg: 110, tilt_deg: 90 })).status, 409);
  await until(() => f.app.snapshot().pending_commands.length === 0);
  assert.equal(f.app.snapshot().pan_deg, 100); assert.equal(f.app.snapshot().position_source, 'commanded');
  const history = await (await f.call('/api/commands', 'GET', undefined, auth)).json(); assert.equal(history.commands[0].status, 'completed');
  assert.equal((await postCommand(f, auth, 'angle-bad', 'move', { pan_deg: 29, tilt_deg: 90 })).status, 400);
  assert.equal((await postCommand(f, auth, 'type-bad', 'execute', {})).status, 400);
});

test('expired ACK cannot resurrect command, premature complete and replay close connection', async t => {
  const f = await fixture(t, { commandTtlMs: 80 }), auth = await f.login();
  let d = await rawDevice(f);
  const c = (await (await postCommand(f, auth)).json()).command;
  await pause(120);
  d.ws.send(JSON.stringify({ type: 'ack', seq: 0, command_id: c.command_id, status: 'acknowledged' }));
  await until(() => d.messages.some(m => m.type === 'ack_rejected'));
  assert.equal((await (await f.call('/api/commands', 'GET', undefined, auth)).json()).commands[0].status, 'expired');
  const c2 = (await (await postCommand(f, auth, 'second')).json()).command;
  d.ws.send(JSON.stringify({ type: 'ack', seq: 1, command_id: c2.command_id, status: 'completed' }));
  await until(() => !f.app.snapshot().online);
  assert(d.messages.some(m => m.error === 'invalid_ack_transition'));
  d = await rawDevice(f);
  d.ws.send(JSON.stringify({ type: 'heartbeat', seq: 2 }));
  d.ws.send(JSON.stringify({ type: 'heartbeat', seq: 1 }));
  await until(() => !f.app.snapshot().online);
  assert(d.messages.some(m => m.error === 'sequence_replay_or_out_of_order'));
});

test('single device connection, disconnect rejection and heartbeat timeout', async t => {
  const f = await fixture(t, { offlineMs: 150 }), auth = await f.login();
  const d = await rawDevice(f);
  const second = new WebSocket(f.origin.replace('http:', 'ws:') + '/ws/device', { headers: { Authorization: `Bearer ${f.config.deviceToken}` } });
  const status = await new Promise(resolve => { second.on('unexpected-response', (_req, res) => { resolve(res.statusCode); res.resume(); second.terminate(); }); second.on('error', () => {}); });
  assert.equal(status, 409);
  const c = (await (await postCommand(f, auth)).json()).command;
  d.ws.close(); await until(() => !f.app.snapshot().online);
  assert.equal((await (await f.call('/api/commands', 'GET', undefined, auth)).json()).commands.find(x => x.command_id === c.command_id).reason, 'device_disconnected');
  await rawDevice(f); await until(() => !f.app.snapshot().online);
  const events = (await (await f.call('/api/events', 'GET', undefined, auth)).json()).events;
  assert(events.some(e => e.reason === 'heartbeat_timeout')); assert(events.every(e => e.source === 'simulator'));
});

test('persistent event deduplication survives reconnect and interrupted journal tail', async t => {
  const f = await fixture(t), auth = await f.login(); let d = await rawDevice(f);
  const event = { event_id: 'persistent-event-001', kind: 'observation', preset_id: 'p1', state: 'green', confidence: 0.9, evidence_url: null };
  d.ws.send(JSON.stringify({ type: 'event', seq: 0, event }));
  await until(() => d.messages.some(m => m.type === 'event_ack'));
  d.ws.close(); await until(() => !f.app.snapshot().online);
  d = await rawDevice(f); d.ws.send(JSON.stringify({ type: 'event', seq: 0, event }));
  await until(() => d.messages.some(m => m.type === 'event_ack'));
  let events = (await (await f.call('/api/events', 'GET', undefined, auth)).json()).events;
  assert.equal(events.filter(e => e.device_event_id === event.event_id).length, 1);
  d.ws.close(); await f.stop();
  const file = path.join(f.dir, 'simulator', 'journal.jsonl'); fs.appendFileSync(file, '{"version":1');
  const restarted = createApp(f.config); await restarted.listen(); await restarted.close();
  const raw = fs.readFileSync(file, 'utf8'); assert(raw.endsWith('\n')); assert(fs.readdirSync(path.dirname(file)).some(x => x.startsWith('interrupted-tail-')));
  assert.equal(raw.split('\n').filter(Boolean).map(JSON.parse).filter(r => r.kind === 'event' && r.data.device_event_id === event.event_id).length, 1);
});

test('browser websocket requires same-origin cookie and logout closes it', async t => {
  const f = await fixture(t), auth = await f.login();
  const url = f.origin.replace('http:', 'ws:') + '/ws/client';
  const bad = new WebSocket(url, { headers: { Cookie: auth.cookie, Origin: 'https://evil.example' } });
  const status = await new Promise(resolve => { bad.on('unexpected-response', (_req, res) => { resolve(res.statusCode); res.resume(); bad.terminate(); }); bad.on('error', () => {}); });
  assert.equal(status, 403);
  const ws = new WebSocket(url, { headers: { Cookie: auth.cookie, Origin: f.origin } });
  const first = once(ws, 'message'); await once(ws, 'open');
  const message = JSON.parse((await first)[0]); assert.equal(message.type, 'state');
  const closing = once(ws, 'close'); await f.call('/api/session', 'DELETE', undefined, auth); await closing;
});

test('media proxy authenticates WHEP, owns sessions, forwards SDP and protects WHIP', async t => {
  const received = [];
  const upstream = http.createServer(async (req, res) => {
    received.push({ method: req.method, path: req.url, authorization: req.headers.authorization });
    if (req.method === 'POST') { for await (const _chunk of req) {} res.writeHead(201, { Location: req.url + '/test-session', 'Content-Type': 'application/sdp', ETag: '"tag"' }); res.end('v=0\r\n'); }
    else { res.writeHead(204); res.end(); }
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  t.after(() => { upstream.closeAllConnections(); upstream.close(); });
  const mediaToken = token(), mediaPublishToken = token();
  const f = await fixture(t, { mediaUrl: `http://127.0.0.1:${upstream.address().port}`, mediaToken, mediaPublishToken });
  const auth = await f.login(), other = await f.login();
  const headers = { Cookie: auth.cookie, Origin: f.origin, 'X-CSRF-Token': auth.csrf, 'Content-Type': 'application/sdp' };
  assert.equal((await fetch(f.origin + '/media/inspection/whep', { method: 'POST', headers: { 'Content-Type': 'application/sdp' }, body: 'v=0' })).status, 401);
  const media = await fetch(f.origin + '/media/inspection/whep', { method: 'POST', headers, body: 'v=0' });
  assert.equal(media.status, 201); assert.equal(media.headers.get('location'), '/media/inspection/whep/test-session'); assert.equal(received[0].authorization, 'Bearer ' + mediaToken);
  assert.equal((await f.call('/media/inspection/whep/test-session', 'DELETE', undefined, other)).status, 403);
  assert.equal((await f.call('/media/inspection/whep/test-session', 'DELETE', undefined, auth)).status, 204);
  assert.equal((await f.call('/media/inspection/whip', 'POST', {}, auth)).status, 401);
  const publish = await fetch(f.origin + '/media/inspection/whip', { method: 'POST', headers: { Authorization: 'Bearer ' + f.config.deviceToken, 'Content-Type': 'application/sdp' }, body: 'v=0' });
  assert.equal(publish.status, 201); assert.equal(received.at(-1).authorization, 'Bearer ' + mediaPublishToken);
});

test('real JPEG evidence upload, authenticated read, hash identity and journal recovery', async t => {
  const f = await fixture(t), auth = await f.login();
  const jpeg = fs.readFileSync(new URL('./fixtures/synthetic-green.jpg', import.meta.url));
  const headers = { Authorization: 'Bearer ' + f.config.deviceToken, 'X-Device-Id': 'inspection-01', 'Content-Type': 'image/jpeg' };
  const upload = (id, data = jpeg, extra = {}) => fetch(f.origin + '/api/device/evidence?event_id=' + id, { method: 'POST', headers: { ...headers, ...extra }, body: data });
  assert.equal((await upload('bad-auth', jpeg, { Authorization: 'Bearer wrong' })).status, 401);
  assert.equal((await upload('bad-type', jpeg, { 'Content-Type': 'image/svg+xml' })).status, 415);
  const response = await upload('evidence-001'); assert.equal(response.status, 201);
  const evidence = (await response.json()).evidence;
  assert.equal(evidence.width, 16); assert.equal(evidence.height, 12); assert.equal(evidence.source, 'simulator');
  assert.equal((await upload('evidence-001')).status, 200);
  assert.equal((await f.call(evidence.evidence_url)).status, 401);
  const image = await f.call(evidence.evidence_url, 'GET', undefined, auth);
  assert.equal(image.status, 200); assert.equal(image.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), jpeg);
  const d = await rawDevice(f);
  d.ws.send(JSON.stringify({ type: 'event', seq: 0, event: { event_id: 'evidence-001', preset_id: 'p1', kind: 'observation', state: 'green', confidence: 0.9, evidence_url: evidence.evidence_url } }));
  await until(() => d.messages.some(m => m.type === 'event_ack'));
  assert((await (await f.call('/api/events', 'GET', undefined, auth)).json()).events.some(e => e.evidence_url === evidence.evidence_url));
  await pause(1050);
  assert.equal((await upload('too-large', Buffer.alloc(524289))).status, 413);
  assert.equal((await upload('bad-jpeg', Buffer.from('<svg></svg>'))).status, 415);
  d.ws.close(); await f.stop();
  const restarted = createApp(f.config), origin = await restarted.listen();
  const login = await fetch(origin + '/api/session', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'test-only-password-14+' }) });
  const sessionCookie = login.headers.get('set-cookie').split(';')[0];
  const restored = await fetch(origin + evidence.evidence_url, { headers: { Cookie: sessionCookie } }); assert.equal(restored.status, 200);
  fs.appendFileSync(path.join(f.dir, 'simulator', 'evidence', evidence.id + '.jpg'), 'tamper');
  assert.equal((await fetch(origin + evidence.evidence_url, { headers: { Cookie: sessionCookie } })).status, 410);
  await restarted.close();
});

test('server restart expires durable commands and never resends them to a fresh device', async t => {
  const f = await fixture(t), auth = await f.login(), d = await rawDevice(f);
  const command = (await (await postCommand(f, auth, 'before-restart')).json()).command;
  await until(() => d.messages.some(m => m.type === 'command'));
  // 保留已经确认落盘但尚未完成的命令，模拟进程在 ACK 前结束。
  const journalFile = path.join(f.dir, 'simulator', 'journal.jsonl');
  const beforeShutdown = fs.readFileSync(journalFile);
  await f.stop();
  // 使用中断前的有效日志快照；不能把优雅断连产生的 rejected 当成重启过期证据。
  fs.writeFileSync(journalFile, beforeShutdown);
  const restarted = createApp(f.config), origin = await restarted.listen();
  f.onCleanup(() => restarted.close());
  const login = await fetch(origin + '/api/session', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'test-only-password-14+' }) });
  const csrf = (await login.json()).csrf_token, sessionCookie = login.headers.get('set-cookie').split(';')[0];
  const history = await (await fetch(origin + '/api/commands', { headers: { Cookie: sessionCookie } })).json();
  const stored = history.commands.find(c => c.command_id === command.command_id);
  assert.equal(stored.status, 'expired'); assert.equal(stored.reason, 'server_restarted');
  const next = await rawDevice({ ...f, origin });
  await pause(60);
  assert.equal(next.messages.some(m => m.type === 'command'), false);
  next.ws.send(JSON.stringify({ type: 'ack', seq: 0, command_id: command.command_id, status: 'acknowledged' }));
  await until(() => next.messages.some(m => m.type === 'ack_rejected'));
  const replay = await fetch(origin + '/api/commands', { method: 'POST', headers: { Origin: origin, Cookie: sessionCookie, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'move', args: { pan_deg: 100, tilt_deg: 90 }, request_id: 'before-restart' }) });
  assert.equal(replay.status, 200); assert.equal((await replay.json()).command.status, stored.status);
  assert.equal(next.messages.some(m => m.type === 'command'), false);
});

test('photos cannot be replaced or attached to another event and wrong device IDs are rejected', async t => {
  const f = await fixture(t), image = fs.readFileSync(new URL('./fixtures/synthetic-green.jpg', import.meta.url));
  const headers = { Authorization: 'Bearer ' + f.config.deviceToken, 'X-Device-Id': 'inspection-01', 'Content-Type': 'image/jpeg' };
  const upload = (id, data, overrides = {}) => fetch(f.origin + '/api/device/evidence?event_id=' + id, { method: 'POST', headers: { ...headers, ...overrides }, body: data });
  assert.equal((await upload('photo-owner', image, { 'X-Device-Id': 'different-device' })).status, 401);
  const first = await upload('photo-owner', image), evidence = (await first.json()).evidence;
  const changed = Buffer.from(image); changed[changed.length - 3] ^= 1;
  assert.equal((await upload('photo-owner', changed)).status, 409);
  const d = await rawDevice(f);
  d.ws.send(JSON.stringify({ type: 'event', seq: 0, event: { event_id: 'another-event', preset_id: 'p1', kind: 'observation', state: 'green', confidence: 0.9, evidence_url: evidence.evidence_url } }));
  await until(() => d.messages.some(m => m.type === 'error'));
  assert.equal(d.messages.find(m => m.type === 'error').error, 'unknown_or_mismatched_evidence');
});

test('media process unavailable produces a gateway error without leaking internals', async t => {
  const socket = http.createServer(); socket.listen(0, '127.0.0.1'); await once(socket, 'listening');
  const unusedPort = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const f = await fixture(t, { mediaUrl: `http://127.0.0.1:${unusedPort}`, mediaToken: token(), mediaPublishToken: token() });
  const auth = await f.login();
  const response = await f.call('/media/inspection/whep', 'OPTIONS', undefined, auth);
  assert.equal(response.status, 502); assert.deepEqual(await response.json(), { error: 'media_upstream_unavailable' });
});

test('preset revision changes notify both authenticated browser sessions', async t => {
  const f = await fixture(t), auth = await f.login(), secondAuth = await f.login();
  const sockets = [];
  for (const session of [auth, secondAuth]) {
    const ws = new WebSocket(f.origin.replace('http:', 'ws:') + '/ws/client', { headers: { Cookie: session.cookie, Origin: f.origin } });
    const messages = []; ws.on('message', raw => messages.push(JSON.parse(raw))); ws.on('error', () => {});
    await once(ws, 'open'); sockets.push({ ws, messages });
  }
  const presets = (await (await f.call('/api/presets', 'GET', undefined, auth)).json()).presets;
  presets[0].name = '跨端同步';
  assert.equal((await f.call('/api/presets', 'PUT', { presets }, auth)).status, 200);
  await until(() => sockets.every(({ messages }) => messages.some(m => m.type === 'presets' && m.revision === 2)));
  const secondView = await (await f.call('/api/presets', 'GET', undefined, secondAuth)).json();
  assert.equal(secondView.revision, 2); assert.equal(secondView.presets[0].name, '跨端同步');
});

test('each command has a bounded action-specific completion deadline', async t => {
  const f = await fixture(t), auth = await f.login(), d = await rawDevice(f);
  const hello = d.messages.find(m => m.type === 'hello_ack');
  assert.deepEqual(hello.command_ttl_by_type, { move: 10000, preset: 10000, mode: 5000, capture: 15000, recheck: 15000 });
  d.ws.send(JSON.stringify({ type: 'presets_ack', seq: 0, revision: 1, status: 'applied' }));
  await until(() => f.app.snapshot().presets_applied_revision === 1);
  let seq = 1;
  for (const [type, args, expected] of [['move', { pan_deg: 100, tilt_deg: 90 }, 10000], ['preset', { preset_id: 'p1' }, 10000], ['mode', { mode: 'paused' }, 5000], ['capture', {}, 15000], ['recheck', {}, 15000]]) {
    const response = await postCommand(f, auth, 'deadline-' + type, type, args), command = (await response.json()).command;
    assert.equal(response.status, 202);
    assert.equal(Date.parse(command.expires_at) - Date.parse(command.created_at), expected);
    d.ws.send(JSON.stringify({ type: 'ack', seq: seq++, command_id: command.command_id, status: 'rejected', reason: 'test_no_motion' }));
    await until(() => !f.app.snapshot().pending_commands.length);
  }
});

test('stale preset acknowledgement cannot certify the current configuration', async t => {
  const f = await fixture(t), auth = await f.login(), d = await rawDevice(f);
  const presets = (await (await f.call('/api/presets', 'GET', undefined, auth)).json()).presets;
  presets[0].name = 'revision two';
  assert.equal((await f.call('/api/presets', 'PUT', { presets }, auth)).status, 200);
  d.ws.send(JSON.stringify({ type: 'presets_ack', seq: 0, revision: 1, status: 'applied' }));
  await until(() => d.messages.some(m => m.error === 'invalid_presets_ack'));
  assert.equal(f.app.snapshot().presets_applied_revision, null);
  assert.equal(f.app.snapshot().presets_revision, 2);
});

test('offline events keep historical preset revisions across restart without reconnect loops', async t => {
  const f = await fixture(t), auth = await f.login();
  const old = (await (await f.call('/api/presets', 'GET', undefined, auth)).json()).presets;
  const updated = [{ ...old[0], id: 'replacement', name: 'New point' }];
  assert.equal((await f.call('/api/presets', 'PUT', { presets: updated }, auth)).status, 200);
  await f.stop();
  const restarted = createApp(f.config), origin = await restarted.listen(); f.onCleanup(() => restarted.close());
  const d = await rawDevice({ ...f, origin });
  d.ws.send(JSON.stringify({ type: 'event', seq: 0, event: { event_id: 'historical-replay', preset_revision: 1, preset_id: 'p1', kind: 'observation', state: 'green', confidence: 0.9 } }));
  d.ws.send(JSON.stringify({ type: 'event', seq: 1, event: { event_id: 'legacy-replay', preset_id: 'deleted-legacy', kind: 'observation', state: 'red', confidence: 0.8 } }));
  await until(() => d.messages.filter(m => m.type === 'event_ack').length === 2);
  assert.equal(restarted.snapshot().online, true);
  assert.deepEqual(restarted.snapshot().observations, [], 'historical evidence must never become current telemetry');
  const login = await fetch(origin + '/api/session', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'test-only-password-14+' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const events = (await (await fetch(origin + '/api/events', { headers: { Cookie: cookie } })).json()).events;
  const historical = events.find(e => e.device_event_id === 'historical-replay');
  assert.equal(historical.preset_revision, 1); assert.equal(historical.configuration_status, 'historical');
  const legacy = events.find(e => e.device_event_id === 'legacy-replay');
  assert.equal(legacy.configuration_status, 'unresolved'); assert.equal(legacy.configuration_reason, 'missing_preset_revision');
});
