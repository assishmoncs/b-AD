/**
 * b-AD Ultra v5.0 Enterprise — Background Service Worker
 * ---------------------------------------------------------------------------
 * Architecture Highlights:
 * 1. Atomic In-Memory State Cache + Debounced Storage Flush Queue (eliminates
 *    concurrent read-modify-write race conditions under heavy network loads).
 * 2. True Declarative Net Request (DNR) Synchronization:
 *    - Global Pause toggles static ruleset "ad_block_rules" & dynamic rules.
 *    - Site Whitelisting injects high-priority (10000) allowAllRequests rules
 *      in reserved ID space [900001..999999] so paused domains truly bypass DNR.
 *    - User Dynamic Rules managed deterministically in ID space [100001..899999].
 * 3. Session-Persisted Per-Tab Counters (survives MV3 Service Worker sleep).
 * 4. Strict Message Sender Verification & Schema Validation for Config Imports.
 */

"use strict";

const VERSION = "5.0.0";
const STATIC_RULESET_ID = "ad_block_rules";
const USER_DNR_MIN_ID = 100001;
const ALLOW_DNR_BASE_ID = 900001;

const AVG_BYTES_AD = 102400;      // ~100 KB per blocked ad payload
const AVG_BYTES_TRACKER = 22528;  // ~22 KB per blocked tracker script/beacon
const AVG_BYTES_SPONSOR = 524288; // ~512 KB per skipped video/sponsor segment

const AD_DOMAIN_SET = new Set([
  "doubleclick.net", "googlesyndication.com", "adservice.google.com",
  "googleadservices.com", "ads.twitter.com", "amazon-adsystem.com",
  "adnxs.com", "outbrain.com", "taboola.com", "rubiconproject.com",
  "pubmatic.com", "openx.net", "criteo.com", "criteo.net", "casalemedia.com",
  "indexww.com", "media.net", "advertising.com", "ads.linkedin.com",
  "adsrvr.org", "smartadserver.com", "ads.yahoo.com", "mopub.com",
  "yieldmo.com", "33across.com", "gumgum.com", "teads.tv", "sharethrough.com",
  "lijit.com", "3lift.com", "revcontent.com", "mgid.com", "adform.net",
  "bidswitch.net", "flashtalking.com", "serving-sys.com", "popads.net",
  "popcash.net", "propellerads.com", "exoclick.com", "juicyads.com",
  "adcash.com", "adroll.com", "yieldmanager.com", "buysellads.com",
  "monetizer101.com", "coin-hive.com", "coinhive.com"
]);

const TRACKER_DOMAIN_SET = new Set([
  "google-analytics.com", "googletagmanager.com", "connect.facebook.net",
  "analytics.tiktok.com", "ads.tiktok.com", "hotjar.com", "mouseflow.com",
  "fullstory.com", "mixpanel.com", "segment.io", "segment.com",
  "amplitude.com", "heap.io", "intercom.io", "bat.bing.com", "sc-static.net",
  "tr.snapchat.com", "analytics.twitter.com", "static.ads-twitter.com",
  "crazyegg.com", "luckyorange.com", "pardot.com", "marketo.com",
  "marketo.net", "hubspot.com", "clarity.ms", "mc.yandex.ru",
  "scorecardresearch.com", "quantserve.com", "sentry.io", "bugsnag.com"
]);

const ALL_RESOURCE_TYPES = [
  "main_frame", "sub_frame", "stylesheet", "script", "image", "font",
  "object", "xmlhttprequest", "ping", "csp_report", "media", "websocket", "other"
];

function getDefaultSettings() {
  return {
    stealthMode: true,
    cookieCleaner: true,
    youtubeEngine: true,
    sponsorBlock: true,
    stripTrackingParams: true,
    strictCosmetic: true
  };
}

