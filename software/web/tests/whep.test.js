import test from 'node:test';
import assert from 'node:assert/strict';
import {WhepPlayer,parseIceServers,waitForIce} from '../assets/whep.js';
class Peer extends EventTarget {
  constructor(){super();this.iceGatheringState='complete';this.connectionState='new';this.transceivers=[];this.localDescription=null;this.remoteDescription=null;this.closed=false;}
  addTransceiver(kind,options){this.transceivers.push({kind,options});}
  async createOffer(){return{type:'offer',sdp:'v=0\r\no=browser\r\n'};}
  async setLocalDescription(value){this.localDescription=value;}
  async setRemoteDescription(value){this.remoteDescription=value;this.connectionState='connected';this.onconnectionstatechange?.();}
  close(){this.closed=true;this.connectionState='closed';}
}
test('WHEP Link头读取STUN/TURN和短时凭证，忽略无关link',()=>{
  const servers=parseIceServers('<stun:stun.example:3478>; rel="ice-server", <turn:relay.example:3478?transport=udp>; rel="ice-server"; username="short"; credential="secret", <https://bad.test>; rel="ice-server"');assert.equal(servers.length,2);assert.equal(servers[1].username,'short');assert.equal(servers[1].credential,'secret');
});
test('WHEP执行OPTIONS/SDP POST/answer，释放DELETE含同源CSRF',async()=>{
  const calls=[],peer=new Peer(),states=[],element={srcObject:null,play:async()=>{}};
  const player=new WhepPlayer({video:element,origin:'https://desk.test',getCsrf:()=> 'csrf-test',peerFactory:()=>peer,onState:state=>states.push(state),fetchFn:async(url,options)=>{calls.push({url,...options});if(options.method==='OPTIONS')return new Response(null,{status:204});if(options.method==='POST')return new Response('v=0\r\no=server\r\n',{status:201,headers:{Location:'/media/inspection/whep/session'}});return new Response(null,{status:204});}});
  await player.start('/media/inspection/whep');assert.equal(peer.remoteDescription.type,'answer');assert.equal(peer.transceivers[0].options.direction,'recvonly');assert.ok(states.includes('connected'));assert.equal(calls[1].body,peer.localDescription.sdp);assert.equal(calls[1].headers['X-CSRF-Token'],'csrf-test');await player.stop();assert.equal(calls[2].method,'DELETE');assert.equal(calls[2].url,'https://desk.test/media/inspection/whep/session');assert.ok(peer.closed);assert.equal(element.srcObject,null);
});
test('跨域WHEP不携带登录cookie和CSRF，Location不可跨服务转移',async()=>{
  const calls=[],peer=new Peer();const player=new WhepPlayer({video:{srcObject:null},origin:'https://desk.test',getCsrf:()=> 'do-not-leak',peerFactory:()=>peer,fetchFn:async(url,options)=>{calls.push(options);return options.method==='OPTIONS'?new Response(null,{status:204}):new Response('v=0\r\n',{status:201,headers:{Location:'https://evil.test/session'}});}});
  await assert.rejects(()=>player.start('https://media.test/whep'),/地址与服务不一致/);assert.equal(calls[0].credentials,'omit');assert.equal(calls[1].credentials,'omit');assert.equal(calls[1].headers['X-CSRF-Token'],undefined);assert.ok(peer.closed);
});
test('错误SDP不会变成已连接，已经创建的会话会释放',async()=>{
  const methods=[],player=new WhepPlayer({video:{srcObject:null},origin:'http://localhost',peerFactory:()=>new Peer(),fetchFn:async(url,options)=>{methods.push(options.method);if(options.method==='OPTIONS'||options.method==='DELETE')return new Response(null,{status:204});return new Response('<html>error</html>',{status:201,headers:{Location:'/session'}});}});await assert.rejects(()=>player.start('/whep'),/无效的 SDP/);assert.deepEqual(methods,['OPTIONS','POST','DELETE']);assert.equal(player.pc,null);
});
test('安全页面拒绝HTTP视频与含凭据地址',async()=>{const player=new WhepPlayer({video:{srcObject:null},origin:'https://desk.test'});await assert.rejects(()=>player.start('http://desk.test/whep'),/HTTPS/);await assert.rejects(()=>player.start('https://user:pass@desk.test/whep'),/格式/);});
test('ICE收集超时和取消均可终止，没有无限等待',async()=>{const peer=new Peer();peer.iceGatheringState='gathering';await assert.rejects(()=>waitForIce(peer,{timeoutMs:5}),/超时/);const controller=new AbortController();const pending=waitForIce(peer,{timeoutMs:100,signal:controller.signal});controller.abort();await assert.rejects(pending,error=>error.name==='AbortError');});
