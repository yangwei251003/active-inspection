import test from 'node:test';
import assert from 'node:assert/strict';
import {BLE,encodeLine,fragmentLine,JsonLineDecoder,BleLink} from '../assets/ble.js';

test('UTF8分片跨中文字符、通知帧合并仍能还原JSON行',()=>{
  const expected={id:'1',ok:true,data:{device_id:'客厅巡检终端'}},result=[];const decoder=new JsonLineDecoder(message=>result.push(message));const bytes=encodeLine(expected);
  for(const byte of bytes) decoder.push(new Uint8Array([byte]));assert.deepEqual(result,[expected]);
  const joined=new Uint8Array([...bytes,...bytes]);decoder.push(new DataView(joined.buffer));assert.equal(result.length,3);
});
test('蓝牙整行长度包含换行，20字节写入分片不截断消息',()=>{
  const bytes=encodeLine({id:'a',op:'info',args:{}});const parts=fragmentLine(bytes);assert.ok(parts.every(part=>part.length<=20));assert.deepEqual(new Uint8Array(parts.flatMap(part=>[...part])),bytes);assert.throws(()=>encodeLine({x:'中'.repeat(200)}),/过长/);
});
test('超长行一直丢弃到换行并能恢复下一行，不解析尾部伪消息',()=>{
  const messages=[],errors=[];const decoder=new JsonLineDecoder(message=>messages.push(message),error=>errors.push(error));decoder.push(new TextEncoder().encode('x'.repeat(600)+'{"ok":true}\n'));decoder.push(encodeLine({id:'2',ok:true}));assert.equal(errors.length,1);assert.deepEqual(messages,[{id:'2',ok:true}]);
});
test('损坏UTF8与非对象JSON被拒绝',()=>{const errors=[],messages=[];const decoder=new JsonLineDecoder(message=>messages.push(message),error=>errors.push(error));decoder.push(new Uint8Array([0xff,10]));decoder.push(new TextEncoder().encode('[1,2]\n'));assert.equal(errors.length,2);assert.equal(messages.length,0);});
function connectedLink(){const link=new BleLink();link.device={gatt:{connected:true}};const writes=[];link.rx={writeValueWithResponse:async bytes=>writes.push(bytes)};return {link,writes};}
test('写操作必须先有配对窗口与令牌，info不发送令牌',async()=>{
  const {link,writes}=connectedLink();await assert.rejects(()=>link.send('move',{pan_deg:90,tilt_deg:90},''),/会话令牌/);await assert.rejects(()=>link.send('move',{},'secret'),/窗口/);assert.equal(writes.length,0);
  const info=link.send('info',{},'must-not-send');await new Promise(resolve=>setImmediate(resolve));link.receive({id:'b1',ok:true,data:{pairing_window_open:true}});await info;
  const content=new TextDecoder().decode(new Uint8Array(writes.flatMap(bytes=>[...bytes])));assert.ok(!content.includes('must-not-send'));assert.ok(!content.includes('token'));
});
test('长消息串行写入避免多个请求分片交错，并按id匹配回应',async()=>{
  const {link,writes}=connectedLink();link.info={pairing_window_open:true};const first=link.send('move',{pan_deg:90,tilt_deg:90},'short-token');const second=link.send('mode',{mode:'paused'},'short-token');await new Promise(resolve=>setImmediate(resolve));
  const text=new TextDecoder().decode(new Uint8Array(writes.flatMap(bytes=>[...bytes]))),lines=text.trim().split('\n').map(JSON.parse);assert.equal(lines.length,2);assert.equal(lines[0].op,'move');assert.equal(lines[1].op,'mode');link.receive({id:'b2',ok:true,data:{accepted:true}});link.receive({id:'b1',ok:true,data:{accepted:true}});assert.deepEqual(await first,{accepted:true});assert.deepEqual(await second,{accepted:true});
});
test('设备错误不得原样回显可能含有的WiFi密码',async()=>{const {link}=connectedLink();const pending=link.send('info');await new Promise(resolve=>setImmediate(resolve));link.receive({id:'b1',ok:false,error:'wifi_password=do-not-show'});await assert.rejects(pending,error=>!error.message.includes('do-not-show'));});
test('断开时清空待确认请求和信息，不宣布完成',async()=>{const {link}=connectedLink();const pending=link.send('info');await new Promise(resolve=>setImmediate(resolve));link.clear();await assert.rejects(pending,/结果未确认/);assert.equal(link.pending.size,0);assert.equal(link.info,null);});
