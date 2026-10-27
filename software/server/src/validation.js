// 边界由服务、协处理器和 STM32 三层分别校验；此处不是实物机械限位证明。
export const LIMITS = Object.freeze({ pan_min: 30, pan_max: 150, tilt_min: 45, tilt_max: 120 });
export const MODES = ['manual', 'patrol', 'paused'];
export function fail(message, status = 400) { throw Object.assign(new Error(message), { status }); }
export function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
export function finite(value, low, high) { return typeof value === 'number' && Number.isFinite(value) && value >= low && value <= high; }
export function identifier(value) { return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(value); }
export function pose(value) {
  if (!finite(value.pan_deg, LIMITS.pan_min, LIMITS.pan_max) || !finite(value.tilt_deg, LIMITS.tilt_min, LIMITS.tilt_max)) fail('angle_out_of_range');
  return { pan_deg: value.pan_deg, tilt_deg: value.tilt_deg };
}
export function presets(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 3) fail('one_to_three_presets_required');
  const ids = new Set();
  return value.map(p => {
    if (!object(p) || !identifier(p.id) || ids.has(p.id)) fail('invalid_or_duplicate_preset_id');
    ids.add(p.id);
    if (typeof p.name !== 'string' || p.name.trim().length < 1 || p.name.length > 40) fail('invalid_preset_name');
    if (!object(p.roi) || !['x', 'y', 'w', 'h'].every(k => finite(p.roi[k], 0, 1)) || p.roi.w <= 0 || p.roi.h <= 0 || p.roi.x + p.roi.w > 1.000000001 || p.roi.y + p.roi.h > 1.000000001) fail('invalid_roi');
    if (!['on', 'off', 'red', 'green', 'blue', 'yellow', 'unknown'].includes(p.expected_state)) fail('invalid_expected_state');
    return { id: p.id, name: p.name.trim(), ...pose(p), roi: { x: p.roi.x, y: p.roi.y, w: p.roi.w, h: p.roi.h }, expected_state: p.expected_state };
  });
}
export function command(body, currentPresets) {
  if (!object(body) || !identifier(body.request_id) || !object(body.args ?? {})) fail('invalid_command');
  const args = body.args ?? {};
  let result;
  switch (body.type) {
    case 'move': result = pose(args); break;
    case 'preset':
      if (!currentPresets.some(p => p.id === args.preset_id)) fail('unknown_preset');
      result = { preset_id: args.preset_id }; break;
    case 'mode':
      if (!MODES.includes(args.mode)) fail('invalid_mode');
      result = { mode: args.mode }; break;
    case 'capture': case 'recheck':
      if (Object.keys(args).length) fail('unexpected_arguments');
      result = {}; break;
    default: fail('unknown_command_type');
  }
  return { type: body.type, args: result, request_id: body.request_id };
}
export function observation(value, currentPresets, allowHistoricalUnknown = false) {
  if (!object(value) || !identifier(value.preset_id) || (!allowHistoricalUnknown && !currentPresets.some(p => p.id === value.preset_id))) fail('unknown_preset');
  if (!['on', 'off', 'red', 'green', 'blue', 'yellow', 'unknown'].includes(value.state) || !finite(value.confidence, 0, 1)) fail('invalid_observation');
  return { preset_id: value.preset_id, state: value.state, confidence: value.confidence };
}
export function deviceEvent(value, currentPresets, allowHistoricalUnknown = false) {
  if (!identifier(value.event_id)) fail('invalid_event_id');
  if (!['observation', 'state_changed', 'uncertain', 'sensor_trigger', 'recheck', 'fault'].includes(value.kind)) fail('invalid_event_kind');
  const obs = observation(value, currentPresets, allowHistoricalUnknown);
  // 不接受设备提交任意外部 URL，避免在浏览器中载入第三方追踪资源或脚本。
  if (value.evidence_url != null && (typeof value.evidence_url !== 'string' || !/^\/api\/evidence\/[0-9a-f-]{36}$/.test(value.evidence_url))) fail('invalid_evidence_url');
  if (value.reason != null && (typeof value.reason !== 'string' || value.reason.length > 160)) fail('invalid_event_reason');
  return { ...obs, kind: value.kind, evidence_url: value.evidence_url ?? null, reason: value.reason ?? null };
}
