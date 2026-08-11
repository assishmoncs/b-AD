"use strict";

const AVG_BYTES_AD      = 102400; // ~100 KB per ad block
const AVG_BYTES_TRACKER = 20480;  // ~20 KB per tracker block

const AD_DOMAIN_SET = new Set([
  "doubleclick.net","googlesyndication.com","adservice.google.com",
  "ads.twitter.com","amazon-adsystem.com","adnxs.com","outbrain.com",
  "taboola.com","rubiconproject.com","pubmatic.com","openx.net","criteo.com",
  "casalemedia.com","media.net","advertising.com","ads.linkedin.com",
  "scorecardresearch.com","quantserve.com","adsrvr.org","smartadserver.com",
  "ads.yahoo.com","mopub.com","bat.bing.com","sc-static.net","tr.snapchat.com",
  "popads.net","popcash.net","propellerads.com","exoclick.com","juicyads.com","adcash.com"
]);

const TRACKER_DOMAIN_SET = new Set([
  "google-analytics.com","googletagmanager.com","connect.facebook.net",
  "analytics.tiktok.com","ads.tiktok.com","hotjar.com","mouseflow.com",
  "fullstory.com","mixpanel.com","segment.io","segment.com","amplitude.com",
  "heap.io","intercom.io","bat.bing.com","sc-static.net","tr.snapchat.com",
  "analytics.twitter.com","static.ads-twitter.com","crazyegg.com",
  "luckyorange.com","pardot.com","marketo.com","hubspot.com","clarity.ms",
  "mc.yandex.ru","sentry.io","bugsnag.com"
]);

const tabBlockCounts = new Map();

function getInitialState() {
  return {
    adsBlocked: 0,
    trackersBlocked: 0,
    bandwidthSaved: 0,
    domainCounts: {},
    siteModes: {},
    disabledSites: [],
    globallyDisabled: false,
    customSelectors: [],
    customDnrRules: []
  };
}

function getStats() {
  return new Promise(res => {
    chrome.storage.local.get(getInitialState(), res);
  });
}

function extractDomain(url) {
  try {
    const rawUrl = url.startsWith("http") ? url : "https://" + url;
    const h = new URL(rawUrl).hostname;
    const p = h.replace(/^www\./, "").split(".");
    return p.length >= 2 ? p.slice(-2).join(".") : h;
  } catch (_) {
    return url;
  }
}

function updateTabBadge(tabId, count, isPaused) {
  if (isPaused) {
    chrome.action.setBadgeText({ tabId, text: "OFF" });
    chrome.action.setBadgeBackgroundColor({ tabId, color: "#ff9f0a" });
  } else if (count > 0) {
    chrome.action.setBadgeText({ tabId, text: count > 999 ? "999+" : String(count) });
    chrome.action.setBadgeBackgroundColor({ tabId, color: "#ff3b30" });
  } else {
    chrome.action.setBadgeText({ tabId, text: "ON" });
    chrome.action.setBadgeBackgroundColor({ tabId, color: "#30d158" });
  }
}

async function recordBlock(url, kind, tabId) {
  const stats = await getStats();
  if (stats.globallyDisabled) return;

  const d = extractDomain(url);
  if (stats.disabledSites && stats.disabledSites.includes(d)) return;

  const isAd      = kind === "ad"      || matchesDomainSet(url, AD_DOMAIN_SET);
  const isTracker = kind === "tracker" || matchesDomainSet(url, TRACKER_DOMAIN_SET);
  if (!isAd && !isTracker) return;

  if (isAd)      stats.adsBlocked++;
  if (isTracker) stats.trackersBlocked++;
  stats.bandwidthSaved += isTracker ? AVG_BYTES_TRACKER : AVG_BYTES_AD;

  stats.domainCounts = stats.domainCounts || {};
  stats.domainCounts[d] = (stats.domainCounts[d] || 0) + 1;

  chrome.storage.local.set(stats);

  if (tabId) {
    const c = (tabBlockCounts.get(tabId) || 0) + 1;
    tabBlockCounts.set(tabId, c);
    updateTabBadge(tabId, c, false);
  }
}

function matchesDomainSet(url, set) {
  try {
    const host = new URL(url).hostname;
    for (const d of set) {
      if (host === d || host.endsWith("." + d)) return true;
    }
  } catch (_) {}
  return false;
}

if (chrome.declarativeNetRequest && chrome.declarativeNetRequest.onRuleMatchedDebug) {
  chrome.declarativeNetRequest.onRuleMatchedDebug.addListener(({ request }) => {
    recordBlock(request.url, "ad", request.tabId);
  });
}

