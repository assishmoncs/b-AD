const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const readJson = name => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));

function worker(seed = {}) {
  const storage = { ...seed };
  const enabled = new Set(['ad_block_rules', 'tracking_param_rules']);
  let dynamicRules = [];
  let rejectNextDnrUpdate = false;
  let onMessage;
  let onInstalled;
  const chrome = {
    runtime: {
      id: 'test-extension',
      lastError: null,
      onMessage: { addListener(fn) { onMessage = fn; } },
      onInstalled: { addListener(fn) { onInstalled = fn; } },
      onStartup: { addListener() {} }
    },
    storage: {
      local: {
        get(defaults, callback) { callback({ ...defaults, ...storage }); },
        set(value, callback) { Object.assign(storage, value); callback(); }
      },
      session: {
        get(defaults, callback) { callback(defaults); },
        set() {}, remove() {}, async clear() {}
      }
    },
    declarativeNetRequest: {
      async updateEnabledRulesets({ enableRulesetIds, disableRulesetIds }) {
        if (rejectNextDnrUpdate) {
          rejectNextDnrUpdate = false;
          throw new Error('DNR update failed');
        }
        enableRulesetIds.forEach(id => enabled.add(id));
        disableRulesetIds.forEach(id => enabled.delete(id));
      },
      async getDynamicRules() { return dynamicRules; },
      async updateDynamicRules({ addRules }) { dynamicRules = addRules; }
    },
    contextMenus: {
      onClicked: { addListener() {} },
      removeAll(callback) { callback(); }, create(_item, callback) { callback(); }
    },
    commands: { onCommand: { addListener() {} } },
    tabs: {
      onUpdated: { addListener() {} }, onRemoved: { addListener() {} },
      query(_query, callback) { callback([]); },
      reload(_tabId, callback) { callback(); }
    },
    action: {
      setBadgeText(_options, callback) { callback(); },
      setBadgeBackgroundColor(_options, callback) { callback(); }
    }
  };
  const context = vm.createContext({
    chrome, URL, console, Promise,
    setTimeout: () => 0, clearTimeout: () => {}
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'background.js'), 'utf8'), context);
  const send = message => new Promise(resolve => {
    onMessage(message, { id: chrome.runtime.id }, resolve);
  });
  return {
    send, storage, enabled,
    install(reason) { return onInstalled({ reason }); },
    get dynamicRules() { return dynamicRules; },
    failNextDnrUpdate() { rejectNextDnrUpdate = true; }
  };
}

test('manifest and DNR resources are valid and have unique rule IDs', () => {
  const manifest = readJson('manifest.json');
  assert.equal(manifest.version, '6.0.0');
  assert.equal(manifest.declarative_net_request.rule_resources.length, 2);
  const rules = manifest.declarative_net_request.rule_resources.flatMap(resource => readJson(resource.path));
  assert.equal(rules.length, 110);
  assert.equal(new Set(rules.map(rule => rule.id)).size, rules.length);
  assert.equal(readJson('tracking_rules.json').length, 36);
  assert.ok(readJson('tracking_rules.json').every(rule => rule.action.type === 'redirect'));
  for (const resource of manifest.declarative_net_request.rule_resources) {
    assert.ok(fs.existsSync(path.join(root, resource.path)));
  }
});

test('v5 upgrade preserves valid configuration and resets inaccurate counts', async () => {
  const app = worker({
    version: '5.0.0', adsBlocked: 42,
    settings: { stealthMode: true, sponsorBlock: true, strictCosmetic: true },
    disabledSites: ['news.example', 'bad domain'],
    customDnrRules: [{ id: 100001, filter: '*://ads.example.com/*', enabled: true }]
  });
  await app.install('update');
  const stats = await app.send({ type: 'GET_STATS' });
  assert.equal(stats.version, '6.0.0');
  assert.equal(stats.adsBlocked, 0);
  assert.equal(stats.settings.stealthMode, true);
  assert.equal(stats.settings.sponsorBlock, true);
  assert.equal(stats.settings.strictCosmetic, undefined);
  assert.equal(stats.disabledSites.length, 1);
  assert.equal(stats.customDnrRules[0].filter, '||ads.example.com^');
});

test('global and tracking controls synchronize both static rulesets', async () => {
  const app = worker();
  assert.equal((await app.send({ type: 'UPDATE_SETTINGS', settings: { stripTrackingParams: false } })).ok, true);
  assert.deepEqual([...app.enabled], ['ad_block_rules']);
  assert.equal((await app.send({ type: 'TOGGLE_GLOBAL', value: true })).ok, true);
  assert.deepEqual([...app.enabled], []);
  assert.equal((await app.send({ type: 'TOGGLE_GLOBAL', value: false })).ok, true);
  assert.deepEqual([...app.enabled], ['ad_block_rules']);
});

test('paused sites create allow rules and invalid domains are rejected', async () => {
  const app = worker();
  assert.equal((await app.send({ type: 'ADD_SITE', host: 'news.example' })).ok, true);
  assert.equal((await app.send({ type: 'ADD_SITE', host: 'news.example' })).ok, true);
  assert.equal(app.dynamicRules.filter(rule => rule.action.type.startsWith('allow')).length, 2);
  assert.equal((await app.send({ type: 'ADD_SITE', host: 'bad domain' })).ok, false);
  assert.equal((await app.send({ type: 'ADD_SITE', host: 'https://evil@news.example' })).ok, false);
  assert.equal((await app.send({ type: 'GET_STATS' })).disabledSites.length, 1);
});

test('failed DNR changes roll back user settings', async () => {
  const app = worker();
  await app.send({ type: 'GET_STATS' });
  app.failNextDnrUpdate();
  const result = await app.send({ type: 'TOGGLE_GLOBAL', value: true });
  assert.equal(result.ok, false);
  assert.equal((await app.send({ type: 'GET_STATS' })).globallyDisabled, false);
  assert.equal(app.storage.globallyDisabled, undefined);
  assert.ok(app.enabled.has('ad_block_rules'));
});

test('custom network rules accept domain filters only', async () => {
  const app = worker();
  assert.equal((await app.send({ type: 'ADD_DYNAMIC_RULE', filter: '*://example.com/*' })).ok, false);
  assert.equal((await app.send({ type: 'ADD_DYNAMIC_RULE', filter: '||ads.example.com^' })).ok, true);
  assert.equal(app.dynamicRules.filter(rule => rule.action.type === 'block').length, 1);
});

test('page action counters do not count sponsor and consent events as ads', async () => {
  const app = worker();
  await app.send({ type: 'BAD_BLOCKED', kind: 'sponsor', url: 'youtube.com', durationSec: 23 });
  await app.send({ type: 'BAD_BLOCKED_BATCH', items: [
    { kind: 'cookie', url: 'news.example', count: 2 },
    { kind: 'ad', url: 'news.example', count: 3 }
  ] });
  const stats = await app.send({ type: 'GET_STATS' });
  assert.equal(stats.sponsorsSkipped, 1);
  assert.equal(stats.cookiesCleaned, 2);
  assert.equal(stats.adsBlocked, 3);
  assert.equal(stats.timeSavedSec, 23);
  assert.equal(app.storage.adsBlocked, 3);
});
