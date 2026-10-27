export const BLE = Object.freeze({service:'9c770001-72c5-4f95-9d79-bb9cc5000001', rx:'9c770002-72c5-4f95-9d79-bb9cc5000001', tx:'9c770003-72c5-4f95-9d79-bb9cc5000001', maxBytes:512, chunkBytes:20});
export function encodeLine(message) {
  const bytes = new TextEncoder().encode(JSON.stringify(message) + '\n');
  if (bytes.length > BLE.maxBytes) throw new Error('蓝牙消息过长，请缩短名称或配置内容。');
  return bytes;
}
export function fragmentLine(bytes) { const parts = []; for (let i=0;i<bytes.length;i+=BLE.chunkBytes) parts.push(bytes.slice(i,i+BLE.chunkBytes)); return parts; }
export class JsonLineDecoder {
  constructor(onMessage, onError = () => {}) { this.onMessage = onMessage; this.onError = onError; this.buffer = []; this.discarding = false; }
  push(input) {
    const bytes = input instanceof DataView ? new Uint8Array(input.buffer,input.byteOffset,input.byteLength) : new Uint8Array(input);
    for (const byte of bytes) {
      if (this.discarding) { if (byte === 10) this.discarding = false; continue; }
      this.buffer.push(byte);
      if (this.buffer.length > BLE.maxBytes) { this.buffer = []; this.discarding = byte !== 10; this.onError(new Error('设备通知超过协议长度，已丢弃。')); continue; }
      if (byte === 10) {
        const line = new Uint8Array(this.buffer); this.buffer = [];
        try { const message = JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(line)); if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error(); this.onMessage(message); }
        catch { this.onError(new Error('设备通知不是有效的 JSON 消息。')); }
      }
    }
  }
  reset() { this.buffer = []; this.discarding = false; }
}
export class BleLink {
  constructor({bluetooth = globalThis.navigator?.bluetooth,onConnection=()=>{},onInfo=()=>{},onError=()=>{}}={}) {
    Object.assign(this,{bluetooth,onConnection,onInfo,onError}); this.device=null; this.rx=null; this.tx=null; this.pending=new Map(); this.writeChain=Promise.resolve(); this.serial=0; this.info=null;
    this.decoder=new JsonLineDecoder(message=>this.receive(message),onError);
    this.notification=event=>this.decoder.push(event.target.value);
    this.disconnected=()=>this.clear();
  }
  async connect() {
    if (!this.bluetooth) throw new Error('当前浏览器不支持 Web Bluetooth。');
    this.disconnect();
    // 必须直接由真实按钮手势调用；不自动弹出蓝牙选择器。
    const device = await this.bluetooth.requestDevice({filters:[{services:[BLE.service]}]});
    this.device=device; device.addEventListener('gattserverdisconnected',this.disconnected);
    try {
      const server=await device.gatt.connect();
      const service=await server.getPrimaryService(BLE.service);
      this.rx=await service.getCharacteristic(BLE.rx); this.tx=await service.getCharacteristic(BLE.tx);
      this.tx.addEventListener('characteristicvaluechanged',this.notification); await this.tx.startNotifications();
      this.onConnection(true,device.name || '巡检终端');
      return await this.send('info');
    } catch(error) { this.disconnect(); throw error; }
  }
  async send(op,args={},token='') {
    if (!this.rx || !this.device?.gatt?.connected) throw new Error('请先连接蓝牙设备。');
    if (!['info','move','mode','wifi_config'].includes(op)) throw new Error('不支持的近场操作。');
    if (op !== 'info') {
      if (!token.trim()) throw new Error('请填写设备本次配对窗口提供的会话令牌。');
      if (this.info?.pairing_window_open !== true) throw new Error('设备未报告配对窗口已开启，请在设备上开启窗口并重新读取信息。');
    }
    const id=`b${++this.serial}`;
    const bytes=encodeLine({id,op,...(op === 'info' ? {} : {token}),args});
    let resolve, reject;
    const response=new Promise((res,rej)=>{resolve=res;reject=rej;});
    // 先建立通知等待器，再写入；定时器在排队完后开始，避免长队列误超时。
    const pending={resolve,reject,timer:null}; this.pending.set(id,pending);
    const rx=this.rx;
    const write=this.writeChain.catch(()=>{}).then(async()=>{
      if (rx !== this.rx) throw new Error('蓝牙连接已经变化，请重新操作。');
      pending.timer=setTimeout(()=>{this.pending.delete(id);reject(new Error('设备响应超时，未确认操作结果。'));},8000);
      for (const chunk of fragmentLine(bytes)) await rx.writeValueWithResponse(chunk);
    });
    this.writeChain=write;
    write.catch(()=>{clearTimeout(pending.timer);this.pending.delete(id);reject(new Error('蓝牙发送失败，未确认操作结果。'));});
    return response;
  }
  receive(message) {
    const pending=this.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer);this.pending.delete(message.id);
    if (message.ok === true) {
      if (message.data && typeof message.data === 'object' && ('pairing_window_open' in message.data || 'device_id' in message.data)) { this.info=message.data;this.onInfo(message.data); }
      pending.resolve(message.data || {});
    } else {
      const code=typeof message.error==='string' ? message.error : message.error?.code;
      const errors={pairing_closed:'配对窗口已关闭，请重新开启。',unauthorized:'会话令牌无效或已过期。',invalid_token:'会话令牌无效或已过期。',encrypted_link_required:'设备要求加密蓝牙连接，请完成系统配对后重试。',invalid_args:'设备拒绝了参数，请检查输入。'};
      // 不原样展示设备 error，防止固件回显口令。
      pending.reject(new Error(errors[code] || '设备未接受本次操作，请检查配对窗口和参数。'));
    }
  }
  clear() { this.tx?.removeEventListener('characteristicvaluechanged',this.notification);this.rx=null;this.tx=null;this.info=null;this.decoder.reset();for(const pending of this.pending.values()){clearTimeout(pending.timer);pending.reject(new Error('蓝牙已断开，操作结果未确认。'));}this.pending.clear();this.onConnection(false); }
  disconnect() { const device=this.device;this.device=null;device?.removeEventListener('gattserverdisconnected',this.disconnected);if(device?.gatt?.connected) device.gatt.disconnect();this.clear(); }
}