function getInitialState() {
  return {
    version: VERSION,
    adsBlocked: 0,
    trackersBlocked: 0,
    sponsorsSkipped: 0,
    cookiesCleaned: 0,
    bandwidthSaved: 0,
    timeSavedSec: 0,
    domainCounts: {},
    siteModes: {},
    disabledSites: [],
    globallyDisabled: false,
    customSelectors: [],
    customDnrRules: [],
    recentEvents: [],
    settings: getDefaultSettings()
  };
}

/* ============================================================================
 * Atomic State & Debounced Storage Engine
 * ========================================================================== */
let stateCache = null;
let stateInitPromise = null;
let flushTimer = null;
const dirtyKeys = new Set();
const tabBlockCounts = new Map();

async function ensureStateLoaded() {
  if (stateCache) return stateCache;
  if (stateInitPromise) return stateInitPromise;

  stateInitPromise = new Promise(resolve => {
    try {
      chrome.storage.local.get(getInitialState(), data => {
        const defaults = getInitialState();
        stateCache = {
          ...defaults,
          ...data,
          settings: { ...defaults.settings, ...(data && data.settings ? data.settings : {}) },
          domainCounts: (data && typeof data.domainCounts === "object" && data.domainCounts) || {},
          siteModes: (data && typeof data.siteModes === "object" && data.siteModes) || {},
          disabledSites: Array.isArray(data && data.disabledSites) ? data.disabledSites : [],
          customSelectors: Array.isArray(data && data.customSelectors) ? data.customSelectors : [],
          customDnrRules: Array.isArray(data && data.customDnrRules) ? data.customDnrRules : [],
          recentEvents: Array.isArray(data && data.recentEvents) ? data.recentEvents.slice(0, 60) : []
        };
        resolve(stateCache);
      });
    } catch (_) {
      stateCache = getInitialState();
      resolve(stateCache);
    }
  });

  return stateInitPromise;
}

function scheduleStorageFlush(keys, immediate = false) {
  if (Array.isArray(keys)) {
    keys.forEach(k => dirtyKeys.add(k));
  }
  if (immediate) {
    return flushStorageNow();
  }
  if (!flushTimer) {
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flushStorageNow();
    }, 350);
  }
  return Promise.resolve();
}

function flushStorageNow() {
  return new Promise(resolve => {
    if (!stateCache || dirtyKeys.size === 0) return resolve();
    const payload = {};
    dirtyKeys.forEach(k => {
      if (k in stateCache) payload[k] = stateCache[k];
    });
    dirtyKeys.clear();
    try {
      chrome.storage.local.set(payload, () => {
        void chrome.runtime.lastError;
        resolve();
      });
    } catch (_) {
      resolve();
    }
  });
}

// Keep stateCache synchronized if options.js or another context writes directly to storage
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" || !stateCache) return;
  let whitelistChanged = false;
  let globalChanged = false;
  for (const [key, change] of Object.entries(changes)) {
    if (change && typeof change.newValue !== "undefined") {
      stateCache[key] = change.newValue;
      if (key === "disabledSites") whitelistChanged = true;
      if (key === "globallyDisabled") globalChanged = true;
    }
  }
  if (whitelistChanged || globalChanged) {
    syncDnrEngineState().catch(() => {});
  }
});

/* ============================================================================
 * Per-Tab Session Counter Persistence
 * ========================================================================== */
async function getTabCount(tabId) {
  if (!tabId || tabId < 0) return 0;
  if (tabBlockCounts.has(tabId)) return tabBlockCounts.get(tabId);
  if (chrome.storage && chrome.storage.session) {
    return new Promise(res => {
      const key = `tab_${tabId}`;
      chrome.storage.session.get({ [key]: 0 }, data => {
        const val = (data && data[key]) || 0;
        tabBlockCounts.set(tabId, val);
        res(val);
      });
    });
  }
  return 0;
}

function setTabCount(tabId, count) {
  if (!tabId || tabId < 0) return;
  tabBlockCounts.set(tabId, count);
  if (chrome.storage && chrome.storage.session) {
    try {
      chrome.storage.session.set({ [`tab_${tabId}`]: count });
    } catch (_) {}
  }
}

