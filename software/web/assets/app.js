import {ApiClient, StateSocket} from './api.js';
import {WhepPlayer} from './whep.js';
import {BleLink} from './ble.js';
import {clamp, normalizeLimits, validatePose, validateRoi, stateLabel, statusLabel, sourceLabel, formatDate, safeEvidenceUrl, toCsv, eventConfiguration, getObservation, makeNode, MODE_LABELS} from './model.js';

const $ = id => document.getElementById(id);
const ui = {authenticated:false, state:null, presets:[], events:[], commands:new Map(), latestCommand:null, socketState:'disconnected', limits:normalizeLimits(), view:'overview', videoState:'idle', refreshTimer:null, socket:null, toastTimer:null, sessionGeneration:0};
const api = new ApiClient({onUnauthorized:() => endSession('会话已过期，请重新登录。')});
const video = new WhepPlayer({video:$('live-video'),getCsrf:() => api.csrf,onState:onVideoState});
const ble = new BleLink({onConnection:onBleConnection,onInfo:renderBleInfo,onError:error => bleFeedback(error.message,true)});

function toast(message) { $('toast').textContent=message; $('toast').hidden=false;clearTimeout(ui.toastTimer);ui.toastTimer=setTimeout(() => { $('toast').hidden=true; },4800); }
function errorMessage(error) { return error?.name==='TypeError' ? '暂时无法连接服务，请检查网络。' : error?.message || '操作未完成，请重试。'; }
function setChip(element,text,type='neutral') { element.textContent=text;element.className=`chip ${type}`; }
function emptyState(title,description) { const node=makeNode('div','empty-state');node.append(makeNode('strong','',title),makeNode('p','',description));return node; }
function button(text,action,style='text-button',disabled=false) { const node=makeNode('button',style,text);node.type='button';node.disabled=disabled;node.addEventListener('click',action);return node; }
function ready() { return ui.authenticated && ui.state?.online===true && ui.socketState==='connected'; }
function synced() { return ui.state?.presets_revision==null || ui.state.presets_applied_revision===ui.state.presets_revision; }
function isSimulator() { return ui.state?.source==='simulator'; }

