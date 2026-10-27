// 用原项目页面和 WhepPlayer 读取真实 MediaMTX 视频；只观察 RTCPeerConnection，不替换协议。
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { connectSimulator } from '../src/simulator.js';

const require = createRequire(import.meta.url);
const playwright = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');
const root = fileURLToPath(new URL('../', import.meta.url));
const access = JSON.parse(await fs.readFile(path.join(process.argv[2], 'access.local.json'), 'utf8'));
const artifactDir = path.join(root, 'artifacts');
const reportFile = path.join(artifactDir, 'browser-real-media-result.json');
const report = { passed: false, source: 'synthetic_local_media', browser: 'Chrome headless', camera_hardware_tested: false, public_network_tested: false, browser_errors: [], started_at_utc: new Date().toISOString() };
await fs.writeFile(reportFile, JSON.stringify(report, null, 2));
let browser, simulator;
try {
  // 状态仍标 simulator；真正的 H264 发布进程由 Python 父脚本保持运行。
  simulator = connectSimulator({ url: access.origin.replace('http:', 'ws:') + '/ws/device', deviceToken: access.deviceToken });
  simulator.state.video.available = true;
  browser = await playwright.chromium.launch({ headless: true, channel: process.env.WEB_TEST_CHANNEL || 'chrome' });
  report.browser_version = browser.version();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN' });
  page.setDefaultTimeout(25_000);
  page.on('pageerror', error => report.browser_errors.push(error.message));
  await page.addInitScript(() => {
    const NativePeerConnection = window.RTCPeerConnection;
    window.__mediaTestPeers = [];
    window.RTCPeerConnection = class ObservedPeerConnection extends NativePeerConnection {
      constructor(...args) { super(...args); window.__mediaTestPeers.push(this); }
    };
  });
  await page.goto(access.origin, { waitUntil: 'networkidle' });
  await page.locator('#password').fill(access.password);
  await page.locator('#login-form button').click();
  await page.locator('#workspace').waitFor({ state: 'visible' });
  await page.waitForFunction(() => !document.querySelector('#video-start').disabled);
  await page.locator('#video-start').click();
  await page.waitForFunction(() => { const v = document.querySelector('#live-video'); return v.videoWidth === 320 && v.videoHeight === 240 && v.readyState >= 2; });
  const sample = () => page.evaluate(async () => {
    const pc = window.__mediaTestPeers.at(-1), report = await pc.getStats();
    const track = [...report.values()].find(item => item.type === 'inbound-rtp' && item.kind === 'video');
    const codec = report.get(track?.codecId);
    const video = document.querySelector('#live-video');
    return { videoWidth: video.videoWidth, videoHeight: video.videoHeight, currentTime: video.currentTime, framesDecoded: track?.framesDecoded ?? 0, bytesReceived: track?.bytesReceived ?? 0, codec: codec?.mimeType ?? '', connectionState: pc.connectionState };
  });
  report.first_sample = await sample();
  await page.waitForTimeout(1500);
  report.second_sample = await sample();
  assert(report.second_sample.framesDecoded > report.first_sample.framesDecoded && report.second_sample.framesDecoded >= 10);
  assert(report.second_sample.bytesReceived > report.first_sample.bytesReceived);
  assert(report.second_sample.currentTime > report.first_sample.currentTime);
  assert.equal(report.second_sample.codec.toLowerCase(), 'video/h264');
  assert.equal(report.second_sample.connectionState, 'connected');
  await page.screenshot({ path: path.join(artifactDir, 'browser-real-media-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(artifactDir, 'browser-real-media-mobile-layout.png'), fullPage: true });
  report.mobile_is_viewport_emulation_only = true;
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator('#video-stop').click();
  await page.waitForFunction(() => document.querySelector('#live-video').srcObject === null && window.__mediaTestPeers.at(-1).connectionState === 'closed');
  report.stop_releases_connection = true;
  await page.locator('#video-start').click();
  await page.waitForFunction(() => { const v = document.querySelector('#live-video'); return v.videoWidth === 320 && v.readyState >= 2 && window.__mediaTestPeers.at(-1).connectionState === 'connected'; });
  report.reconnect_sample = await sample();
  assert.equal(report.reconnect_sample.codec.toLowerCase(), 'video/h264');
  await page.locator('#logout-button').click();
  await page.locator('#login-screen').waitFor({ state: 'visible' });
  assert.equal(await page.evaluate(() => document.querySelector('#live-video').srcObject), null);
  report.logout_releases_video = true;
  assert.deepEqual(report.browser_errors, []);
  report.passed = true;
} catch (error) { report.error = error.message; throw error; }
finally {
  report.finished_at_utc = new Date().toISOString();
  await fs.writeFile(reportFile, JSON.stringify(report, null, 2) + '\n');
  if (browser) await browser.close();
  simulator?.terminate();
}
console.log(JSON.stringify({ passed: report.passed, decoded_frames: report.second_sample.framesDecoded, browser: report.browser_version, source: report.source }));