/* ============================================================================
 * Domain Normalization & Classification Utilities
 * ========================================================================== */
function normalizeHost(rawInput) {
  if (!rawInput || typeof rawInput !== "string") return "";
  const trimmed = rawInput.trim().toLowerCase();
  if (!trimmed) return "";
  try {
    const withProto = /^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(trimmed) ? trimmed : "https://" + trimmed;
    const u = new URL(withProto);
    return u.hostname.replace(/^www\./, "");
  } catch (_) {
    return trimmed.replace(/^www\./, "").split("/")[0].split(":")[0];
  }
}

function extractRootDomain(urlOrHost) {
  const host = normalizeHost(urlOrHost);
  if (!host) return "unknown";
  const parts = host.split(".");
  if (parts.length <= 2) return host;
  // Handle multi-part public suffixes like .co.uk, .com.au, .co.in, .org.uk
  const secondLast = parts[parts.length - 2];
  const last = parts[parts.length - 1];
  if (last.length === 2 && ["co", "com", "org", "net", "gov", "edu", "ac"].includes(secondLast) && parts.length >= 3) {
    return parts.slice(-3).join(".");
  }
  return parts.slice(-2).join(".");
}

function matchesDomainSet(urlOrHost, domainSet) {
  const host = normalizeHost(urlOrHost);
  if (!host) return false;
  if (domainSet.has(host)) return true;
  for (const d of domainSet) {
    if (host === d || host.endsWith("." + d)) return true;
  }
  return false;
}

function isSiteWhitelisted(host, disabledSites) {
  if (!host || !Array.isArray(disabledSites) || !disabledSites.length) return false;
  const clean = normalizeHost(host);
  return disabledSites.some(s => clean === s || clean.endsWith("." + s));
}

/* ============================================================================
 * Declarative Net Request (DNR) Synchronization Engine
 * ========================================================================== */
async function syncDnrEngineState() {
  const state = await ensureStateLoaded();
  if (!chrome.declarativeNetRequest) return;

  // 1. Toggle Static Ruleset based on globallyDisabled
  try {
    await chrome.declarativeNetRequest.updateEnabledRulesets({
      enableRulesetIds: state.globallyDisabled ? [] : [STATIC_RULESET_ID],
      disableRulesetIds: state.globallyDisabled ? [STATIC_RULESET_ID] : []
    });
  } catch (_) {}

  // 2. Rebuild Dynamic Rules (User Block Rules + Whitelist Allow Rules)
  try {
    const existingRules = await chrome.declarativeNetRequest.getDynamicRules();
    const removeRuleIds = existingRules.map(r => r.id);
    const addRules = [];

    if (!state.globallyDisabled) {
      // Whitelisted sites get priority 10000 allow rules so DNR skips blocking on them
      const cleanSites = (state.disabledSites || [])
        .map(s => normalizeHost(s))
        .filter(Boolean);

      if (cleanSites.length > 0) {
        addRules.push({
          id: ALLOW_DNR_BASE_ID,
          priority: 10000,
          action: { type: "allow" },
          condition: {
            initiatorDomains: cleanSites,
            resourceTypes: ALL_RESOURCE_TYPES
          }
        });
        addRules.push({
          id: ALLOW_DNR_BASE_ID + 1,
          priority: 10000,
          action: { type: "allowAllRequests" },
          condition: {
            requestDomains: cleanSites,
            resourceTypes: ["main_frame", "sub_frame"]
          }
        });
      }

      // User custom DNR block rules
      for (const item of state.customDnrRules || []) {
        if (!item || !item.id || !item.filter || item.enabled === false) continue;
        addRules.push({
          id: Number(item.id),
          priority: 100,
          action: { type: "block" },
          condition: {
            urlFilter: String(item.filter),
            resourceTypes: ["script", "image", "xmlhttprequest", "sub_frame", "media", "ping", "other"]
          }
        });
      }
    }

    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds,
      addRules
    });
  } catch (_) {}
}

