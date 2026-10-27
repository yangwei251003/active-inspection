import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeLimits,validatePose,validateRoi,statusLabel,toCsv,eventConfiguration,safeEvidenceUrl,getObservation,sourceLabel} from '../assets/model.js';

test('统一安全角度边界，拒绝非有限数并只允许服务端收窄',()=>{
  assert.deepEqual(normalizeLimits(),{pan_min:30,pan_max:150,tilt_min:45,tilt_max:120});
  assert.equal(validatePose(30,45),null);assert.equal(validatePose(150,120),null);
  assert.ok(validatePose(29.9,90));assert.ok(validatePose(90,120.1));assert.ok(validatePose(NaN,90));
  assert.deepEqual(normalizeLimits({pan_min:0,pan_max:180}),normalizeLimits());
  assert.equal(normalizeLimits({pan_min:40,pan_max:100}).pan_min,40);
  assert.equal(normalizeLimits({pan_min:160,pan_max:170}).pan_min,30);
});
test('ROI校验防止越界、零面积和非法数字',()=>{
  assert.equal(validateRoi({x:0,y:0,w:1,h:1}),null);assert.ok(validateRoi({x:.7,y:0,w:.4,h:.1}));assert.ok(validateRoi({x:0,y:0,w:0,h:.1}));assert.ok(validateRoi({x:0,y:0,w:NaN,h:.1}));
});
test('已排队和已接收永远不能显示成执行完成',()=>{
  assert.match(statusLabel({status:'queued'}),/等待设备接收/);assert.match(statusLabel({status:'acknowledged'}),/等待执行结果/);assert.match(statusLabel({status:'completed'}),/报告执行完成/);assert.match(statusLabel({status:'completed',source:'simulator'}),/^模拟器/);
});
test('未知来源不升级成实物验证',()=>{assert.equal(sourceLabel(null),'来源未标注');assert.equal(sourceLabel('simulator'),'模拟器数据');});
test('CSV保留模拟来源、正确转义、消除电子表格公式注入',()=>{
  const csv=toCsv([{id:'=WEBSERVICE("x")',at:'2026-01-01',state:'"红,灯"\n亮',source:'simulator'},{id:' +CMD',source:'hardware'}]);
  assert.ok(csv.startsWith('\uFEFF'));assert.ok(csv.includes("'=WEBSERVICE"));assert.ok(csv.includes("' +CMD"));assert.ok(csv.includes('""红,灯""\n亮'));assert.ok(csv.includes('"simulator"'));
});
test('证据地址只接受同源HTTP(S)，拒绝脚本和外站',()=>{
  const base='https://example.test/';assert.equal(safeEvidenceUrl('/api/evidence/123',base),'https://example.test/api/evidence/123');assert.equal(safeEvidenceUrl('javascript:alert(1)',base),null);assert.equal(safeEvidenceUrl('//evil.test/photo',base),null);assert.equal(safeEvidenceUrl('https://user:password@example.test/x',base),null);
});
test('兼容按点键名和数组的真实状态容器',()=>{assert.equal(getObservation([{preset_id:'p1',state:'on'}],'p1').state,'on');assert.equal(getObservation({p1:{state:'off'}},'p1').state,'off');assert.equal(getObservation(null,'p1'),null);});
test('历史与未核实事件不得借用当前观察点名；配置变化后旧current事件显示历史',()=>{const event={kind:'observation',preset_revision:1,configuration_status:'current'};assert.equal(eventConfiguration(event,1).useCurrentName,true);assert.equal(eventConfiguration(event,2).status,'historical');assert.equal(eventConfiguration({...event,configuration_status:'unresolved'},1).useCurrentName,false);assert.equal(eventConfiguration({kind:'observation'},1).status,'unresolved');assert.equal(eventConfiguration({kind:'device_online'},1),null);const csv=toCsv([event],{currentPresetRevision:2});assert.match(csv,/configuration_status_at_ingest/);assert.match(csv,/历史配置 · r1/);});