async function startSession() {
  ui.authenticated=true; ui.sessionGeneration++;
  $('password').value='';$('login-error').textContent='';$('login-screen').hidden=true;$('workspace').hidden=false;
  const url=new URL('/ws/client',location.href);url.protocol=location.protocol==='https:'?'wss:':'ws:';
  ui.socket?.stop();ui.socket=new StateSocket({url:url.href,onMessage:onSocketMessage,onUnauthorized:()=>endSession('会话已过期或已在其他页面退出，请重新登录。'),onState:state=>{ui.socketState=state;renderConnection();renderControls();}});ui.socket.start();
  await refreshAll();
  clearInterval(ui.refreshTimer);ui.refreshTimer=setInterval(() => { if(ui.authenticated) refreshState().catch(()=>{}); },15000);
}
async function endSession(message='') {
  if (!ui.authenticated && !$('login-screen').hidden) { if(message) $('login-error').textContent=message; return; }
  ui.authenticated=false;ui.sessionGeneration++;clearInterval(ui.refreshTimer);ui.socket?.stop();ui.socket=null;ui.socketState='disconnected';
  await video.stop(false);ble.disconnect();api.csrf='';ui.state=null;ui.presets=[];ui.events=[];ui.commands.clear();ui.latestCommand=null;
  $('workspace').hidden=true;$('login-screen').hidden=false;$('login-error').textContent=message;$('preset-dialog').close();$('password').focus();
  for (const id of ['observation-cards','preset-list','recent-events','full-events']) $(id).replaceChildren();
}
async function refreshState() { const generation=ui.sessionGeneration;const state=await api.request('/api/state');if(ui.authenticated&&generation===ui.sessionGeneration) applyState(state); }
async function refreshAll() {
  const generation=ui.sessionGeneration;
  const results=await Promise.allSettled([api.request('/api/state'),api.request('/api/presets'),api.request('/api/events?limit=500'),api.request('/api/commands?limit=50')]);
  if(!ui.authenticated||generation!==ui.sessionGeneration) return;
  if(results[0].status==='fulfilled') applyState(results[0].value);else toast(errorMessage(results[0].reason));
  if(results[1].status==='fulfilled'){ui.presets=results[1].value.presets||[];renderPresets();renderObservations();}
  if(results[2].status==='fulfilled'){ui.events=results[2].value.events||[];renderEvents();}
  if(results[3].status==='fulfilled'){for(const command of results[3].value.commands||[]) ui.commands.set(command.command_id,command);const ordered=[...ui.commands.values()].sort((a,b)=>String(b.created_at).localeCompare(String(a.created_at)));if(ordered.length) {ui.latestCommand=ordered[0].command_id;renderCommand(ordered[0]);}}
}
function onSocketMessage(message) {
  if(message.type==='state'&&message.state) applyState(message.state);
  else if(message.type==='event'&&message.event) {ui.events=[message.event,...ui.events.filter(item=>item.id!==message.event.id)].slice(0,500);renderEvents();}
  else if(message.type==='command_status'&&message.command){ui.commands.set(message.command.command_id,message.command);if(!ui.latestCommand||ui.latestCommand===message.command.command_id) renderCommand(message.command);}
  else if(message.type==='presets') {api.request('/api/presets').then(result=>{ui.presets=result.presets||[];renderPresets();renderObservations();}).catch(()=>{});}
}
function applyState(state) {
  ui.state=state;ui.limits=normalizeLimits(state.limits);
  $('simulator-banner').hidden=!isSimulator();$('sidebar-device').textContent=state.device_id||'等待设备';
  $('pan-display').textContent=Number.isFinite(state.pan_deg)?state.pan_deg.toFixed(1):'—';$('tilt-display').textContent=Number.isFinite(state.tilt_deg)?state.tilt_deg.toFixed(1):'—';
  for(const [id,axis] of [['pan-input','pan'],['preset-pan','pan'],['tilt-input','tilt'],['preset-tilt','tilt']]){$(id).min=String(ui.limits[`${axis}_min`]);$(id).max=String(ui.limits[`${axis}_max`]);}
  // 用户正在输入时，遥测不会覆盖输入框。
  if(document.activeElement!==$('pan-input')&&Number.isFinite(state.pan_deg)) $('pan-input').value=state.pan_deg;
  if(document.activeElement!==$('tilt-input')&&Number.isFinite(state.tilt_deg)) $('tilt-input').value=state.tilt_deg;
  setChip($('mode-chip'),MODE_LABELS[state.mode]||'尚无状态',state.mode==='patrol'?'good':'neutral');
  $('active-point-label').textContent=ui.presets.find(item=>item.id===state.active_preset)?.name||'尚未选择观察点';
  $('last-updated').textContent=state.last_seen?`上次设备上报 ${formatDate(state.last_seen,true)} · ${sourceLabel(state.source)}`:'尚未收到设备数据';
  for(const command of state.pending_commands||[]) ui.commands.set(command.command_id,command);
  renderConnection();renderControls();renderObservations();
  if(!state.video?.available&&video.pc) video.stop();
}
function renderConnection() {
  const connected=ui.socketState==='connected', online=ui.state?.online===true;
  setChip($('connection-chip'),!navigator.onLine?'网络不可用':!connected?'状态连接中断':online?(isSimulator()?'模拟器在线':'设备在线'):'设备离线',connected&&online?'good':'warning');
  $('sidebar-dot').className=`status-dot ${connected&&online?'good':''}`;$('sidebar-status').textContent=connected?(online?(isSimulator()?'模拟设备 · 不代表实测':'设备已连接'):'等待终端上线'):'状态通道正在重连';
  const banner=$('connection-banner');
  if(!connected){banner.textContent='实时状态通道暂不可用，已暂停下发控制。正在自动重连；已有状态可能已经过时。';banner.hidden=false;}
  else if(!online){banner.textContent='终端尚未在线。可配置观察点与浏览历史，控制操作在设备上线后开放。';banner.hidden=false;}
  else if(!synced()){banner.textContent='观察点已保存到服务，正在等待设备确认同步。同步完成前暂不开启定位和巡检。';banner.hidden=false;}
  else banner.hidden=true;
}
function renderControls() {
  const enabled=ready();
  document.querySelectorAll('[data-nudge],#home-button,#move-form button,#pause-button,[data-device-command]').forEach(node=>node.disabled=!enabled);
  $('patrol-button').disabled=!enabled||!synced()||ui.presets.length===0;
  const available=ui.state?.video?.available===true&&!!ui.state?.video?.whep_url;
  $('video-start').disabled=!available||ui.videoState==='connecting';$('video-stop').disabled=!video.pc;
  if(!available&&ui.videoState!=='connected') $('video-message').textContent=isSimulator()?'当前使用模拟器，仅验证状态与控制流程。模拟器没有现场视频。':'设备连接并发布视频后，即可开始播放。';
  if(!ui.latestCommand) $('command-status').textContent=enabled?'每次转向 5°；实际角度需在实物上校准。':'控制指令将在设备在线时开放。';
  renderPresetButtons();
}
function renderPresetButtons() { document.querySelectorAll('[data-requires-device]').forEach(node=>{node.disabled=!ready()||(node.dataset.requiresDevice==='synced'&&!synced())||(node.dataset.requiresActivePreset&&node.dataset.requiresActivePreset!==ui.state?.active_preset);}); }
function renderCommand(command) {
  const suffix=command.command_id?` · ${String(command.command_id).slice(0,8)}`:'';
  $('command-status').textContent=statusLabel({...command,source:command.source||ui.state?.source})+suffix;
  $('command-status').className=`command-feedback ${['rejected','expired'].includes(command.status)?'error':command.status==='completed'?'success':''}`;
}
async function command(type,args={}) {
  if(!ready()){toast('设备或状态通道未在线，未发送控制指令。');return;}
  if(type==='move'){const problem=validatePose(args.pan_deg,args.tilt_deg,ui.limits);if(problem){toast(problem);return;}}
  $('command-status').textContent='正在提交，尚未确认设备接收…';$('command-status').className='command-feedback';
  try {const result=await api.request('/api/commands',{method:'POST',body:{type,args,request_id:crypto.randomUUID()}});if(result.command){ui.commands.set(result.command.command_id,result.command);ui.latestCommand=result.command.command_id;renderCommand(result.command);}else $('command-status').textContent='服务未返回指令编号，结果未确认。';}
  catch(error){$('command-status').textContent=errorMessage(error);$('command-status').className='command-feedback error';}
}
function renderObservations() {
  const container=$('observation-cards');container.replaceChildren();
  if(!ui.presets.length){container.append(emptyState('还没有观察点','添加第一个位置，让巡检有明确的目标。'));return;}
  ui.presets.forEach((preset,index)=>{
    const observation=getObservation(ui.state?.observations,preset.id);
    const card=makeNode('article','observation-card');card.append(makeNode('span','point-index',`POINT ${String(index+1).padStart(2,'0')}`),makeNode('h3','',preset.name));
    const state=observation?.state;const orb=makeNode('span',`state-orb ${['red','green','blue'].includes(state)?state:state?'':'unknown'}`);orb.setAttribute('aria-hidden','true');card.append(orb,makeNode('p','observation-state',observation?stateLabel(state):'等待首次观察'));
    const confidence=Number.isFinite(observation?.confidence)?` · 置信度 ${(observation.confidence*100).toFixed(0)}%`:'';
    card.append(makeNode('p','observation-meta',observation?`${formatDate(observation.at||observation.observed_at||observation.timestamp)}${confidence}`:`预期 ${stateLabel(preset.expected_state)}`));
    if(observation?.source==='simulator'||isSimulator()) card.append(makeNode('p','observation-meta','模拟器数据 · 非实物测量'));
    const actions=makeNode('div','observation-actions');const go=button('转到这里 ↗',()=>command('preset',{preset_id:preset.id}));go.dataset.requiresDevice='synced';const recheck=button('复查当前点',()=>command('recheck'));recheck.dataset.requiresDevice='synced';recheck.dataset.requiresActivePreset=preset.id;recheck.title='先转到这个观察点，再复查其状态';actions.append(go,recheck);card.append(actions);container.append(card);
  });renderPresetButtons();
}
function renderPresets() {
  const container=$('preset-list');container.replaceChildren();$('add-point').disabled=ui.presets.length>=3;
  if(!ui.presets.length) container.append(emptyState('从一个经常关心的设备开始','对准指示灯，保存角度与识别区域。'));
  ui.presets.forEach((preset,index)=>{
    const card=makeNode('article','preset-card'), head=makeNode('div','preset-card-head');head.append(makeNode('span','point-number',String(index+1).padStart(2,'0')),button('编辑',()=>openPreset(preset)));card.append(head,makeNode('h3','',preset.name));
    const thumbnail=makeNode('div','roi-thumbnail');thumbnail.setAttribute('aria-label','归一化识别区域示意，不是现场画面');const roi=makeNode('i');setRoiStyle(roi,preset.roi);thumbnail.append(roi);card.append(thumbnail);
    const details=makeNode('dl');for(const [key,value] of [['水平 / 俯仰',`${preset.pan_deg}° / ${preset.tilt_deg}°`],['预期状态',stateLabel(preset.expected_state)],['识别区域',`${Math.round(preset.roi.w*100)}% × ${Math.round(preset.roi.h*100)}%`]]) details.append(makeNode('dt','',key),makeNode('dd','',value));card.append(details);
    const actions=makeNode('div','preset-card-actions'),go=button('转到观察点',()=>command('preset',{preset_id:preset.id}),'button secondary');go.dataset.requiresDevice='synced';actions.append(go,button('复查当前点 ↗',()=>command('recheck')));actions.lastChild.dataset.requiresDevice='synced';actions.lastChild.dataset.requiresActivePreset=preset.id;actions.lastChild.title='先转到这个观察点，再复查其状态';card.append(actions);container.append(card);
  });
  const filter=$('event-filter'),selected=filter.value;filter.replaceChildren(new Option('全部观察点',''));ui.presets.forEach(preset=>filter.add(new Option(preset.name,preset.id)));filter.value=selected;
  renderPresetButtons();renderEvents();
}
const EVENT_LABELS={observation:'完成观察',state_change:'状态变化',state_changed:'状态变化',change:'状态变化',recheck:'复查结果',capture:'记录画面',device_online:'设备上线',device_offline:'设备离线',sensor:'传感事件',sensor_trigger:'传感事件',fault:'设备故障',uncertain:'需要确认',system:'系统记录'};
function eventRow(event) {
  const row=makeNode('article','event-row'),time=makeNode('div','event-time',formatDate(event.at));let date='日期未知';try{date=new Intl.DateTimeFormat('zh-CN',{month:'2-digit',day:'2-digit'}).format(new Date(event.at));}catch{}
  time.append(makeNode('small','',date));row.append(time);
  const config=eventConfiguration(event,ui.state?.presets_revision);
  const pointName=(!config||config.useCurrentName)?ui.presets.find(preset=>preset.id===event.preset_id)?.name:null;
  const content=makeNode('div','event-content'),heading=makeNode('h3','',pointName||event.preset_id||'终端');const badge=makeNode('span',`chip ${event.state==='uncertain'||event.state==='unknown'?'warning':'neutral'}`,event.state?stateLabel(event.state):(EVENT_LABELS[event.kind]||'设备记录'));heading.append(badge);content.append(heading);
  const confidence=Number.isFinite(event.confidence)?` · 置信度 ${(event.confidence*100).toFixed(0)}%`:'';
  content.append(makeNode('p','',`${EVENT_LABELS[event.kind]||String(event.kind||'记录')} · ${sourceLabel(event.source)}${confidence}`));
  if(config) content.append(makeNode('p',`event-configuration ${config.status==='unresolved'?'unresolved':''}`,config.label+(config.status==='unresolved'?' · 仅归档，不作为当前观察结论':'')));
  row.append(content);
  const url=safeEvidenceUrl(event.evidence_url,location.href);
  if(url){const link=makeNode('a','event-evidence');link.href=url;link.target='_blank';link.rel='noopener noreferrer';const image=document.createElement('img');image.src=url;image.alt='本次观察的图像证据';image.loading='lazy';image.addEventListener('error',()=>{image.remove();link.textContent='证据暂不可用 ↗';},{once:true});link.append(image,document.createTextNode('查看证据 ↗'));row.append(link);}else row.append(makeNode('span','no-evidence',event.evidence_url?'证据地址未通过校验':'未附图像证据'));
  return row;
}
function renderEvents() {
  const sorted=[...ui.events].sort((a,b)=>String(b.at).localeCompare(String(a.at))), filter=$('event-filter').value;
  for(const [id,list] of [['recent-events',sorted.slice(0,4)],['full-events',sorted.filter(event=>!filter||event.preset_id===filter)]]){const container=$(id);container.replaceChildren();if(!list.length) container.append(emptyState('暂时没有变化记录','设备完成观察后，时间与结果会出现在这里。'));else list.forEach(event=>container.append(eventRow(event)));}
  $('event-count').textContent=`已获取 ${ui.events.length} 条`;
}
function showView(name) {
  const names={overview:['现场概览','01'],points:['观察点','02'],events:['变化记录','03'],nearby:['近场连接','04']};if(!names[name]) return;
  ui.view=name;document.querySelectorAll('.view').forEach(node=>node.hidden=node.id!==`view-${name}`);document.querySelectorAll('[data-view]').forEach(node=>{node.classList.toggle('active',node.dataset.view===name);if(node.dataset.view===name)node.setAttribute('aria-current','page');else node.removeAttribute('aria-current');});
  $('view-title').replaceChildren(document.createTextNode(names[name][0]),makeNode('span','title-dot','.'));$('view-number').textContent=names[name][1];window.scrollTo({top:0,behavior:'instant'});
}