/* ============================================================================
 * Badge & Action Icon Status Manager
 * ========================================================================== */
function updateTabBadge(tabId, count, isPaused) {
  if (!tabId || tabId < 0) return;
  try {
    if (isPaused) {
      chrome.action.setBadgeText({ tabId, text: "OFF" }, () => void chrome.runtime.lastError);
      chrome.action.setBadgeBackgroundColor({ tabId, color: "#f59e0b" }, () => void chrome.runtime.lastError);
    } else if (count > 0) {
      const label = count > 999 ? "999+" : String(count);
      chrome.action.setBadgeText({ tabId, text: label }, () => void chrome.runtime.lastError);
      chrome.action.setBadgeBackgroundColor({ tabId, color: "#ef4444" }, () => void chrome.runtime.lastError);
    } else {
      chrome.action.setBadgeText({ tabId, text: "ON" }, () => void chrome.runtime.lastError);
      chrome.action.setBadgeBackgroundColor({ tabId, color: "#10b981" }, () => void chrome.runtime.lastError);
    }
  } catch (_) {}
}

async function refreshTabBadgeState(tabId, url) {
  if (!tabId || tabId < 0) return;
  const state = await ensureStateLoaded();
  const host = url ? normalizeHost(url) : "";
  const isPaused = state.globallyDisabled || (host && isSiteWhitelisted(host, state.disabledSites));
  const count = await getTabCount(tabId);
  updateTabBadge(tabId, count, isPaused);
}

/* ============================================================================
 * Block & Telemetry Recording Engine
 * ========================================================================== */
async function recordBlockEvent({ url, kind = "ad", count = 1, tabId = null, initiator = "", durationSec = 0 }) {
  const state = await ensureStateLoaded();
  if (state.globallyDisabled) return;

  const targetDomain = extractRootDomain(url);
  const initiatorHost = normalizeHost(initiator);

  if (
    isSiteWhitelisted(targetDomain, state.disabledSites) ||
    (initiatorHost && isSiteWhitelisted(initiatorHost, state.disabledSites))
  ) {
    return;
  }

  const safeCount = Math.max(1, Math.min(Number(count) || 1, 250));
  const isSponsor = kind === "sponsor";
  const isCookie = kind === "cookie";
  const isTracker = !isSponsor && !isCookie && (kind === "tracker" || matchesDomainSet(url, TRACKER_DOMAIN_SET));
  const isAd = !isSponsor && !isCookie && !isTracker && (kind === "ad" || matchesDomainSet(url, AD_DOMAIN_SET));

  if (!isAd && !isTracker && !isSponsor && !isCookie) return;

  if (isAd) {
    state.adsBlocked = (state.adsBlocked || 0) + safeCount;
    state.bandwidthSaved = (state.bandwidthSaved || 0) + safeCount * AVG_BYTES_AD;
    state.timeSavedSec = (state.timeSavedSec || 0) + safeCount * 0.18;
  } else if (isTracker) {
    state.trackersBlocked = (state.trackersBlocked || 0) + safeCount;
    state.bandwidthSaved = (state.bandwidthSaved || 0) + safeCount * AVG_BYTES_TRACKER;
    state.timeSavedSec = (state.timeSavedSec || 0) + safeCount * 0.08;
  } else if (isSponsor) {
    state.sponsorsSkipped = (state.sponsorsSkipped || 0) + safeCount;
    state.adsBlocked = (state.adsBlocked || 0) + safeCount;
    state.bandwidthSaved = (state.bandwidthSaved || 0) + safeCount * AVG_BYTES_SPONSOR;
    state.timeSavedSec = (state.timeSavedSec || 0) + (durationSec > 0 ? durationSec : safeCount * 15);
  } else if (isCookie) {
    state.cookiesCleaned = (state.cookiesCleaned || 0) + safeCount;
    state.adsBlocked = (state.adsBlocked || 0) + safeCount;
    state.timeSavedSec = (state.timeSavedSec || 0) + safeCount * 1.5;
  }

  if (targetDomain && targetDomain !== "unknown") {
    state.domainCounts[targetDomain] = (state.domainCounts[targetDomain] || 0) + safeCount;
  }

  // Record bounded recent telemetry event log (latest 50 items)
  const now = Date.now();
  state.recentEvents = state.recentEvents || [];
  state.recentEvents.unshift({
    ts: now,
    domain: targetDomain || "unknown",
    kind: isSponsor ? "sponsor" : isCookie ? "cookie" : isTracker ? "tracker" : "ad",
    count: safeCount
  });
  if (state.recentEvents.length > 50) {
    state.recentEvents.length = 50;
  }

  scheduleStorageFlush([
    "adsBlocked",
    "trackersBlocked",
    "sponsorsSkipped",
    "cookiesCleaned",
    "bandwidthSaved",
    "timeSavedSec",
    "domainCounts",
    "recentEvents"
  ]);

  if (tabId && tabId > 0) {
    const prev = await getTabCount(tabId);
    const next = prev + safeCount;
    setTabCount(tabId, next);
    updateTabBadge(tabId, next, false);
  }
}

