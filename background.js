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

function getInitialState() {
  return {
    adsBlocked: 0,
    trackersBlocked: 0,
    bandwidthSaved: 0,
    domainCounts: {},
    siteModes: {},
    disabledSites: [],
    globallyDisabled: false
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

function matchesDomainSet(url, set) {
  try {
    const host = new URL(url).hostname;
    for (const d of set) {
      if (host === d || host.endsWith("." + d)) return true;
    }
  } catch (_) {}
  return false;
}

async function recordBlock(url, kind) {
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
}

if (chrome.declarativeNetRequest && chrome.declarativeNetRequest.onRuleMatchedDebug) {
  chrome.declarativeNetRequest.onRuleMatchedDebug.addListener(({ request }) => {
    recordBlock(request.url, "ad");
  });
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return false;

  if (msg.type === "BAD_BLOCKED") {
    recordBlock(msg.url || "unknown", msg.kind || "ad");
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
      if (list.has(site)) {
        list.delete(site);
      } else {
        list.add(site);
      }
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

  if (msg.type === "RESET_STATS") {
    const fresh = getInitialState();
    chrome.storage.local.set(fresh, () => sendResponse({ ok: true }));
    return true;
  }

  return true;
});

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === "install") {
    chrome.storage.local.set(getInitialState());
  }
});
