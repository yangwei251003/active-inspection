export class ApiError extends Error {
  constructor(message, status, code) { super(message); this.name = 'ApiError'; this.status = status; this.code = code; }
}
const MESSAGES = {invalid_password:'口令不正确，请重试。',invalid_credentials:'口令不正确，请重试。',unauthorized:'登录已失效，请重新登录。',authentication_required:'登录已失效，请重新登录。',forbidden:'当前操作没有权限。',csrf_failed:'会话校验失败，请刷新页面后重试。',csrf_rejected:'会话校验失败，请刷新页面后重试。',device_offline:'设备尚未在线，无法下发指令。',presets_not_synced:'观察点配置尚未同步到设备，请等待后重试。',rate_limited:'操作过于频繁，请稍后再试。',invalid_request:'提交内容不符合要求，请检查输入。'};
export class ApiClient {
  // 浏览器 fetch 要求 Window 接收者；包装后不受 ApiClient 方法调用的 this 影响。
  constructor({fetchFn = (...args) => globalThis.fetch(...args), onUnauthorized = () => {}} = {}) { this.fetch = fetchFn; this.csrf = ''; this.onUnauthorized = onUnauthorized; }
  async request(path, {method = 'GET', body, signal} = {}) {
    const headers = {'Accept':'application/json'};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (!['GET','HEAD','OPTIONS'].includes(method) && this.csrf) headers['X-CSRF-Token'] = this.csrf;
    const response = await this.fetch(path, {method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials:'same-origin', cache:'no-store', signal});
    const data = response.status === 204 ? {} : await response.json().catch(() => ({}));
    if (!response.ok) {
      const code = typeof data.error === 'string' ? data.error : data.error?.code || data.code;
      if (response.status === 401 && !(path === '/api/session' && method === 'POST')) this.onUnauthorized();
      throw new ApiError(MESSAGES[code] || (response.status === 429 ? '操作过于频繁，请稍后重试。' : `请求未完成（${response.status}），请稍后重试。`), response.status, code);
    }
    if (data.csrf_token) this.csrf = data.csrf_token;
    return data;
  }
}

export class StateSocket {
  constructor({url, onMessage, onState, onUnauthorized = () => {}, socketFactory = value => new WebSocket(value)}) { Object.assign(this,{url,onMessage,onState,onUnauthorized,socketFactory}); this.socket = null; this.timer = null; this.stopped = true; this.attempts = 0; }
  start() { if (!this.stopped) return; this.stopped = false; this.connect(); }
  connect() {
    if (this.stopped) return;
    this.onState('connecting');
    try { this.socket = this.socketFactory(this.url); } catch { this.schedule(); return; }
    const socket = this.socket;
    socket.onopen = () => { if (this.stopped || socket !== this.socket) return; this.attempts = 0; this.onState('connected'); };
    socket.onmessage = event => {
      if (socket !== this.socket || this.stopped) return;
      try { const data = JSON.parse(event.data); if (data && typeof data === 'object') this.onMessage(data); } catch { /* 丢弃非协议帧，不将原始内容写日志。 */ }
    };
    socket.onerror = () => { /* close 回调统一处理重连，避免重复连接。 */ };
    socket.onclose = event => {
      if(this.stopped || socket !== this.socket) return;
      if(event?.code===1008 && ['session_expired','session_replaced','logged_out'].includes(event.reason)) {
        this.stopped=true; this.onState('unauthorized'); this.onUnauthorized();
      } else this.schedule();
    };
  }
  schedule() { if (this.stopped) return; this.onState('disconnected'); clearTimeout(this.timer); this.timer = setTimeout(() => this.connect(), Math.min(30000, 1000 * 2 ** Math.min(this.attempts++, 5))); }
  stop() { this.stopped = true; clearTimeout(this.timer); if (this.socket) { this.socket.onclose = null; this.socket.close(); this.socket = null; } }
}
