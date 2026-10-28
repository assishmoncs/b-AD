/**
 * b-AD Ultra v5.0 Enterprise — Cosmetic Ad & GDPR Annoyance Engine
 * ---------------------------------------------------------------------------
 * Improvements over v4.0:
 * 1. Eliminated duplicate counting & layout thrashing via a WeakSet of
 *    processed nodes (`processedNodes`).
 * 2. Isolated built-in CSS rules from user custom selectors (`#b-ad-v5-core` vs
 *    `#b-ad-v5-custom`) and validated every custom selector via a detached
 *    DocumentFragment so a single invalid user selector can never break core CSS.
 * 3. Micro-batched MutationObserver processing via `requestAnimationFrame`
 *    and batched IPC telemetry messages (`BAD_BLOCKED_BATCH`) every 500ms.
 * 4. Real-time reactivity via `chrome.storage.onChanged` (instant pause/resume
 *    and live custom selector injection without page reload).
 */

(function () {
  "use strict";

  const cleanHost = (location.hostname || "").replace(/^www\./, "").toLowerCase();
  if (!cleanHost || cleanHost.includes("youtube.com")) return;

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
    ".sponsored-post",
    ".promoted-content",
    ".native-ad-unit"
  ];

  const COOKIE_ANNOYANCE_SELECTORS = [
    "#onetrust-banner-sdk",
    "#onetrust-consent-sdk",
    "#CybotCookiebotDialog",
    "#didomi-host",
    ".cookie-consent",
    ".cookie-banner",
    ".cookie-notice",
    ".gdpr-modal",
    ".gdpr-banner",
    "#gdpr-consent-tool-wrapper",
    'div[id*="cookie-notice"]',
    'div[id*="cookie-banner"]',
    'div[class*="cookieConsent"]',
    'div[class*="CookieConsent"]',
    ".cc-window.cc-banner"
  ];

  const TRACKER_PATTERNS = [
    /google-analytics\.com/i,
    /googletagmanager\.com/i,
    /connect\.facebook\.net/i,
    /analytics\.tiktok\.com/i,
    /hotjar\.com/i,
    /mouseflow\.com/i,
    /fullstory\.com/i,
    /mixpanel\.com/i,
    /segment\.io/i,
    /amplitude\.com/i,
    /heap\.io/i,
    /bat\.bing\.com/i,
    /tr\.snapchat\.com/i,
    /analytics\.twitter\.com/i,
    /clarity\.ms/i,
    /mc\.yandex\.ru/i
  ];

  const validatorFrag = document.createDocumentFragment();
  const processedNodes = new WeakSet();
  const pendingMutationRoots = new Set();

  let isDisabled = false;
  let settings = {
    stealthMode: true,
    cookieCleaner: true,
    strictCosmetic: true
  };
  let validCustomSelectors = [];
  let combinedAdSelector = AD_SELECTORS.join(",");
  let combinedCookieSelector = COOKIE_ANNOYANCE_SELECTORS.join(",");
  let rafScheduled = false;

  // Batched IPC Telemetry Queue
  const telemetryBatch = [];
  let telemetryTimer = null;

  function queueTelemetry(url, kind, count = 1) {
    if (isDisabled) return;
    telemetryBatch.push({ url: url || cleanHost, kind, count });
    if (!telemetryTimer) {
      telemetryTimer = setTimeout(flushTelemetry, 500);
    }
  }

  function flushTelemetry() {
    telemetryTimer = null;
    if (isDisabled || !telemetryBatch.length) {
      telemetryBatch.length = 0;
      return;
    }
    // Aggregate identical (url, kind) pairs before sending over IPC
    const map = new Map();
    for (const item of telemetryBatch) {
      const key = `${item.kind}::${item.url}`;
      const existing = map.get(key);
      if (existing) {
        existing.count += item.count;
      } else {
        map.set(key, { ...item });
      }
    }
    telemetryBatch.length = 0;
    try {
      chrome.runtime.sendMessage(
        { type: "BAD_BLOCKED_BATCH", items: Array.from(map.values()) },
        () => void chrome.runtime.lastError
      );
    } catch (_) {}
  }

  function validateSelector(sel) {
    if (typeof sel !== "string") return false;
    const trimmed = sel.trim();
    if (!trimmed || trimmed.length > 512) return false;
    if (/[{};]|@import|url\s*\(/i.test(trimmed)) return false;
    try {
      validatorFrag.querySelector(trimmed);
      return true;
    } catch (_) {
      return false;
    }
  }

  function setCustomSelectors(rawList) {
    if (!Array.isArray(rawList)) {
      validCustomSelectors = [];
      return;
    }
    validCustomSelectors = rawList.filter(validateSelector);
  }

  function loadConfiguration() {
    return new Promise(resolve => {
      try {
        chrome.storage.local.get(
          {
            globallyDisabled: false,
            disabledSites: [],
            customSelectors: [],
            settings: { stealthMode: true, cookieCleaner: true, strictCosmetic: true }
          },
          data => {
            void chrome.runtime.lastError;
            if (!data) return resolve(false);
            settings = { ...settings, ...(data.settings || {}) };
            setCustomSelectors(data.customSelectors || []);
            if (data.globallyDisabled) return resolve(true);
            const paused = (data.disabledSites || []).some(
              s => cleanHost === s || cleanHost.endsWith("." + s)
            );
            resolve(paused);
          }
        );
      } catch (_) {
        resolve(false);
      }
    });
  }

  function getCurrentMode() {
    if (window.__bAD && window.__bAD.mode) return window.__bAD.mode;
    if (document.documentElement && document.documentElement.dataset.badMode) {
      return document.documentElement.dataset.badMode;
    }
    return "normal";
  }

  function hideElement(el) {
    if (!el || !el.style) return;
    el.style.setProperty("display", "none", "important");
    el.style.setProperty("visibility", "hidden", "important");
    el.style.setProperty("pointer-events", "none", "important");
    el.style.setProperty("max-height", "0px", "important");
    el.style.setProperty("overflow", "hidden", "important");
    el.style.setProperty("opacity", "0", "important");
    el.setAttribute("data-bad-hidden", "true");
  }

  function processElement(el, kind = "ad") {
    if (isDisabled || !el || processedNodes.has(el)) return;
    processedNodes.add(el);

    const mode = getCurrentMode();
    if (mode === "stealth") {
      hideElement(el);
    } else {
      try {
        hideElement(el);
      } catch (_) {}
    }
    queueTelemetry(cleanHost, kind, 1);
  }

  function injectOrUpdateStyles() {
    const root = document.head || document.documentElement;
    if (!root) return;

    if (isDisabled) {
      const coreEl = document.getElementById("b-ad-v5-core-style");
      const custEl = document.getElementById("b-ad-v5-custom-style");
      if (coreEl) coreEl.remove();
      if (custEl) custEl.remove();
      return;
    }

    // 1. Core stylesheet (Ads + optional GDPR Cookie Cleaner)
    let coreStyle = document.getElementById("b-ad-v5-core-style");
    if (!coreStyle) {
      coreStyle = document.createElement("style");
      coreStyle.id = "b-ad-v5-core-style";
      root.appendChild(coreStyle);
    }
    const coreSelectors = settings.cookieCleaner !== false
      ? [...AD_SELECTORS, ...COOKIE_ANNOYANCE_SELECTORS]
      : [...AD_SELECTORS];

    coreStyle.textContent = `${coreSelectors.join(",\n")} {\n  display: none !important;\n  visibility: hidden !important;\n  pointer-events: none !important;\n  opacity: 0 !important;\n}`;

    // 2. Isolated Custom Selectors stylesheet (each selector in its own rule block)
    let customStyle = document.getElementById("b-ad-v5-custom-style");
    if (validCustomSelectors.length > 0) {
      if (!customStyle) {
        customStyle = document.createElement("style");
        customStyle.id = "b-ad-v5-custom-style";
        root.appendChild(customStyle);
      }
      customStyle.textContent = validCustomSelectors
        .map(s => `${s} { display: none !important; visibility: hidden !important; pointer-events: none !important; }`)
        .join("\n");
    } else if (customStyle) {
      customStyle.remove();
    }
  }

  function scanSubtree(root) {
    if (isDisabled || !root || !root.querySelectorAll) return;

    // 1. Scan Ad Selectors in a single combined query pass
    try {
      if (root.nodeType === 1 && root.matches && root.matches(combinedAdSelector)) {
        processElement(root, "ad");
      }
      const adMatches = root.querySelectorAll(combinedAdSelector);
      for (let i = 0; i < adMatches.length; i++) {
        processElement(adMatches[i], "ad");
      }
    } catch (_) {}

    // 2. Scan GDPR Cookie Annoyances if enabled
    if (settings.cookieCleaner !== false) {
      try {
        if (root.nodeType === 1 && root.matches && root.matches(combinedCookieSelector)) {
          processElement(root, "cookie");
        }
        const cookieMatches = root.querySelectorAll(combinedCookieSelector);
        for (let i = 0; i < cookieMatches.length; i++) {
          processElement(cookieMatches[i], "cookie");
        }
      } catch (_) {}
    }

    // 3. Scan User Custom Selectors
    if (validCustomSelectors.length > 0) {
      const joinedCustom = validCustomSelectors.join(",");
      try {
        if (root.nodeType === 1 && root.matches && root.matches(joinedCustom)) {
          processElement(root, "ad");
        }
        const customMatches = root.querySelectorAll(joinedCustom);
        for (let i = 0; i < customMatches.length; i++) {
          processElement(customMatches[i], "ad");
        }
      } catch (_) {
        for (const sel of validCustomSelectors) {
          try {
            root.querySelectorAll(sel).forEach(el => processElement(el, "ad"));
          } catch (_) {}
        }
      }
    }
  }

  function schedulePendingScan() {
    if (rafScheduled || isDisabled) return;
    rafScheduled = true;
    requestAnimationFrame(() => {
      rafScheduled = false;
      if (isDisabled) {
        pendingMutationRoots.clear();
        return;
      }
      const roots = Array.from(pendingMutationRoots);
      pendingMutationRoots.clear();
      for (const node of roots) {
        if (node && node.isConnected) {
          scanSubtree(node);
        }
      }
    });
  }

  function startObserver() {
    if (!document.documentElement) return;
    const obs = new MutationObserver(mutations => {
      if (isDisabled) return;
      const mode = getCurrentMode();

      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node.nodeType !== 1) continue;

          if (node.tagName === "SCRIPT" && mode === "normal" && node.src) {
            if (TRACKER_PATTERNS.some(p => p.test(node.src))) {
              if (!processedNodes.has(node)) {
                processedNodes.add(node);
                node.type = "javascript/blocked";
                try { node.remove(); } catch (_) {}
                queueTelemetry(node.src, "tracker", 1);
              }
              continue;
            }
          }

          pendingMutationRoots.add(node);
          if (node.shadowRoot) {
            pendingMutationRoots.add(node.shadowRoot);
          }
        }
      }

      if (pendingMutationRoots.size > 0) {
        schedulePendingScan();
      }
    });

    obs.observe(document.documentElement, { childList: true, subtree: true });
  }

  // Live storage listener so custom selectors and pause toggles apply immediately
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      loadConfiguration().then(paused => {
        isDisabled = paused;
        injectOrUpdateStyles();
        if (!isDisabled && document.body) {
          scanSubtree(document.body);
        }
      });
    });
  } catch (_) {}

  async function boot() {
    isDisabled = await loadConfiguration();
    if (isDisabled) return;

    injectOrUpdateStyles();
    scanSubtree(document.body || document.documentElement);
    startObserver();

    // Deferred post-hydration passes for lazy-rendered ad slots
    setTimeout(() => !isDisabled && scanSubtree(document.body), 1000);
    setTimeout(() => !isDisabled && scanSubtree(document.body), 3000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();
