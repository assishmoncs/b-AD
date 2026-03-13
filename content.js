(function () {
  "use strict";

  if (location.hostname.includes("youtube.com")) return;

  const MODE = (window.__bAD && window.__bAD.mode) || "normal";

  const AD_SELECTORS = [
    "ins.adsbygoogle",
    "div[data-ad-slot]",
    "div[data-ad-unit-path]",
    "div[data-google-query-id]",
    "div[data-dfp-ad]",
    "div[data-revive-zoneid]",
    '[id^="div-gpt-ad"]',
    '[id^="google_ads_iframe"]',
    '[id^="ad-slot-"]',
    '[id^="ad_slot_"]',
    '[id^="adunit-"]',
    'iframe[src*="doubleclick.net"]',
    'iframe[src*="googlesyndication.com"]',
    'iframe[src*="adservice.google.com"]',
    'iframe[src*="amazon-adsystem.com"]',
    'iframe[src*="ads.yahoo.com"]',
    'iframe[src*="adnxs.com"]',
    'iframe[id^="google_ads_iframe"]',
    ".OUTBRAIN",
    "#taboola-below-article-thumbnails",
    ".taboola-widget",
    '[id^="taboola-"]',
    '[id^="outbrain_"]',
    "[data-sponsored]",
    "[data-ad-rendered]",
    "amp-ad",
    ".ad-banner",
    ".ad-slot",
    ".ad-container",
    ".ad-unit",
    ".ad-wrapper",
    "#ad-container",
    "#ad-slot",
    ".advertisement-container",
    ".ads-wrapper",
    'iframe[src*="ads"]'
  ];

  const TRACKER_PATTERNS = [
    /google-analytics\.com/,
    /googletagmanager\.com/,
    /connect\.facebook\.net/,
    /analytics\.tiktok\.com/,
    /hotjar\.com/,
    /mouseflow\.com/,
    /fullstory\.com/,
    /mixpanel\.com/,
    /segment\.io/,
    /amplitude\.com/,
    /heap\.io/,
    /bat\.bing\.com/,
    /tr\.snapchat\.com/,
    /analytics\.twitter\.com/
  ];

  function notify(url, kind) {
    try { chrome.runtime.sendMessage({ type: "BAD_BLOCKED", url, kind }); } catch (_) {}
  }

  function matches(el, selectors) {
    if (!el || !el.matches) return false;
    return selectors.some(s => { try { return el.matches(s); } catch (_) { return false; } });
  }

  function queryAll(root, selectors) {
    const found = new Set();
    selectors.forEach(s => {
      try { (root || document).querySelectorAll(s).forEach(e => found.add(e)); } catch (_) {}
    });
    return [...found];
  }

  function hideEl(el) {
    el.style.setProperty("visibility", "hidden", "important");
    el.style.setProperty("pointer-events", "none", "important");
    el.style.setProperty("max-height", "1px", "important");
    el.style.setProperty("overflow", "hidden", "important");
  }

  function processAd(el) {
    if (MODE === "stealth") {
      hideEl(el);
    } else {
      try { el.remove(); } catch (_) {}
    }
    notify(location.hostname, "ad");
  }

  function injectBaseStyles() {
    if (document.getElementById("b-ad-v3-style")) return;
    const style = document.createElement("style");
    style.id = "b-ad-v3-style";
    style.textContent = AD_SELECTORS.join(",\n") + "{\nvisibility:hidden!important;\npointer-events:none!important;\nmax-height:1px!important;\noverflow:hidden!important;\n}";
    (document.head || document.documentElement).appendChild(style);
  }

  function scanRoot(root) {
    queryAll(root, AD_SELECTORS).forEach(el => processAd(el));
  }

  function startObserver() {
    const obs = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node.nodeType !== 1) continue;
          if (node.tagName === "SCRIPT" && MODE === "normal") {
            if (node.src && TRACKER_PATTERNS.some(p => p.test(node.src))) {
              node.type = "javascript/blocked";
              notify(node.src, "tracker");
              continue;
            }
          }
          if (matches(node, AD_SELECTORS)) {
            MODE === "stealth" ? setTimeout(() => processAd(node), 250) : processAd(node);
            continue;
          }
          scanRoot(node);
        }
      }
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });
  }

  function boot() {
    injectBaseStyles();
    scanRoot(document.body || document.documentElement);
    startObserver();
    setTimeout(() => scanRoot(document.body), 800);
    setTimeout(() => scanRoot(document.body), 2500);
    setTimeout(() => scanRoot(document.body), 5000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