// Listen for DNR rule matches when available
if (chrome.declarativeNetRequest && chrome.declarativeNetRequest.onRuleMatchedDebug) {
  chrome.declarativeNetRequest.onRuleMatchedDebug.addListener(({ request, rule }) => {
    if (rule && rule.ruleId >= ALLOW_DNR_BASE_ID) return; // Ignore allow rules
    const kind = matchesDomainSet(request.url, TRACKER_DOMAIN_SET) ? "tracker" : "ad";
    recordBlockEvent({
      url: request.url,
      kind,
      count: 1,
      tabId: request.tabId,
      initiator: request.initiator || ""
    });
  });
}

/* ============================================================================
 * Validation & Sanitization Helpers
 * ========================================================================== */
function isValidCssSelector(selector) {
  if (typeof selector !== "string") return false;
  const trimmed = selector.trim();
  if (!trimmed || trimmed.length > 512) return false;
  // Block CSS injection tokens
  if (/[{};]|@import|url\s*\(|expression\s*\(/i.test(trimmed)) return false;
  return true;
}

function isValidDnrFilter(filter) {
  if (typeof filter !== "string") return false;
  const trimmed = filter.trim();
  if (!trimmed || trimmed.length > 512) return false;
  // DNR urlFilter must contain only ASCII characters and no whitespace
  if (/[^\x21-\x7E]/.test(trimmed)) return false;
  return true;
}

function allocateNextDnrId(existingRules) {
  let maxId = USER_DNR_MIN_ID;
  for (const r of existingRules || []) {
    if (r && typeof r.id === "number" && r.id >= USER_DNR_MIN_ID && r.id < ALLOW_DNR_BASE_ID) {
      if (r.id >= maxId) maxId = r.id + 1;
    }
  }
  return maxId;
}

/* ============================================================================
 * Context Menus & Keyboard Shortcuts
 * ========================================================================== */
function createContextMenus() {
  if (!chrome.contextMenus) return;
  chrome.contextMenus.removeAll(() => {
    void chrome.runtime.lastError;
    chrome.contextMenus.create({
      id: "BAD_ZAP_ELEMENT",
      title: "⚡ Zap Element on Page (b-AD v5.0)",
      contexts: ["page", "selection", "image", "video", "frame"]
    }, () => void chrome.runtime.lastError);

    chrome.contextMenus.create({
      id: "BAD_TOGGLE_SITE",
      title: "⏸ Pause / Resume b-AD on this Site",
      contexts: ["page"]
    }, () => void chrome.runtime.lastError);

    chrome.contextMenus.create({
      id: "BAD_OPEN_OPTIONS",
      title: "⚙ Open b-AD Enterprise Control Center",
      contexts: ["page"]
    }, () => void chrome.runtime.lastError);
  });
}

async function toggleSiteWhitelist(rawHost, tabIdToReload = null) {
  const host = normalizeHost(rawHost);
  if (!host) return { ok: false, error: "Invalid domain" };

  const state = await ensureStateLoaded();
  const set = new Set(state.disabledSites || []);
  let isWhitelisted = false;

  if (set.has(host)) {
    set.delete(host);
    isWhitelisted = false;
  } else {
    set.add(host);
    isWhitelisted = true;
  }

  state.disabledSites = Array.from(set).sort();
  await scheduleStorageFlush(["disabledSites"], true);
  await syncDnrEngineState();

  if (tabIdToReload && tabIdToReload > 0) {
    const count = await getTabCount(tabIdToReload);
    updateTabBadge(tabIdToReload, count, state.globallyDisabled || isWhitelisted);
    try {
      chrome.tabs.reload(tabIdToReload, () => void chrome.runtime.lastError);
    } catch (_) {}
  }

  return { ok: true, disabledSites: state.disabledSites, isWhitelisted };
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab || !tab.id) return;

  if (info.menuItemId === "BAD_ZAP_ELEMENT") {
    chrome.tabs.sendMessage(tab.id, { type: "START_ZAPPER" }, () => void chrome.runtime.lastError);
  } else if (info.menuItemId === "BAD_TOGGLE_SITE") {
    if (tab.url && /^https?:/i.test(tab.url)) {
      toggleSiteWhitelist(tab.url, tab.id);
    }
  } else if (info.menuItemId === "BAD_OPEN_OPTIONS") {
    chrome.runtime.openOptionsPage();
  }
});

