/** b-AD Ultra 6.0 background worker: settings, network rules, and page activity. */

"use strict";

const VERSION = "6.0.0";
const STATIC_RULESET_ID = "ad_block_rules";
const TRACKING_RULESET_ID = "tracking_param_rules";
const USER_DNR_MIN_ID = 100001;
const ALLOW_DNR_BASE_ID = 900001;

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
    stealthMode: false,
    cookieCleaner: false,
    youtubeEngine: true,
    sponsorBlock: false,
    stripTrackingParams: true
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
let flushChain = Promise.resolve();
const dirtyKeys = new Set();
const tabBlockCounts = new Map();

async function ensureStateLoaded() {
  if (stateCache) return stateCache;
  if (stateInitPromise) return stateInitPromise;

  stateInitPromise = new Promise(resolve => {
    try {
      chrome.storage.local.get(getInitialState(), data => {
        const defaults = getInitialState();
        const settings = { ...defaults.settings };
        for (const key of Object.keys(settings)) {
          if (typeof data?.settings?.[key] === "boolean") settings[key] = data.settings[key];
        }
        stateCache = {
          ...defaults,
          ...data,
          settings,
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
      flushStorageNow().catch(() => {});
    }, 350);
  }
  return Promise.resolve();
}

function flushStorageNow() {
  const write = () => new Promise((resolve, reject) => {
    if (!stateCache || dirtyKeys.size === 0) return resolve();
    const keys = Array.from(dirtyKeys);
    const payload = {};
    keys.forEach(k => { if (k in stateCache) payload[k] = stateCache[k]; });
    dirtyKeys.clear();
    try {
      chrome.storage.local.set(payload, () => {
        const error = chrome.runtime.lastError;
        if (error) {
          keys.forEach(k => dirtyKeys.add(k));
          reject(new Error(error.message || "Could not save extension settings"));
        } else {
          resolve();
        }
      });
    } catch (error) {
      keys.forEach(k => dirtyKeys.add(k));
      reject(error);
    }
  });
  flushChain = flushChain.then(write, write);
  return flushChain;
}

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
    if (!/^https?:$/.test(u.protocol) || u.username || u.password) return "";
    const host = u.hostname.replace(/^www\./, "");
    if (host.length > 253 || !host.split(".").every(label =>
      label.length > 0 && label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)
    )) return "";
    return host;
  } catch (_) { return ""; }
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
let dnrSyncQueue = Promise.resolve();
function syncDnrEngineState() {
  const sync = async () => {
    const state = await ensureStateLoaded();
    if (!chrome.declarativeNetRequest) throw new Error("Network rule API unavailable");

    await chrome.declarativeNetRequest.updateEnabledRulesets({
      enableRulesetIds: state.globallyDisabled ? [] :
        [STATIC_RULESET_ID, ...(state.settings.stripTrackingParams ? [TRACKING_RULESET_ID] : [])],
      disableRulesetIds: state.globallyDisabled ? [STATIC_RULESET_ID, TRACKING_RULESET_ID] :
        (state.settings.stripTrackingParams ? [] : [TRACKING_RULESET_ID])
    });

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
  };
  dnrSyncQueue = dnrSyncQueue.then(sync, sync);
  return dnrSyncQueue;
}

let stateMutationQueue = Promise.resolve();
function applyDnrMutation(state, mutate, keys) {
  const work = async () => {
    const previous = {
      globallyDisabled: state.globallyDisabled,
      disabledSites: [...state.disabledSites],
      customSelectors: [...state.customSelectors],
      customDnrRules: state.customDnrRules.map(rule => ({ ...rule })),
      settings: { ...state.settings }
    };
    try {
      mutate();
      await syncDnrEngineState();
      await scheduleStorageFlush(keys, true);
    } catch (error) {
      Object.assign(state, previous);
      try { await syncDnrEngineState(); } catch (_) {}
      throw error;
    }
  };
  stateMutationQueue = stateMutationQueue.then(work, work);
  return stateMutationQueue;
}

function applySelectorMutation(state, mutate) {
  const work = async () => {
    const previous = [...state.customSelectors];
    try {
      mutate();
      await scheduleStorageFlush(["customSelectors"], true);
    } catch (error) {
      state.customSelectors = previous;
      throw error;
    }
  };
  stateMutationQueue = stateMutationQueue.then(work, work);
  return stateMutationQueue;
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

  const safeCount = Math.max(1, Math.min(Math.floor(Number(count) || 1), 250));
  const isSponsor = kind === "sponsor";
  const isCookie = kind === "cookie";
  const isTracker = !isSponsor && !isCookie && (kind === "tracker" || matchesDomainSet(url, TRACKER_DOMAIN_SET));
  const isAd = !isSponsor && !isCookie && !isTracker && (kind === "ad" || matchesDomainSet(url, AD_DOMAIN_SET));

  if (!isAd && !isTracker && !isSponsor && !isCookie) return;

  if (isAd) {
    state.adsBlocked = (state.adsBlocked || 0) + safeCount;
  } else if (isTracker) {
    state.trackersBlocked = (state.trackersBlocked || 0) + safeCount;
  } else if (isSponsor) {
    state.sponsorsSkipped = (state.sponsorsSkipped || 0) + safeCount;
    const duration = Number(durationSec);
    state.timeSavedSec = (state.timeSavedSec || 0) + (Number.isFinite(duration) ? Math.max(0, Math.min(duration, 3600)) : 0);
  } else if (isCookie) {
    state.cookiesCleaned = (state.cookiesCleaned || 0) + safeCount;
  }

  if (targetDomain && targetDomain !== "unknown") {
    state.domainCounts[targetDomain] = (state.domainCounts[targetDomain] || 0) + safeCount;
    const domains = Object.keys(state.domainCounts);
    if (domains.length > 500) {
      const oldest = domains.reduce((a, b) => state.domainCounts[a] <= state.domainCounts[b] ? a : b);
      delete state.domainCounts[oldest];
    }
  }

  // Record bounded recent page-action log (latest 50 items)
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
  if (trimmed.length > 253) return false;
  const match = /^\|\|([a-z0-9.-]+)\^$/.exec(trimmed);
  return !!match && normalizeHost(match[1]) === match[1] && match[1].includes(".");
}

function migrateLegacyDnrFilter(rawFilter) {
  if (typeof rawFilter !== "string") return "";
  const filter = rawFilter.trim();
  if (isValidDnrFilter(filter)) return filter;
  const match = /^\*:\/\/([a-z0-9.-]+)\/\*$/.exec(filter);
  if (match && normalizeHost(match[1]) === match[1] && match[1].includes(".")) {
    return `||${match[1]}^`;
  }
  return "";
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
      title: "⚡ Zap Element on Page (b-AD v6.0)",
      contexts: ["page", "selection", "image", "video", "frame"]
    }, () => void chrome.runtime.lastError);

    chrome.contextMenus.create({
      id: "BAD_TOGGLE_SITE",
      title: "⏸ Pause / Resume b-AD on this Site",
      contexts: ["page"]
    }, () => void chrome.runtime.lastError);

    chrome.contextMenus.create({
      id: "BAD_OPEN_OPTIONS",
      title: "⚙ Open b-AD Settings",
      contexts: ["page"]
    }, () => void chrome.runtime.lastError);
  });
}

