// WHEP 非 trickle ICE 接收端：完整 SDP offer/answer；没有图片轮询或假视频回退。
export function parseIceServers(linkHeader = '') {
  const out = [];
  for (const part of linkHeader.split(/,(?=\s*<)/)) {
    const url = part.match(/<((?:stun|stuns|turn|turns):[^>]+)>/i)?.[1];
    if (!url || !/rel\s*=\s*"?ice-server"?/i.test(part)) continue;
    const username = part.match(/username="([^"]*)"/i)?.[1];
    const credential = part.match(/credential="([^"]*)"/i)?.[1];
    out.push({urls:url, ...(username !== undefined ? {username} : {}), ...(credential !== undefined ? {credential} : {})});
  }
  return out;
}
export async function waitForIce(pc, {timeoutMs = 12000, signal} = {}) {
  if (pc.iceGatheringState === 'complete') return;
  return new Promise((resolve, reject) => {
    let timer;
    const cleanup = () => { clearTimeout(timer); pc.removeEventListener('icegatheringstatechange', change); signal?.removeEventListener('abort', abort); };
    const change = () => { if (pc.iceGatheringState === 'complete') { cleanup(); resolve(); } };
    const abort = () => { cleanup(); reject(new DOMException('已取消连接', 'AbortError')); };
    pc.addEventListener('icegatheringstatechange', change);
    signal?.addEventListener('abort', abort, {once:true});
    timer = setTimeout(() => { cleanup(); reject(new Error('连接候选收集超时，请检查网络与中继配置。')); }, timeoutMs);
    if (signal?.aborted) abort();
  });
}
export class WhepPlayer {
  constructor({video, onState = () => {}, getCsrf = () => '', fetchFn = (...args) => globalThis.fetch(...args), peerFactory = config => new RTCPeerConnection(config), origin = globalThis.location?.origin || 'http://localhost'} = {}) {
    Object.assign(this, {video,onState,getCsrf,fetchFn,peerFactory,origin}); this.pc = null; this.sessionUrl = null; this.abort = null; this.connectionTimer = null; this.generation = 0;
  }
  headers(url, base = {}) { return new URL(url, this.origin).origin === this.origin ? {...base,'X-CSRF-Token':this.getCsrf()} : base; }
  credentials(url) { return new URL(url).origin === this.origin ? 'same-origin' : 'omit'; }
  async start(urlString) {
    await this.stop(false);
    const generation = this.generation;
    const endpoint = new URL(urlString, this.origin);
    if (!['http:','https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) throw new Error('视频地址格式不受支持。');
    if (this.origin.startsWith('https:') && endpoint.protocol !== 'https:') throw new Error('安全页面要求使用 HTTPS 视频地址。');
    const controller = new AbortController(); this.abort = controller;
    const requestTimer = setTimeout(() => controller.abort(), 25000);
    this.onState('connecting', '正在建立连续视频连接…');
    try {
      const options = await this.fetchFn(endpoint.href, {method:'OPTIONS', credentials:this.credentials(endpoint.href), signal:controller.signal});
      if (generation !== this.generation) return;
      if (!options.ok && options.status !== 405) throw new Error(options.status === 401 ? '视频登录权限已失效。' : '视频服务暂不可用，请检查部署配置。');
      const iceServers = parseIceServers(options.headers.get('Link') || '');
      const pc = this.peerFactory({iceServers}); this.pc = pc;
      pc.addTransceiver('video', {direction:'recvonly'});
      pc.ontrack = event => {
        if (generation !== this.generation) return;
        this.video.srcObject = event.streams?.[0] || new MediaStream([event.track]);
        this.video.play().catch(() => this.onState('play-required', '浏览器暂停了播放，请点击连接视频重试。'));
      };
      pc.onconnectionstatechange = () => {
        if (generation !== this.generation) return;
        if (pc.connectionState === 'connected') { clearTimeout(this.connectionTimer); this.onState('connected', '视频连接已建立'); }
        else if (['failed','disconnected','closed'].includes(pc.connectionState)) this.onState(pc.connectionState, pc.connectionState === 'failed' ? '视频连接失败，请检查网络与 TURN 中继。' : '视频已断开，可重新连接。');
      };
      await pc.setLocalDescription(await pc.createOffer());
      await waitForIce(pc, {signal:controller.signal});
      const response = await this.fetchFn(endpoint.href, {method:'POST',headers:this.headers(endpoint.href,{'Content-Type':'application/sdp','Accept':'application/sdp'}),body:pc.localDescription.sdp,credentials:this.credentials(endpoint.href),signal:controller.signal});
      if (response.status !== 201) throw new Error(response.status === 401 || response.status === 403 ? '视频访问校验失败，请重新登录。' : `视频服务未建立会话（${response.status}）。`);
      const location = response.headers.get('Location');
      if (!location) throw new Error('视频服务未返回会话位置，无法安全管理连接。');
      const session = new URL(location, endpoint);
      if (session.origin !== endpoint.origin || !['https:','http:'].includes(session.protocol) || session.username || session.password) throw new Error('视频会话地址与服务不一致。');
      if (generation !== this.generation) {
        await this.fetchFn(session.href, {method:'DELETE',headers:this.headers(session.href),credentials:this.credentials(session.href),signal:AbortSignal.timeout(4000)}).catch(()=>{});
        return;
      }
      this.sessionUrl = session.href;
      const answer = await response.text();
      if (!answer.startsWith('v=0')) throw new Error('视频服务返回了无效的 SDP。');
      if (generation !== this.generation) return;
      await pc.setRemoteDescription({type:'answer',sdp:answer});
      if (pc.connectionState !== 'connected') this.connectionTimer = setTimeout(() => { if (generation === this.generation && pc.connectionState !== 'connected') this.onState('failed','视频未能连通；跨网络连接可能需要可用的 TURN 中继。'); }, 20000);
    } catch (error) {
      if (generation === this.generation) { await this.stop(false); this.onState('failed', error.name === 'AbortError' ? '视频连接已取消或超时。' : error.message); }
      throw error;
    } finally { clearTimeout(requestTimer); }
  }
  async stop(notify = true) {
    this.generation++;
    clearTimeout(this.connectionTimer); this.abort?.abort(); this.abort = null;
    if (this.pc) { this.pc.ontrack = null; this.pc.onconnectionstatechange = null; this.pc.close(); this.pc = null; }
    if (this.video) this.video.srcObject = null;
    const session = this.sessionUrl; this.sessionUrl = null;
    if (session) {
      try { await this.fetchFn(session, {method:'DELETE',headers:this.headers(session),credentials:this.credentials(session),keepalive:true,signal:AbortSignal.timeout(4000)}); } catch { /* 服务端另有会话超时；不在 UI 泄露底层响应。 */ }
    }
    if (notify) this.onState('idle', '视频连接已释放');
  }
}
