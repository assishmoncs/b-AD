import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const chromePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
if (!fs.existsSync(chromePath)) throw new Error(`Chrome not found: ${chromePath}`);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'bad-v6-smoke-'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const chrome = spawn(chromePath, [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-gpu-sandbox',
  '--disable-gpu-compositing', '--use-gl=swiftshader',
  '--disable-features=Vulkan,SkiaGraphite', '--no-first-run',
  '--no-default-browser-check', '--disable-background-networking',
  '--enable-unsafe-extension-debugging', '--remote-debugging-pipe',
  `--user-data-dir=${profile}`, 'about:blank'
], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });

let errors = '';
chrome.stderr.on('data', chunk => { errors += chunk.toString(); });
let nextId = 0;
let received = '';
const pending = new Map();
const exceptions = [];
chrome.stdio[4].on('data', chunk => {
  received += chunk.toString();
  let end;
  while ((end = received.indexOf('\0')) !== -1) {
    const frame = received.slice(0, end);
    received = received.slice(end + 1);
    if (!frame) continue;
    const message = JSON.parse(frame);
    if (message.method === 'Runtime.exceptionThrown') {
      exceptions.push(message.params?.exceptionDetails?.exception?.description || 'Uncaught browser exception');
    }
    if (!message.id || !pending.has(message.id)) continue;
    const { resolve, reject, timeout } = pending.get(message.id);
    clearTimeout(timeout);
    pending.delete(message.id);
    message.error ? reject(new Error(message.error.message)) : resolve(message.result);
  }
});