function onVideoState(state,message) {
  ui.videoState=state;$('video-status').textContent=message||'尚未连接';$('video-message').textContent=message||'请连接设备视频';$('video-empty').hidden=state==='connected'&&$('live-video').readyState>=2;
  setChip($('video-badge'),state==='connected'?'视频已连接':state==='connecting'?'正在连接':state==='failed'?'连接失败':'未播放',state==='connected'?'good':state==='failed'?'warning':'neutral');
  $('video-dot').className=`status-dot ${state==='connected'?'good':''}`;$('video-start').textContent=state==='connecting'?'连接中…':'连接视频';renderControls();
}
async function startVideo() { if(!ui.state?.video?.available||!ui.state.video.whep_url) return;try{await video.start(ui.state.video.whep_url);}catch(error){if(error.name!=='AbortError')toast(errorMessage(error));} }
$('live-video').addEventListener('loadedmetadata',()=>{$('video-resolution').textContent=`${$('live-video').videoWidth} × ${$('live-video').videoHeight}`;});
$('live-video').addEventListener('playing',()=>{if(ui.videoState==='connected')$('video-empty').hidden=true;});

function setRoiStyle(node,roi={x:.25,y:.25,w:.5,h:.5}) {node.style.left=`${roi.x*100}%`;node.style.top=`${roi.y*100}%`;node.style.width=`${roi.w*100}%`;node.style.height=`${roi.h*100}%`;}
function getRoi() {return Object.fromEntries(['x','y','w','h'].map(key=>[key,Number($(`roi-${key}`).value)]));}
function updateRoi(roi) {for(const key of ['x','y','w','h']) $(`roi-${key}`).value=Math.round(roi[key]*100)/100;setRoiStyle($('roi-box'),getRoi());}
function openPreset(preset) {
  $('preset-dialog-title').textContent=preset?'编辑观察点':'新建观察点';$('preset-id').value=preset?.id||'';$('preset-name').value=preset?.name||'';$('preset-pan').value=preset?.pan_deg??ui.state?.pan_deg??90;$('preset-tilt').value=preset?.tilt_deg??ui.state?.tilt_deg??90;$('preset-expected').value=preset?.expected_state||'on';updateRoi(preset?.roi||{x:.25,y:.25,w:.5,h:.5});$('preset-error').textContent='';$('delete-preset').hidden=!preset;
  $('roi-video').srcObject=$('live-video').srcObject;$('roi-no-video').hidden=!!$('live-video').srcObject;
  const width=$('live-video').videoWidth,height=$('live-video').videoHeight;$('roi-stage').style.aspectRatio=width&&height?`${width}/${height}`:'16/9';
  $('preset-dialog').showModal();
}
async function savePreset(event) {
  event.preventDefault();const name=$('preset-name').value.trim(),pan=Number($('preset-pan').value),tilt=Number($('preset-tilt').value),roi=getRoi();
  const problem=!name?'请为观察点命名。':validatePose(pan,tilt,ui.limits)||validateRoi(roi);if(problem){$('preset-error').textContent=problem;return;}
  const existing=$('preset-id').value;const available=['p1','p2','p3'].find(id=>!ui.presets.some(preset=>preset.id===id));const id=existing||available;if(!id){$('preset-error').textContent='第一版最多支持三个观察点。';return;}
  const preset={id,name,pan_deg:pan,tilt_deg:tilt,roi,expected_state:$('preset-expected').value};const presets=existing?ui.presets.map(item=>item.id===id?preset:item):[...ui.presets,preset];
  const submit=$('preset-form').querySelector('[type=submit]');submit.disabled=true;
  try{const result=await api.request('/api/presets',{method:'PUT',body:{presets}});ui.presets=result.presets||presets;renderPresets();renderObservations();$('preset-dialog').close();toast('观察点已保存；是否同步完成以设备确认状态为准。');await refreshState();}catch(error){$('preset-error').textContent=errorMessage(error);}finally{submit.disabled=false;}
}
async function deletePreset() {
  const id=$('preset-id').value;if(!id)return;
  // 只删除明确打开的当前观察点；避免无提示的一次点击破坏配置。
  if(!window.confirm('删除这个观察点？对应历史记录会保留。'))return;
  try{const presets=ui.presets.filter(item=>item.id!==id);const result=await api.request('/api/presets',{method:'PUT',body:{presets}});ui.presets=result.presets||presets;renderPresets();renderObservations();$('preset-dialog').close();toast('观察点已删除，正在等待设备同步。');await refreshState();}catch(error){$('preset-error').textContent=errorMessage(error);}
}
let drag=null;
$('roi-overlay').addEventListener('pointerdown',event=>{const rect=event.currentTarget.getBoundingClientRect();drag={x:clamp((event.clientX-rect.left)/rect.width,0,1),y:clamp((event.clientY-rect.top)/rect.height,0,1)};event.currentTarget.setPointerCapture(event.pointerId);});
$('roi-overlay').addEventListener('pointermove',event=>{if(!drag)return;const rect=event.currentTarget.getBoundingClientRect(),x=clamp((event.clientX-rect.left)/rect.width,0,1),y=clamp((event.clientY-rect.top)/rect.height,0,1);updateRoi({x:Math.min(drag.x,x),y:Math.min(drag.y,y),w:Math.max(.01,Math.abs(x-drag.x)),h:Math.max(.01,Math.abs(y-drag.y))});});
for(const type of ['pointerup','pointercancel'])$('roi-overlay').addEventListener(type,()=>{drag=null;});
for(const key of ['x','y','w','h'])$(`roi-${key}`).addEventListener('input',()=>setRoiStyle($('roi-box'),getRoi()));
$('preset-dialog').addEventListener('close',()=>{$('roi-video').srcObject=null;drag=null;});