chrome.commands.onCommand.addListener(command => {
  chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
    const tab = tabs && tabs[0];
    if (!tab || !tab.id) return;

    if (command === "zap_element") {
      chrome.tabs.sendMessage(tab.id, { type: "START_ZAPPER" }, () => void chrome.runtime.lastError);
    } else if (command === "toggle_site_protection") {
      if (tab.url && /^https?:/i.test(tab.url)) {
        toggleSiteWhitelist(tab.url, tab.id);
      }
    }
  });
});

/* ============================================================================
 * Tab Navigation & Lifecycle Listeners
 * ========================================================================== */
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "loading" && changeInfo.url) {
    setTabCount(tabId, 0);
    refreshTabBadgeState(tabId, changeInfo.url);
  } else if (changeInfo.status === "complete" && tab && tab.url) {
    refreshTabBadgeState(tabId, tab.url);
  }
});

chrome.tabs.onRemoved.addListener(tabId => {
  tabBlockCounts.delete(tabId);
  if (chrome.storage && chrome.storage.session) {
    try {
      chrome.storage.session.remove(`tab_${tabId}`);
    } catch (_) {}
  }
});

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  const state = await ensureStateLoaded();
  state.version = VERSION;
  if (reason === "install") {
    await scheduleStorageFlush(Object.keys(getInitialState()), true);
  } else {
    await scheduleStorageFlush(["version", "settings"], true);
  }
  await syncDnrEngineState();
  createContextMenus();
});

chrome.runtime.onStartup.addListener(async () => {
  await ensureStateLoaded();
  await syncDnrEngineState();
  createContextMenus();
});