function send(method, params = {}, sessionId) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP timeout: ${method}. ${errors.slice(-1000)}`));
    }, 30000);
    pending.set(id, { resolve, reject, timeout });
    chrome.stdio[3].write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
  });
}

async function evaluate(sessionId, expression) {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result.value;
}

try {
  await sleep(1000);
  const browserVersion = await send('Browser.getVersion');
  console.log('Chrome:', browserVersion.product);
  const loaded = await send('Extensions.loadUnpacked', { path: root });
  const extensionId = loaded.id;
  assert.ok(extensionId, 'Chrome did not return an extension ID');
  const popupUrl = `chrome-extension://${extensionId}/popup.html`;
  const { targetId } = await send('Target.createTarget', { url: popupUrl });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Runtime.enable', {}, sessionId);
  await sleep(500);

  const manifest = await evaluate(sessionId, 'chrome.runtime.getManifest()');
  assert.equal(manifest.version, '6.0.0');
  const initial = await evaluate(sessionId, 'chrome.declarativeNetRequest.getEnabledRulesets()');
  assert.ok(initial.includes('ad_block_rules'));
  assert.ok(initial.includes('tracking_param_rules'));
  const ui = await evaluate(sessionId, `({title:document.title, settings:[...document.querySelectorAll('[data-setting]')].map(el=>el.dataset.setting), notice:document.querySelector('#popupNotice')?.textContent})`);
  assert.equal(ui.title, 'b-AD Ultra 6.0');
  assert.ok(ui.settings.includes('stripTrackingParams'));
  assert.equal(ui.notice, '');

  const before = await evaluate(sessionId, 'chrome.runtime.sendMessage({type:"GET_STATS"})');
  assert.equal(before.version, '6.0.0');
  assert.equal(before.settings.sponsorBlock, false);
  assert.equal(before.settings.stealthMode, false);
  assert.equal(before.settings.cookieCleaner, false);
  const disabled = await evaluate(sessionId, 'chrome.runtime.sendMessage({type:"UPDATE_SETTINGS",settings:{stripTrackingParams:false}})');
  assert.equal(disabled.ok, true);
  const after = await evaluate(sessionId, 'chrome.declarativeNetRequest.getEnabledRulesets()');
  assert.ok(!after.includes('tracking_param_rules'));
  const enabled = await evaluate(sessionId, 'chrome.runtime.sendMessage({type:"UPDATE_SETTINGS",settings:{stripTrackingParams:true}})');
  assert.equal(enabled.ok, true);

  const ordinaryUrl = await evaluate(sessionId, 'chrome.declarativeNetRequest.testMatchOutcome({url:"https://example.com/article",type:"main_frame"})');
  assert.ok(!ordinaryUrl.matchedRules.some(rule => rule.ruleId >= 75));
  const trackingUrl = await evaluate(sessionId, 'chrome.declarativeNetRequest.testMatchOutcome({url:"https://example.com/article?utm_source=news",type:"main_frame"})');
  assert.ok(trackingUrl.matchedRules.some(rule => rule.ruleId >= 75));

  const optionsUrl = `chrome-extension://${extensionId}/options.html`;
  const optionsTarget = await send('Target.createTarget', { url: optionsUrl });
  const optionsSession = (await send('Target.attachToTarget', { targetId: optionsTarget.targetId, flatten: true })).sessionId;
  await send('Runtime.enable', {}, optionsSession);
  await sleep(350);
  const optionsUi = await evaluate(optionsSession, `({title:document.title, ruleCount:document.querySelector('#staticRulesCount')?.textContent, trackingControl:!!document.querySelector('[data-opt-setting="stripTrackingParams"]')})`);
  assert.equal(optionsUi.title, 'b-AD Ultra 6.0 — Settings');
  assert.equal(optionsUi.ruleCount, '110');
  assert.equal(optionsUi.trackingControl, true);

  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end('<!doctype html><html><body><div class="ad-banner" id="fixture-ad">Ad fixture</div></body></html>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const fixtureUrl = `http://127.0.0.1:${server.address().port}/`;
    const queryTarget = await send('Target.createTarget', { url: `${fixtureUrl}?utm_source=smoke&keep=yes` });
    const querySession = (await send('Target.attachToTarget', { targetId: queryTarget.targetId, flatten: true })).sessionId;
    await sleep(400);
    assert.equal(await evaluate(querySession, 'location.search'), '?keep=yes');
    const fixtureTarget = await send('Target.createTarget', { url: fixtureUrl });
    const fixtureSession = (await send('Target.attachToTarget', { targetId: fixtureTarget.targetId, flatten: true })).sessionId;
    await send('Runtime.enable', {}, fixtureSession);
    await sleep(700);
    assert.equal(await evaluate(fixtureSession, 'getComputedStyle(document.querySelector("#fixture-ad")).display'), 'none');
    const paused = await evaluate(sessionId, 'chrome.runtime.sendMessage({type:"ADD_SITE",host:"127.0.0.1"})');
    assert.equal(paused.ok, true);
    await sleep(300);
    assert.notEqual(await evaluate(fixtureSession, 'getComputedStyle(document.querySelector("#fixture-ad")).display'), 'none');
    const allowedRequest = await evaluate(sessionId, `chrome.declarativeNetRequest.testMatchOutcome({url:"https://googleads.g.doubleclick.net/pagead/script.js",initiator:${JSON.stringify(fixtureUrl)},type:"script"})`);
    assert.ok(allowedRequest.matchedRules.some(rule => rule.ruleId >= 900001));
    const pausedTarget = await send('Target.createTarget', { url: fixtureUrl });
    const pausedSession = (await send('Target.attachToTarget', { targetId: pausedTarget.targetId, flatten: true })).sessionId;
    await sleep(600);
    assert.notEqual(await evaluate(pausedSession, 'getComputedStyle(document.querySelector("#fixture-ad")).display'), 'none');
    const resumed = await evaluate(sessionId, 'chrome.runtime.sendMessage({type:"TOGGLE_SITE",host:"127.0.0.1"})');
    assert.equal(resumed.ok, true);
    await sleep(300);
    assert.equal(await evaluate(fixtureSession, 'getComputedStyle(document.querySelector("#fixture-ad")).display'), 'none');
    assert.equal(await evaluate(pausedSession, 'getComputedStyle(document.querySelector("#fixture-ad")).display'), 'none');
  } finally {
    server.close();
  }

  if (process.env.BAD_SCREENSHOT_DIR) {
    fs.mkdirSync(process.env.BAD_SCREENSHOT_DIR, { recursive: true });
    await send('Emulation.setDeviceMetricsOverride', { width: 385, height: 650, deviceScaleFactor: 1, mobile: false }, sessionId);
    const screenshot = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
    fs.writeFileSync(path.join(process.env.BAD_SCREENSHOT_DIR, 'popup.png'), Buffer.from(screenshot.data, 'base64'));
    await send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 800, deviceScaleFactor: 1, mobile: false }, optionsSession);
    const optionsScreenshot = await send('Page.captureScreenshot', { format: 'png' }, optionsSession);
    fs.writeFileSync(path.join(process.env.BAD_SCREENSHOT_DIR, 'options.png'), Buffer.from(optionsScreenshot.data, 'base64'));
    await send('Emulation.setDeviceMetricsOverride', { width: 500, height: 800, deviceScaleFactor: 1, mobile: false }, optionsSession);
    const mobileScreenshot = await send('Page.captureScreenshot', { format: 'png' }, optionsSession);
    fs.writeFileSync(path.join(process.env.BAD_SCREENSHOT_DIR, 'options-mobile.png'), Buffer.from(mobileScreenshot.data, 'base64'));
  }
  assert.deepEqual(exceptions, [], `Browser exceptions: ${exceptions.join('\n')}`);
  console.log('Chrome smoke test passed: UI, DNR controls, URL stripping, and cosmetic pause/resume work.');
} finally {
  if (chrome.exitCode === null) {
    const exited = new Promise(resolve => chrome.once('exit', resolve));
    chrome.kill();
    await Promise.race([exited, sleep(1500)]);
  }
  try {
    const tempRoot = fs.realpathSync(os.tmpdir());
    const resolvedProfile = fs.realpathSync(profile);
    if (resolvedProfile.startsWith(tempRoot + path.sep)) {
      fs.rmSync(resolvedProfile, { recursive: true, force: true });
    }
  } catch (_) {}
}