function bleFeedback(message,error=false) {$('ble-status').textContent=message;$('ble-status').className=`command-feedback ${error?'error':''}`;}
function onBleConnection(connected,name='') {
  setChip($('ble-chip'),connected?'蓝牙已连接':'未连接',connected?'good':'neutral');$('ble-connect').disabled=connected||!navigator.bluetooth||!window.isSecureContext;$('ble-disconnect').disabled=!connected;
  for(const id of ['ble-read','ble-center','ble-pause','wifi-submit'])$(id).disabled=!connected;
  if(connected)bleFeedback(`已连接 ${name}，正在读取设备信息。`);else{$('ble-token').value='';$('wifi-password').value='';$('wifi-ssid').value='';$('ble-info').replaceChildren();bleFeedback('蓝牙未连接。');}
}
function renderBleInfo(info) {
  const list=$('ble-info');list.replaceChildren();
  for(const [label,value] of [['设备',info.device_id||'设备未提供标识'],['固件版本',info.version||info.firmware_version||'未提供'],['配对窗口',info.pairing_window_open===true?'已开启，令牌仍由设备校验':'已关闭'],['网络',info.wifi_connected===true?'已连接 Wi-Fi':info.wifi_connected===false?'未连接 Wi-Fi':'未报告']])list.append(makeNode('dt','',label),makeNode('dd','',value));
}
async function bleOperation(op,args={}) {
  try {const data=await ble.send(op,args,$('ble-token').value);if(op==='info'){renderBleInfo(data);bleFeedback('设备信息已更新。');}else bleFeedback('设备已接受近场请求；实际动作结果仍需设备状态或现场确认。');return data;}catch(error){bleFeedback(errorMessage(error),true);return null;}
}
function download(content,name,type) {const blob=new Blob([content],{type});const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=name;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);}

