// 纯函数：界面只展示有来源的数据，不生成假设备状态或假视频。
export const DEFAULT_LIMITS = Object.freeze({pan_min: 30, pan_max: 150, tilt_min: 45, tilt_max: 120});
export const STATUS_LABELS = Object.freeze({queued:'已排队，等待设备接收', acknowledged:'设备已接收，等待执行结果', completed:'设备报告执行完成', rejected:'指令被拒绝', expired:'指令已过期，未再执行'});
export const STATE_LABELS = Object.freeze({on:'亮起', off:'熄灭', red:'红色', green:'绿色', blue:'蓝色', yellow:'黄色', unknown:'待确认', uncertain:'不确定', unavailable:'暂无结果', normal:'符合预期', abnormal:'偏离预期'});
export const MODE_LABELS = Object.freeze({manual:'手动观察', patrol:'正在巡检', paused:'已暂停'});
export function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }
export function normalizeLimits(value = {}) {
  const out = {...DEFAULT_LIMITS};
  // 服务端可进一步收窄操作范围，但界面不会放开采购前保守边界。
  for (const axis of ['pan', 'tilt']) {
    const low = Number(value[`${axis}_min`]), high = Number(value[`${axis}_max`]);
    if (Number.isFinite(low) && Number.isFinite(high) && low <= high && low <= out[`${axis}_max`] && high >= out[`${axis}_min`]) {
      out[`${axis}_min`] = Math.max(out[`${axis}_min`], low);
      out[`${axis}_max`] = Math.min(out[`${axis}_max`], high);
    }
  }
  return out;
}
export function validatePose(pan, tilt, limits = DEFAULT_LIMITS) {
  if (!Number.isFinite(pan) || !Number.isFinite(tilt)) return '请填写有效角度。';
  if (pan < limits.pan_min || pan > limits.pan_max || tilt < limits.tilt_min || tilt > limits.tilt_max) return `水平范围 ${limits.pan_min}–${limits.pan_max}°，俯仰范围 ${limits.tilt_min}–${limits.tilt_max}°。`;
  return null;
}
export function validateRoi(roi) {
  if (!roi || ['x','y','w','h'].some(key => !Number.isFinite(roi[key]))) return '识别区域必须是有效数字。';
  if (roi.x < 0 || roi.y < 0 || roi.w < 0.01 || roi.h < 0.01 || roi.x + roi.w > 1.000001 || roi.y + roi.h > 1.000001) return '识别区域必须完整位于画面内，宽高至少为 0.01。';
  return null;
}
export function sourceLabel(source) { return source === 'simulator' ? '模拟器数据' : source === 'hardware' ? '设备上报' : '来源未标注'; }
export function stateLabel(state) { return STATE_LABELS[state] || String(state || '暂无结果'); }
export function statusLabel(command) {
  if (!command) return '尚无指令';
  const label = STATUS_LABELS[command.status] || '等待状态更新';
  return command.source === 'simulator' ? `模拟器：${label}` : label;
}
export function safeEvidenceUrl(value, base) {
  if (!value || typeof value !== 'string') return null;
  try {
    const url = new URL(value, base);
    // 证据只从本服务领取，避免页面内容变成任意外站跳转/凭据泄漏入口。
    return ['http:', 'https:'].includes(url.protocol) && url.origin === new URL(base).origin && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}
export function formatDate(value, includeDate = false) {
  if (!value) return '未记录';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '时间未知';
  return new Intl.DateTimeFormat('zh-CN', includeDate ? {month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false} : {hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(date);
}
export function eventConfiguration(event, currentRevision) {
  if (!['observation','state_change','state_changed','change','recheck','capture','sensor','sensor_trigger','uncertain','fault'].includes(event.kind)) return null;
  const revision=Number.isSafeInteger(event.preset_revision)&&event.preset_revision>0?event.preset_revision:null;
  if(!revision || !['current','historical'].includes(event.configuration_status)) return {status:'unresolved',label:'配置未核实',useCurrentName:false};
  if(event.configuration_status==='historical'||(Number.isSafeInteger(currentRevision)&&revision!==currentRevision)) return {status:'historical',label:`历史配置 · r${revision}`,useCurrentName:false};
  const current=revision===currentRevision;
  return {status:current?'current':'verified',label:`${current?'当前配置':'采集配置'} · r${revision}`,useCurrentName:current};
}
export function toCsv(events, {currentPresetRevision} = {}) {
  // 防止实验 CSV 被 Excel 当成公式；同时保持对逗号、引号、换行的正确转义。
  const cell = value => {
    let text = value == null ? '' : String(value);
    if (/^[\s]*[=+@-]/u.test(text)) text = `'${text}`;
    return `"${text.replaceAll('"', '""')}"`;
  };
  const fields = ['id','at','device_at','kind','preset_id','preset_revision','configuration_status_at_ingest','configuration_reason','configuration_label_at_export','current_revision_at_export','state','confidence','source','evidence_url'];
  return '\uFEFF' + [fields.map(cell).join(','), ...events.map(event => {const row={...event,configuration_status_at_ingest:event.configuration_status,configuration_label_at_export:eventConfiguration(event,currentPresetRevision)?.label,current_revision_at_export:currentPresetRevision};return fields.map(key => cell(row[key])).join(',');})].join('\r\n');
}
export function getObservation(observations, id) {
  if (Array.isArray(observations)) return observations.find(item => item.preset_id === id || item.id === id) || null;
  return observations?.[id] || null;
}
export function makeNode(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = String(text);
  return node;
}