async function toggleSiteWhitelist(rawHost, tabIdToReload = null, desiredState = null) {
  const host = normalizeHost(rawHost);
  if (!host) return { ok: false, error: "Invalid domain" };

  const state = await ensureStateLoaded();
  let isWhitelisted = false;
  await applyDnrMutation(state, () => {
    const set = new Set(state.disabledSites || []);
    if (desiredState === true) set.add(host);
    else if (desiredState === false || set.has(host)) set.delete(host);
    else set.add(host);
    isWhitelisted = set.has(host);
    state.disabledSites = Array.from(set).sort();
  }, ["disabledSites"]);

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
  if (reason === "update" && state.version !== VERSION) {
    // Version 5 counted debug matches and estimated savings; begin accurate v6 counts.
    Object.assign(state, {
      adsBlocked: 0, trackersBlocked: 0, sponsorsSkipped: 0, cookiesCleaned: 0,
      bandwidthSaved: 0, timeSavedSec: 0, domainCounts: {}, recentEvents: []
    });
    state.disabledSites = Array.from(new Set((state.disabledSites || []).map(normalizeHost).filter(Boolean))).slice(0, 1000);
    state.customSelectors = (state.customSelectors || []).filter(isValidCssSelector).slice(0, 1000);
    state.customDnrRules = (state.customDnrRules || []).slice(0, 500).flatMap((rule, index) => {
      const filter = migrateLegacyDnrFilter(rule?.filter);
      return filter ? [{ id: USER_DNR_MIN_ID + index, filter, createdAt: Number(rule.createdAt) || Date.now(), enabled: rule.enabled !== false }] : [];
    });
  }
  state.version = VERSION;
  if (reason === "install") {
    await scheduleStorageFlush(Object.keys(getInitialState()), true);
  } else {
    await scheduleStorageFlush(["version", "settings", "disabledSites", "customSelectors", "customDnrRules", "adsBlocked", "trackersBlocked", "sponsorsSkipped", "cookiesCleaned", "bandwidthSaved", "timeSavedSec", "domainCounts", "recentEvents"], true);
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
          await flushStorageNow();
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
          await flushStorageNow();
          sendResponse({ ok: true });
          break;
        }

        case "BAD_MODE_REPORT": {
          const state = await ensureStateLoaded();
          const host = normalizeHost(msg.host);
          if (host) {
            state.siteModes = state.siteModes || {};
            state.siteModes[host] = msg.mode === "stealth" ? "stealth" : "normal";
            const hosts = Object.keys(state.siteModes);
            if (hosts.length > 200) delete state.siteModes[hosts[0]];
            await scheduleStorageFlush(["siteModes"], true);
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

        case "ADD_SITE": {
          const res = await toggleSiteWhitelist(msg.host, null, true);
          sendResponse(res);
          break;
        }

        case "TOGGLE_GLOBAL": {
          const state = await ensureStateLoaded();
          await applyDnrMutation(state, () => {
            state.globallyDisabled = typeof msg.value === "boolean" ? msg.value : !state.globallyDisabled;
          }, ["globallyDisabled"]);
          sendResponse({ ok: true, globallyDisabled: state.globallyDisabled });
          break;
        }

        case "UPDATE_SETTINGS": {
          const state = await ensureStateLoaded();
          if (msg.settings && typeof msg.settings === "object") {
            const allowed = {};
            for (const key of Object.keys(getDefaultSettings())) {
              if (typeof msg.settings[key] === "boolean") allowed[key] = msg.settings[key];
            }
            await applyDnrMutation(state, () => {
              state.settings = { ...getDefaultSettings(), ...state.settings, ...allowed };
            }, ["settings"]);
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
          await applySelectorMutation(state, () => {
            if (state.customSelectors.length >= 1000 && !state.customSelectors.includes(selector)) {
              throw new Error("Maximum 1000 element rules");
            }
            state.customSelectors = Array.from(new Set([...state.customSelectors, selector]));
          });
          sendResponse({ ok: true, customSelectors: state.customSelectors });
          break;
        }

        case "REMOVE_CUSTOM_SELECTOR": {
          const state = await ensureStateLoaded();
          await applySelectorMutation(state, () => {
            const list = [...state.customSelectors];
            if (typeof msg.selector === "string") state.customSelectors = list.filter(s => s !== msg.selector);
            else if (typeof msg.index === "number" && msg.index >= 0 && msg.index < list.length) {
              list.splice(msg.index, 1);
              state.customSelectors = list;
            }
          });
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
          if (existing.length >= 500) throw new Error("Maximum 500 custom network rules");
          let ruleId;
          await applyDnrMutation(state, () => {
            ruleId = allocateNextDnrId(state.customDnrRules);
            state.customDnrRules = [...state.customDnrRules, { id: ruleId, filter, createdAt: Date.now(), enabled: true }];
          }, ["customDnrRules"]);
          sendResponse({ ok: true, ruleId, customDnrRules: state.customDnrRules });
          break;
        }

        case "REMOVE_DYNAMIC_RULE": {
          const state = await ensureStateLoaded();
          await applyDnrMutation(state, () => {
            const list = Array.isArray(state.customDnrRules) ? [...state.customDnrRules] : [];
            if (typeof msg.ruleId === "number") state.customDnrRules = list.filter(r => r.id !== msg.ruleId);
            else if (typeof msg.index === "number" && msg.index >= 0 && msg.index < list.length) {
              list.splice(msg.index, 1);
              state.customDnrRules = list;
            }
          }, ["customDnrRules"]);
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
          await applyDnrMutation(state, () => {
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
          }, ["customSelectors", "disabledSites", "customDnrRules", "settings"]);
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
            await applyDnrMutation(state, () => {
              state.customSelectors = [];
              state.customDnrRules = [];
              state.disabledSites = [];
              state.globallyDisabled = false;
              state.settings = fresh.settings;
            }, ["customSelectors", "customDnrRules", "disabledSites", "globallyDisabled", "settings"]);
          }
          await scheduleStorageFlush([
            "adsBlocked", "trackersBlocked", "sponsorsSkipped", "cookiesCleaned",
            "bandwidthSaved", "timeSavedSec", "domainCounts", "recentEvents"
          ], true);
          tabBlockCounts.clear();
          await chrome.storage.session.clear();
          chrome.tabs.query({}, tabs => {
            for (const tab of tabs || []) {
              if (tab.id) refreshTabBadgeState(tab.id, tab.url);
            }
          });
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