// 事件绑定全部来自用户手势，不自动申请摄像头、麦克风、蓝牙或通知权限。
$('login-form').addEventListener('submit',async event=>{event.preventDefault();const submit=event.currentTarget.querySelector('button');submit.disabled=true;$('login-error').textContent='';try{await api.request('/api/session',{method:'POST',body:{password:$('password').value}});await startSession();}catch(error){$('login-error').textContent=errorMessage(error);}finally{submit.disabled=false;$('password').value='';}});
for(const id of ['logout-button','mobile-logout']) $(id).addEventListener('click',async()=>{try{await api.request('/api/session',{method:'DELETE'});await endSession();}catch(error){if(error.status!==401)toast('退出未被服务确认，请恢复网络后重试。');}});
document.querySelectorAll('[data-view]').forEach(node=>node.addEventListener('click',()=>showView(node.dataset.view)));
document.querySelectorAll('[data-go-view]').forEach(node=>node.addEventListener('click',()=>showView(node.dataset.goView)));
document.querySelectorAll('[data-nudge]').forEach(node=>node.addEventListener('click',()=>{const direction=node.dataset.nudge;let pan=Number(ui.state?.pan_deg??90),tilt=Number(ui.state?.tilt_deg??90);pan+=direction==='left'?-5:direction==='right'?5:0;tilt+=direction==='up'?5:direction==='down'?-5:0;command('move',{pan_deg:clamp(pan,ui.limits.pan_min,ui.limits.pan_max),tilt_deg:clamp(tilt,ui.limits.tilt_min,ui.limits.tilt_max)});}));
$('home-button').addEventListener('click',()=>command('move',{pan_deg:90,tilt_deg:90}));$('move-form').addEventListener('submit',event=>{event.preventDefault();command('move',{pan_deg:Number($('pan-input').value),tilt_deg:Number($('tilt-input').value)});});
$('patrol-button').addEventListener('click',()=>command('mode',{mode:'patrol'}));$('pause-button').addEventListener('click',()=>command('mode',{mode:'paused'}));$('capture-button').addEventListener('click',()=>command('capture'));
$('video-start').addEventListener('click',startVideo);$('video-stop').addEventListener('click',()=>video.stop());
$('add-point').addEventListener('click',()=>openPreset());$('close-preset').addEventListener('click',()=>$('preset-dialog').close());$('preset-form').addEventListener('submit',savePreset);$('delete-preset').addEventListener('click',deletePreset);$('roi-reset').addEventListener('click',()=>updateRoi({x:.25,y:.25,w:.5,h:.5}));
$('event-filter').addEventListener('change',renderEvents);$('refresh-events').addEventListener('click',async()=>{try{const result=await api.request('/api/events?limit=500');ui.events=result.events||[];renderEvents();toast('记录已更新。');}catch(error){toast(errorMessage(error));}});
$('export-button').addEventListener('click',()=>{const selected=$('event-filter').value,events=ui.events.filter(event=>!selected||event.preset_id===selected);if(!events.length){toast('没有可导出的记录。');return;}const tag=events.every(event=>event.source==='simulator')?'SIMULATOR':events.some(event=>event.source==='simulator')?'MIXED-SOURCES':'DEVICE-REPORTED';download(toCsv(events,{currentPresetRevision:ui.state?.presets_revision}),`巡点-${tag}-${new Date().toISOString().slice(0,10)}.csv`,'text/csv;charset=utf-8');toast(`已导出 ${events.length} 条记录，来源与配置版本已保留。`);});
$('ble-connect').addEventListener('click',async()=>{try{await ble.connect();bleFeedback('蓝牙连接完成，设备信息已读取。');}catch(error){const message=error.name==='NotFoundError'?'未选择设备，连接已取消。':error.name==='SecurityError'?'浏览器或系统未允许蓝牙访问。':errorMessage(error);bleFeedback(message,true);}});
$('ble-disconnect').addEventListener('click',()=>ble.disconnect());$('ble-read').addEventListener('click',()=>bleOperation('info'));$('ble-center').addEventListener('click',()=>bleOperation('move',{pan_deg:90,tilt_deg:90}));$('ble-pause').addEventListener('click',()=>bleOperation('mode',{mode:'paused'}));
$('wifi-form').addEventListener('submit',async event=>{event.preventDefault();const ssid=$('wifi-ssid').value,password=$('wifi-password').value;const encoder=new TextEncoder();if(!ssid||encoder.encode(ssid).length>32||encoder.encode(password).length>64){bleFeedback('Wi-Fi 名称应为 1–32 字节，密码不超过 64 字节。',true);return;}$('wifi-submit').disabled=true;try{await bleOperation('wifi_config',{ssid,password});}finally{$('wifi-ssid').value='';$('wifi-password').value='';$('ble-token').value='';$('wifi-submit').disabled=!ble.rx;}});
window.addEventListener('online',()=>{renderConnection();if(ui.authenticated)refreshAll();});window.addEventListener('offline',renderConnection);
window.addEventListener('pagehide',()=>{video.stop(false);ble.disconnect();ui.socket?.stop();});
window.addEventListener('pageshow',event=>{if(event.persisted&&ui.authenticated){ui.socket?.start();refreshAll();}});

const supported=!!navigator.bluetooth&&window.isSecureContext;
$('ble-support').textContent=supported?'此浏览器提供蓝牙接口。点击后选择设备；连接、加密配对及实际控制仍需实机验证。':!window.isSecureContext?'蓝牙需要 HTTPS 或本机 localhost 安全环境。请使用安全地址打开。':'此浏览器没有 Web Bluetooth。请改用 Android Chrome，或带蓝牙的 Windows Chrome / Edge。';$('ble-connect').disabled=!supported;
function tick(){ $('clock').textContent=new Intl.DateTimeFormat('zh-CN',{month:'2-digit',day:'2-digit',weekday:'short'}).format(new Date());}tick();setInterval(tick,60000);
api.request('/api/session').then(result=>{if(result.authenticated)startSession();}).catch(()=>{$('login-error').textContent='暂时无法连接服务，请确认服务已启动。';});
if('serviceWorker' in navigator&&window.isSecureContext) navigator.serviceWorker.register('/sw.js').catch(()=>{});
