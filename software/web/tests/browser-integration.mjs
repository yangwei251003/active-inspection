import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {createApp} from '../../server/src/app.js';
import {connectSimulator} from '../../server/src/simulator.js';
import {hashPassword, token} from '../../server/src/security.js';

// 独立的本机服务和无头浏览器；不连接用户现有浏览器，也不把模拟器当作硬件。
const require = createRequire(import.meta.url);
const playwright = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');
const here = path.dirname(fileURLToPath(import.meta.url));
const artifacts = path.join(here, 'artifacts');
await fs.mkdir(artifacts, {recursive:true});
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'inspection-web-test-'));
const password = token(), deviceToken = token();
const app = createApp({port:Number(process.env.WEB_TEST_PORT || 20949), source:'simulator', dataDir, passwordHash:hashPassword(password), deviceToken, sessionMs:120_000, commandTtlMs:800, heartbeatMs:100});
let browser, simulator, expiryApp;
const report = {started_at:new Date().toISOString(), source:'simulator', hardware_verified:false, checks:[], browser_errors:[], screenshots:[]};
try {
  const origin = await app.listen();
  simulator = connectSimulator({url:origin.replace('http:', 'ws:')+'/ws/device', deviceToken});
  browser = await playwright.chromium.launch({headless:true, channel:process.env.WEB_TEST_CHANNEL || 'chrome'});
  const context = await browser.newContext({viewport:{width:1440, height:1000}, locale:'zh-CN'});
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  page.on('pageerror', error=>report.browser_errors.push(error.message));
  await page.goto(origin, {waitUntil:'networkidle'});
  const fetchProbe = await page.evaluate(async()=>{
    const {ApiClient} = await import('/assets/api.js');
    try { return {ok:true, response:await new ApiClient().request('/api/session')}; }
    catch (error) { return {ok:false, name:error.name, message:error.message}; }
  });
  report.native_fetch_probe = fetchProbe;
  await page.screenshot({path:path.join(artifacts,'desktop-login.png'), fullPage:true});
  report.screenshots.push('desktop-login.png');
  if(process.argv.includes('--probe')) {
    report.initial_login_error = await page.locator('#login-error').textContent();
    console.log(JSON.stringify({probe:fetchProbe,initial_login_error:report.initial_login_error}));
  } else {
    assert.equal(fetchProbe.ok,true,JSON.stringify(fetchProbe));
    await page.locator('#password').fill('incorrect-test-only');
    await page.locator('#login-form button').click();
    await page.waitForFunction(()=>document.querySelector('#login-error').textContent.includes('口令不正确'));
    report.checks.push('错误口令提示正确，未进入工作台');
    await page.locator('#password').fill(password);
    await page.locator('#login-form button').click();
    await page.locator('#workspace').waitFor({state:'visible'});
    await page.waitForFunction(()=>document.querySelector('#connection-chip').textContent==='模拟器在线');
    report.checks.push('真实服务登录、原生 fetch 与浏览器 cookie 会话');
    await page.locator('[data-nudge="right"]').click();
    await page.waitForFunction(()=>document.querySelector('#pan-display').textContent==='95.0' && document.querySelector('#command-status').textContent.includes('执行完成'));
    assert.equal(simulator.state.pan_deg,95);
    report.checks.push('页面下发转向，经服务和模拟设备确认完成，状态回传95°');

    const other = await context.newPage();
    other.on('pageerror',error=>report.browser_errors.push(error.message));
    await other.goto(origin,{waitUntil:'networkidle'});
    await other.locator('#workspace').waitFor({state:'visible'});
    await page.locator('[data-view="points"]').click();
    await page.locator('.preset-card').first().getByRole('button',{name:'编辑',exact:true}).click();
    await page.locator('#preset-name').fill('测试台指示灯');
    await page.locator('#preset-pan').fill('70');
    await page.locator('#roi-x').fill('0.9');
    await page.locator('#roi-w').fill('0.3');
    await page.locator('#preset-form button[type="submit"]').click();
    await page.waitForFunction(()=>document.querySelector('#preset-error').textContent.includes('完整位于画面内'));
    await page.locator('#roi-x').fill('0.25');
    await page.locator('#preset-form button[type="submit"]').click();
    await page.locator('#preset-dialog').waitFor({state:'hidden'});
    await other.waitForFunction(()=>document.querySelector('.observation-card h3')?.textContent==='测试台指示灯');
    await page.waitForFunction(()=>!document.querySelector('#patrol-button').disabled);
    assert.equal(app.snapshot().presets_revision,app.snapshot().presets_applied_revision);
    report.checks.push('ROI越界拒绝、保存观察点、设备确认revision、第二浏览器即时同步名称');
    await page.locator('.preset-card').first().getByRole('button',{name:'转到观察点',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('#pan-display').textContent==='70.0');
    const otherRecheck=page.locator('.preset-card').nth(1).getByRole('button',{name:'复查当前点 ↗',exact:true});
    assert.equal(await otherRecheck.isDisabled(),true);
    await page.locator('.preset-card').first().getByRole('button',{name:'复查当前点 ↗',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('#command-status').textContent.includes('执行完成') && document.querySelector('#full-events').textContent.includes('复查结果'));
    await page.locator('[data-view="overview"]').click();
    const captureRequest=page.waitForResponse(response=>response.url().endsWith('/api/commands') && response.request().method()==='POST');
    await page.locator('#capture-button').click();
    const captureResponse=await captureRequest;
    assert.equal(captureResponse.status(),202);
    assert.deepEqual(captureResponse.request().postDataJSON().args,{});
    await page.waitForFunction(()=>document.querySelector('#command-status').textContent.includes('执行完成'));
    report.checks.push('复查仅开放当前观察点，recheck/capture无多余参数，服务接受并完成');
    await page.locator('#patrol-button').click();
    await page.waitForFunction(()=>document.querySelector('#mode-chip').textContent==='正在巡检');
    await page.locator('#pause-button').click();
    await page.waitForFunction(()=>document.querySelector('#mode-chip').textContent==='已暂停');
    report.checks.push('预置定位、开始巡检与暂停指令走真实控制链路');

    const eventId='web-jpeg-fixture';
    const jpeg=await fs.readFile(new URL('../../server/test/fixtures/synthetic-green.jpg',import.meta.url));
    const upload=await fetch(origin+'/api/device/evidence?event_id='+eventId,{method:'POST',headers:{Authorization:`Bearer ${deviceToken}`,'X-Device-Id':'inspection-01','Content-Type':'image/jpeg'},body:jpeg});
    assert.equal(upload.status,201);
    const {evidence}=await upload.json();
    simulator.send({type:'event',event:{event_id:eventId,kind:'observation',at:new Date().toISOString(),preset_id:'p1',state:'green',confidence:.9,evidence_url:evidence.evidence_url}});
    await page.locator('[data-view="events"]').click();
    await page.waitForFunction(()=>Array.from(document.querySelectorAll('#full-events img')).some(img=>img.complete && img.naturalWidth===16 && img.naturalHeight===12));
    assert.match(await page.locator('#full-events').textContent(),/模拟器数据/);
    const downloadPromise=page.waitForEvent('download');
    await page.locator('#export-button').click();
    const download=await downloadPromise;
    assert.match(download.suggestedFilename(),/SIMULATOR/);
    const csv=await fs.readFile(await download.path(),'utf8');
    assert.match(csv,/simulator/);assert.match(csv,new RegExp(evidence.evidence_url));
    await page.screenshot({path:path.join(artifacts,'desktop-events.png'),fullPage:true});report.screenshots.push('desktop-events.png');
    report.checks.push('鉴权JPEG上传→WebSocket事件→浏览器实际解码图片；导出CSV保留模拟来源');

    await page.locator('[data-view="overview"]').click();
    assert.equal(await page.locator('#video-start').isDisabled(),true);
    assert.equal(await page.locator('#live-video').evaluate(video=>video.srcObject),null);
    const whepFetchWorks=await page.evaluate(async()=>{const {WhepPlayer}=await import('/assets/whep.js');const player=new WhepPlayer({video:document.querySelector('#live-video')});return (await player.fetchFn('/api/session')).status;});
    assert.equal(whepFetchWorks,200);
    report.checks.push('WHEP原生fetch调用有效；没有媒体源时不播放占位假视频');
    await page.screenshot({path:path.join(artifacts,'desktop-overview.png'), fullPage:true});
    report.screenshots.push('desktop-overview.png');

    await page.setViewportSize({width:390,height:844});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await page.screenshot({path:path.join(artifacts,'mobile-overview.png'),fullPage:true});report.screenshots.push('mobile-overview.png');
    for(const view of ['points','events','nearby']) {
      await page.locator(`[data-view="${view}"]`).click();
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,view+' horizontal overflow');
      await page.screenshot({path:path.join(artifacts,`mobile-${view}.png`),fullPage:true});report.screenshots.push(`mobile-${view}.png`);
    }
    report.checks.push('390px手机四页面无水平溢出；蓝牙能力说明与真实未连接状态');

    await page.locator('[data-view="overview"]').click();
    simulator.terminate();
    await page.waitForFunction(()=>document.querySelector('#connection-chip').textContent==='设备离线');
    assert.equal(await page.locator('[data-nudge="right"]').isDisabled(),true);
    simulator=connectSimulator({url:origin.replace('http:','ws:')+'/ws/device',deviceToken,autoAck:false});
    await page.waitForFunction(()=>document.querySelector('#connection-chip').textContent==='模拟器在线');
    await page.locator('[data-nudge="right"]').click();
    await page.waitForFunction(()=>document.querySelector('#command-status').textContent.includes('指令已过期'));
    report.checks.push('设备掉线禁用转向，重连后未确认的指令显示过期');
    await page.locator('#mobile-logout').click();
    await page.locator('#login-screen').waitFor({state:'visible'});
    await other.locator('#login-screen').waitFor({state:'visible'});
    assert.equal(await page.locator('#password').inputValue(),'');
    await page.reload({waitUntil:'networkidle'});
    assert.equal(await page.locator('#workspace').isVisible(),false);
    report.checks.push('手机可见退出入口；服务撤销同会话的另一页面，刷新后保持未登录');
    await context.close();

    expiryApp=createApp({port:0,source:'simulator',dataDir:path.join(dataDir,'expiry'),passwordHash:hashPassword(password),deviceToken,sessionMs:1500,heartbeatMs:100});
    const expiryOrigin=await expiryApp.listen();
    const expiryContext=await browser.newContext({viewport:{width:390,height:844},locale:'zh-CN'});
    const expiryPage=await expiryContext.newPage();expiryPage.on('pageerror',error=>report.browser_errors.push(error.message));
    await expiryPage.goto(expiryOrigin,{waitUntil:'networkidle'});
    await expiryPage.locator('#password').fill(password);await expiryPage.locator('#login-form button').click();
    await expiryPage.locator('#workspace').waitFor({state:'visible'});
    await expiryPage.locator('#login-screen').waitFor({state:'visible',timeout:7000});
    assert.match(await expiryPage.locator('#login-error').textContent(),/会话已过期/);
    await expiryPage.screenshot({path:path.join(artifacts,'mobile-session-expired.png'),fullPage:true});report.screenshots.push('mobile-session-expired.png');
    report.checks.push('服务端真实会话超时通过WS撤销，立即返回登录页');
    await expiryContext.close();
    assert.deepEqual(report.browser_errors,[]);
  }
  report.status = 'PASS';
} catch(error) {
  report.status = 'FAIL'; report.error = error.message; throw error;
} finally {
  report.finished_at=new Date().toISOString();
  await fs.writeFile(path.join(artifacts,process.argv.includes('--probe')?'browser-reproduction.json':'browser-integration.json'),JSON.stringify(report,null,2)+'\n');
  await browser?.close(); simulator?.terminate(); await expiryApp?.close(); await app.close();
  // dataDir is the exact directory returned by mkdtemp, never a user path.
  await fs.rm(dataDir,{recursive:true,force:true});
}
