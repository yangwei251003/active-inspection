import { WebSocket } from 'ws';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { loadConfig } from './config.js';

// 这是协议/界面模拟器，不连接真实相机，不生成可冒充实测的视频或准确率。
export function connectSimulator({ url, deviceToken, deviceId = 'inspection-01', ackDelayMs = 40, completeDelayMs = 120, autoAck = true, telemetryMs = 1000 }) {
  const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${deviceToken}` } });
  let seq = 0, presets = [], presetsRevision = null, ready = false, eventCount = 0;
  const timers = new Set();
  const state = { pan_deg: 90, tilt_deg: 90, mode: 'paused', active_preset: null, observations: [], video: { available: false } };
  const send = value => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ ...value, seq: seq++ })); };
  const after = (delay, action) => { const timer = setTimeout(() => { timers.delete(timer); action(); }, delay); timers.add(timer); };
  function telemetry() { if (ready) send({ type: 'telemetry', state }); }
  function observe(kind = 'observation') {
    const preset = presets.find(p => p.id === state.active_preset) ?? presets[0]; if (!preset) return;
    const observed = { preset_id: preset.id, state: eventCount++ % 3 === 0 ? 'unknown' : 'green', confidence: eventCount % 3 === 1 ? 0.45 : 0.92 };
    state.observations = [...state.observations.filter(o => o.preset_id !== preset.id), observed];
    send({ type: 'event', event: { ...observed, preset_revision: presetsRevision, event_id: randomUUID(), kind, at: new Date().toISOString(), evidence_url: null } }); telemetry();
  }
  ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', device_id: deviceId, protocol: 1, source: 'simulator' })));
  ws.on('message', raw => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === 'hello_ack') ready = true;
    if (msg.type === 'presets') { presets = msg.presets; presetsRevision = msg.revision; state.mode = 'paused'; send({ type: 'presets_ack', revision: msg.revision, status: 'applied' }); telemetry(); }
    if (msg.type === 'command' && autoAck) {
      const c = msg.command;
      if (Date.now() >= Date.parse(c.expires_at)) return;
      after(ackDelayMs, () => send({ type: 'ack', command_id: c.command_id, status: 'acknowledged' }));
      after(completeDelayMs, () => {
        if (Date.now() >= Date.parse(c.expires_at) || ws.readyState !== WebSocket.OPEN) return;
        if (c.type === 'move') { Object.assign(state, c.args); state.active_preset = null; state.mode = 'manual'; }
        if (c.type === 'preset') { const p = presets.find(p => p.id === c.args.preset_id); Object.assign(state, { pan_deg: p.pan_deg, tilt_deg: p.tilt_deg, active_preset: p.id, mode: 'manual' }); }
        if (c.type === 'mode') state.mode = c.args.mode;
        send({ type: 'ack', command_id: c.command_id, status: 'completed' });
        if (['capture', 'recheck', 'preset'].includes(c.type)) observe(c.type === 'recheck' ? 'recheck' : 'observation');
        telemetry();
      });
    }
  });
  const heartbeat = setInterval(telemetry, telemetryMs);
  const patrol = setInterval(() => { if (ready && state.mode === 'patrol' && presets.length) { const next = presets[(presets.findIndex(p => p.id === state.active_preset) + 1) % presets.length]; Object.assign(state, { pan_deg: next.pan_deg, tilt_deg: next.tilt_deg, active_preset: next.id }); observe(); } }, 4000);
  ws.on('error', () => {});
  ws.on('close', () => { clearInterval(heartbeat); clearInterval(patrol); for (const t of timers) clearTimeout(t); });
  return { ws, state, send, observe, close: () => ws.close(), terminate: () => ws.terminate() };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = loadConfig();
  if (config.source !== 'simulator') throw new Error('Simulator refuses a hardware configuration.');
  const endpoint = new URL('/ws/device', config.publicOrigin ?? `http://${config.host ?? '127.0.0.1'}:${config.port ?? 8080}`); endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:';
  const sim = connectSimulator({ url: endpoint.href, deviceToken: config.deviceToken, deviceId: config.deviceId });
  sim.ws.on('open', () => console.log('SIMULATOR connected: all observations are synthetic; no live video.'));
  sim.ws.on('close', (code, reason) => { console.log(`Simulator disconnected (${code} ${reason}); restart explicitly to reconnect.`); process.exit(0); });
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => sim.close());
}