/* ============================================================================
 * Runtime IPC Message Router
 * ========================================================================== */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== "object" || typeof msg.type !== "string") {
    return false;
  }

  // Verify sender belongs to this extension
  if (sender && sender.id && sender.id !== chrome.runtime.id) {
    return false;
  }

  const tabId = sender && sender.tab ? sender.tab.id : (msg.tabId || null);
  const initiator = sender && sender.tab && sender.tab.url ? sender.tab.url : "";

  (async () => {
    try {
      switch (msg.type) {
        case "BAD_BLOCKED": {
          await recordBlockEvent({
            url: msg.url || initiator || "unknown",
            kind: msg.kind || "ad",
            count: msg.count || 1,
            durationSec: msg.durationSec || 0,
            tabId,
            initiator
          });
          sendResponse({ ok: true });
          break;
        }

        case "BAD_BLOCKED_BATCH": {
          const items = Array.isArray(msg.items) ? msg.items : [];
          for (const item of items.slice(0, 50)) {
            await recordBlockEvent({
              url: item.url || initiator || "unknown",
              kind: item.kind || "ad",
              count: item.count || 1,
              durationSec: item.durationSec || 0,
              tabId,
              initiator
            });
          }
          sendResponse({ ok: true });
          break;
        }

        case "BAD_MODE_REPORT": {
          const state = await ensureStateLoaded();
          const host = normalizeHost(msg.host);
          if (host) {
            state.siteModes = state.siteModes || {};
            state.siteModes[host] = msg.mode === "stealth" ? "stealth" : "normal";
            scheduleStorageFlush(["siteModes"]);
          }
          sendResponse({ ok: true });
          break;
        }

        case "GET_STATS": {
          const state = await ensureStateLoaded();
          const activeTabId = msg.tabId || tabId;
          const tabCount = activeTabId ? await getTabCount(activeTabId) : 0;
          sendResponse({ ...state, activeTabBlocked: tabCount });
          break;
        }

        case "TOGGLE_SITE": {
          const res = await toggleSiteWhitelist(msg.host, msg.reloadTabId || null);
          sendResponse(res);
          break;
        }

        case "TOGGLE_GLOBAL": {
          const state = await ensureStateLoaded();
          state.globallyDisabled = typeof msg.value === "boolean" ? msg.value : !state.globallyDisabled;
          await scheduleStorageFlush(["globallyDisabled"], true);
          await syncDnrEngineState();
          sendResponse({ ok: true, globallyDisabled: state.globallyDisabled });
          break;
        }

        case "UPDATE_SETTINGS": {
          const state = await ensureStateLoaded();
          if (msg.settings && typeof msg.settings === "object") {
            state.settings = { ...getDefaultSettings(), ...state.settings, ...msg.settings };
            await scheduleStorageFlush(["settings"], true);
          }
          sendResponse({ ok: true, settings: state.settings });
          break;
        }

        case "ADD_CUSTOM_SELECTOR": {
          const selector = String(msg.selector || "").trim();
          if (!isValidCssSelector(selector)) {
            sendResponse({ ok: false, error: "Invalid or unsafe CSS selector syntax." });
            break;
          }
          const state = await ensureStateLoaded();
          const set = new Set(state.customSelectors || []);
          set.add(selector);
          state.customSelectors = Array.from(set);
          await scheduleStorageFlush(["customSelectors"], true);
          sendResponse({ ok: true, customSelectors: state.customSelectors });
          break;
        }

        case "REMOVE_CUSTOM_SELECTOR": {
          const state = await ensureStateLoaded();
          const list = Array.isArray(state.customSelectors) ? [...state.customSelectors] : [];
          if (typeof msg.selector === "string") {
            state.customSelectors = list.filter(s => s !== msg.selector);
          } else if (typeof msg.index === "number" && msg.index >= 0 && msg.index < list.length) {
            list.splice(msg.index, 1);
            state.customSelectors = list;
          }
          await scheduleStorageFlush(["customSelectors"], true);
          sendResponse({ ok: true, customSelectors: state.customSelectors });
          break;
        }

        case "ADD_DYNAMIC_RULE": {
          const filter = String(msg.filter || "").trim();
          if (!isValidDnrFilter(filter)) {
            sendResponse({ ok: false, error: "Filter must be a valid ASCII URL pattern without spaces." });
            break;
          }
          const state = await ensureStateLoaded();
          const existing = state.customDnrRules || [];
          if (existing.some(r => r.filter === filter)) {
            sendResponse({ ok: false, error: "Dynamic rule for this pattern already exists." });
            break;
          }
          const ruleId = allocateNextDnrId(existing);
          const newEntry = { id: ruleId, filter, createdAt: Date.now(), enabled: true };
          state.customDnrRules = [...existing, newEntry];
          await scheduleStorageFlush(["customDnrRules"], true);
          await syncDnrEngineState();
          sendResponse({ ok: true, ruleId, customDnrRules: state.customDnrRules });
          break;
        }

        case "REMOVE_DYNAMIC_RULE": {
          const state = await ensureStateLoaded();
          const list = Array.isArray(state.customDnrRules) ? [...state.customDnrRules] : [];
          if (typeof msg.ruleId === "number") {
            state.customDnrRules = list.filter(r => r.id !== msg.ruleId);
          } else if (typeof msg.index === "number" && msg.index >= 0 && msg.index < list.length) {
            list.splice(msg.index, 1);
            state.customDnrRules = list;
          }
          await scheduleStorageFlush(["customDnrRules"], true);
          await syncDnrEngineState();
          sendResponse({ ok: true, customDnrRules: state.customDnrRules });
          break;
        }

        case "IMPORT_CONFIG": {
          const raw = msg.data;
          if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
            sendResponse({ ok: false, error: "Configuration payload must be a valid JSON object." });
            break;
          }
          const state = await ensureStateLoaded();
          if (Array.isArray(raw.customSelectors)) {
            state.customSelectors = Array.from(
              new Set(raw.customSelectors.map(s => String(s).trim()).filter(isValidCssSelector))
            ).slice(0, 1000);
          }
          if (Array.isArray(raw.disabledSites)) {
            state.disabledSites = Array.from(
              new Set(raw.disabledSites.map(s => normalizeHost(String(s))).filter(Boolean))
            ).slice(0, 1000);
          }
          if (Array.isArray(raw.customDnrRules)) {
            const sanitizedRules = [];
            let nextId = USER_DNR_MIN_ID;
            for (const item of raw.customDnrRules.slice(0, 500)) {
              const f = item && typeof item.filter === "string" ? item.filter.trim() : "";
              if (isValidDnrFilter(f)) {
                sanitizedRules.push({
                  id: nextId++,
                  filter: f,
                  createdAt: Number(item.createdAt) || Date.now(),
                  enabled: item.enabled !== false
                });
              }
            }
            state.customDnrRules = sanitizedRules;
          }
          if (raw.settings && typeof raw.settings === "object") {
            const defaults = getDefaultSettings();
            for (const k of Object.keys(defaults)) {
              if (typeof raw.settings[k] === "boolean") {
                state.settings[k] = raw.settings[k];
              }
            }
          }
          await scheduleStorageFlush(["customSelectors", "disabledSites", "customDnrRules", "settings"], true);
          await syncDnrEngineState();
          sendResponse({ ok: true });
          break;
        }

        case "RESET_STATS": {
          const state = await ensureStateLoaded();
          const includeRules = !!msg.includeRules;
          const fresh = getInitialState();
          state.adsBlocked = 0;
          state.trackersBlocked = 0;
          state.sponsorsSkipped = 0;
          state.cookiesCleaned = 0;
          state.bandwidthSaved = 0;
          state.timeSavedSec = 0;
          state.domainCounts = {};
          state.recentEvents = [];
          if (includeRules) {
            state.customSelectors = [];
            state.customDnrRules = [];
            state.disabledSites = [];
            state.globallyDisabled = false;
            state.settings = fresh.settings;
          }
          await scheduleStorageFlush(Object.keys(fresh), true);
          await syncDnrEngineState();
          sendResponse({ ok: true });
          break;
        }

        default:
          sendResponse({ ok: false, error: `Unknown message type: ${msg.type}` });
      }
    } catch (err) {
      sendResponse({ ok: false, error: err && err.message ? err.message : "Internal service worker error" });
    }
  })();

  return true;
});