// Context Menu Setup
function createContextMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "BAD_ZAP_ELEMENT",
      title: "⚡ Zap Element on Page (b-AD)",
      contexts: ["page", "selection", "image", "video"]
    });
    chrome.contextMenus.create({
      id: "BAD_TOGGLE_SITE",
      title: "⏸ Pause / Resume b-AD on this Site",
      contexts: ["page"]
    });
    chrome.contextMenus.create({
      id: "BAD_OPEN_OPTIONS",
      title: "⚙ Open Advanced Options",
      contexts: ["page"]
    });
  });
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab || !tab.id) return;

  if (info.menuItemId === "BAD_ZAP_ELEMENT") {
    chrome.tabs.sendMessage(tab.id, { type: "START_ZAPPER" });
  }

  if (info.menuItemId === "BAD_TOGGLE_SITE") {
    try {
      const host = new URL(tab.url).hostname.replace(/^www\./, "");
      getStats().then(stats => {
        const list = new Set(stats.disabledSites || []);
        if (list.has(host)) list.delete(host); else list.add(host);
        stats.disabledSites = Array.from(list);
        chrome.storage.local.set({ disabledSites: stats.disabledSites }, () => {
          chrome.tabs.reload(tab.id);
        });
      });
    } catch (_) {}
  }

  if (info.menuItemId === "BAD_OPEN_OPTIONS") {
    chrome.runtime.openOptionsPage();
  }
});

// Keyboard Commands Listener
chrome.commands.onCommand.addListener(command => {
  if (command === "zap_element") {
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      if (tabs[0] && tabs[0].id) {
        chrome.tabs.sendMessage(tabs[0].id, { type: "START_ZAPPER" });
      }
    });
  }
});

// Message Listener
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return false;

  const tabId = sender && sender.tab ? sender.tab.id : null;

  if (msg.type === "BAD_BLOCKED") {
    recordBlock(msg.url || "unknown", msg.kind || "ad", tabId);
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === "BAD_MODE_REPORT") {
    getStats().then(stats => {
      stats.siteModes = stats.siteModes || {};
      stats.siteModes[msg.host] = msg.mode;
      chrome.storage.local.set({ siteModes: stats.siteModes });
    });
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === "GET_STATS") {
    getStats().then(sendResponse);
    return true;
  }

  if (msg.type === "TOGGLE_SITE") {
    getStats().then(stats => {
      const site = msg.host;
      const list = new Set(stats.disabledSites || []);
      if (list.has(site)) list.delete(site); else list.add(site);
      stats.disabledSites = Array.from(list);
      chrome.storage.local.set({ disabledSites: stats.disabledSites }, () => {
        sendResponse({ ok: true, disabledSites: stats.disabledSites });
      });
    });
    return true;
  }

  if (msg.type === "TOGGLE_GLOBAL") {
    getStats().then(stats => {
      stats.globallyDisabled = !stats.globallyDisabled;
      chrome.storage.local.set({ globallyDisabled: stats.globallyDisabled }, () => {
        sendResponse({ ok: true, globallyDisabled: stats.globallyDisabled });
      });
    });
    return true;
  }

  if (msg.type === "ADD_DYNAMIC_RULE") {
    const filter = msg.filter;
    if (filter && chrome.declarativeNetRequest.updateDynamicRules) {
      const ruleId = Math.floor(Math.random() * 899999) + 100000;
      const rule = {
        id: ruleId,
        priority: 1,
        action: { type: "block" },
        condition: { urlFilter: filter, resourceTypes: ["script", "image", "xmlhttprequest", "sub_frame"] }
      };
      chrome.declarativeNetRequest.updateDynamicRules({
        addRules: [rule]
      }, () => {
        getStats().then(stats => {
          stats.customDnrRules = stats.customDnrRules || [];
          stats.customDnrRules.push({ id: ruleId, filter });
          chrome.storage.local.set({ customDnrRules: stats.customDnrRules }, () => {
            sendResponse({ ok: true, ruleId });
          });
        });
      });
      return true;
    }
  }

  if (msg.type === "RESET_STATS") {
    const fresh = getInitialState();
    chrome.storage.local.set(fresh, () => sendResponse({ ok: true }));
    return true;
  }

  return true;
});

chrome.tabs.onRemoved.addListener(tabId => {
  tabBlockCounts.delete(tabId);
});

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === "install") {
    chrome.storage.local.set(getInitialState());
  }
  createContextMenus();
});
