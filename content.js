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
    'iframe[src*="ads"]',
    ".sponsored-post",
    ".promoted-content",
    ".native-ad-unit"
  ];

  const COOKIE_ANNOYANCE_SELECTORS = [
    "#onetrust-banner-sdk",
    "#onetrust-consent-sdk",
    ".cookie-consent",
    ".cookie-banner",
    ".cookie-notice",
    ".gdpr-modal",
    ".gdpr-banner",
    "#gdpr-consent-tool-wrapper",
    'div[id*="cookie-notice"]',
    'div[id*="cookie-banner"]',
    'div[class*="cookieConsent"]',
    'div[class*="CookieConsent"]'
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
    /analytics\.twitter\.com/,
    /clarity\.ms/,
    /mc\.yandex\.ru/
  ];

  let isDisabled = false;
  let customSelectors = [];

  function checkDisabledStatus() {
    return new Promise(res => {
      try {
        chrome.storage.local.get({ globallyDisabled: false, disabledSites: [], customSelectors: [] }, stats => {
          customSelectors = stats.customSelectors || [];
          if (stats.globallyDisabled) return res(true);
          const host = location.hostname.replace(/^www\./, "");
          const isPaused = (stats.disabledSites || []).some(s => host === s || host.endsWith("." + s));
          res(isPaused);
        });
      } catch (_) {
        res(false);
      }
    });
  }

  function notify(url, kind) {
    if (isDisabled) return;
    try {
      chrome.runtime.sendMessage({ type: "BAD_BLOCKED", url, kind });
    } catch (_) {}
  }

  function hideEl(el) {
    if (!el || !el.style) return;
    el.style.setProperty("display", "none", "important");
    el.style.setProperty("visibility", "hidden", "important");
    el.style.setProperty("pointer-events", "none", "important");
    el.style.setProperty("max-height", "1px", "important");
    el.style.setProperty("overflow", "hidden", "important");
    el.style.setProperty("opacity", "0", "important");
  }

  function processAd(el) {
    if (isDisabled) return;
    if (MODE === "stealth") {
      hideEl(el);
    } else {
      try { el.remove(); } catch (_) { hideEl(el); }
    }
    notify(location.hostname, "ad");
  }

  function injectBaseStyles() {
    if (document.getElementById("b-ad-v4-style")) return;
    const style = document.createElement("style");
    style.id = "b-ad-v4-style";
    const allSelectors = [...AD_SELECTORS, ...COOKIE_ANNOYANCE_SELECTORS, ...customSelectors];
    style.textContent = allSelectors.join(",\n") + "{\ndisplay:none!important;\nvisibility:hidden!important;\npointer-events:none!important;\nopacity:0!important;\n}";
    (document.head || document.documentElement).appendChild(style);
  }

  function scanRoot(root) {
    if (isDisabled || !root) return;
    const selectors = [...AD_SELECTORS, ...COOKIE_ANNOYANCE_SELECTORS, ...customSelectors];
    selectors.forEach(s => {
      try {
        root.querySelectorAll(s).forEach(el => processAd(el));
      } catch (_) {}
    });

    // Shadow DOM Recursive Scan
    try {
      const allEls = root.querySelectorAll("*");
      allEls.forEach(el => {
        if (el.shadowRoot) scanRoot(el.shadowRoot);
      });
    } catch (_) {}
  }

  function startObserver() {
    const obs = new MutationObserver((mutations) => {
      if (isDisabled) return;
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
          scanRoot(node);
        }
      }
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });
  }

  async function boot() {
    isDisabled = await checkDisabledStatus();
    if (isDisabled) return;

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
