/**
 * b-AD Ultra v5.0 Enterprise — MAIN World Stealth & Anti-Fingerprinting Engine
 * ---------------------------------------------------------------------------
 * Executed in MAIN world at document_start (configured in manifest.json).
 * Capabilities:
 * 1. Spoofs global ad-SDK objects (Google Publisher Tag, AdSense, Prebid.js,
 *    FuckAdBlock / BlockAdBlock / Admiral bait globals) in the actual page context.
 * 2. Intercepts anti-adblock XHR & Fetch probes and dispatches spec-compliant
 *    Event / ProgressEvent callbacks so addEventListener("load") checks pass.
 * 3. Spoofs bait DOM geometry (offsetHeight, offsetWidth, clientHeight,
 *    getBoundingClientRect) and getComputedStyle for bait elements.
 * 4. Non-destructive offscreen Canvas fingerprint noise protection (never mutates
 *    visible on-screen canvas pixels).
 */

(function () {
  "use strict";

  if (window.__bAD_Stealth_Initialized__) return;
  Object.defineProperty(window, "__bAD_Stealth_Initialized__", {
    value: true,
    configurable: false,
    enumerable: false,
    writable: false
  });

  function isStealthEnabled() {
    try {
      const root = document.documentElement;
      if (root && root.dataset && root.dataset.badStealthActive === "0") {
        return false;
      }
    } catch (_) {}
    return true;
  }

  const AD_PING_PATTERNS = [
    /pagead\/js\/adsbygoogle/i,
    /pagead2\.googlesyndication\.com/i,
    /doubleclick\.net\/pagead/i,
    /adservice\.google\./i,
    /fuckadblock/i,
    /blockadblock/i,
    /blockthrough/i,
    /adngin/i,
    /getadmiral\.com/i,
    /fundingchoicesmessages\.google\.com/i
  ];

  const BAIT_CLASS_TOKENS = [
    "adsbox",
    "ad-placement",
    "ad-placeholder",
    "ad-banner",
    "text-ad",
    "pub_300x250",
    "pub_728x90",
    "doubleclick",
    "ad-tester"
  ];

  function matchesPing(url) {
    if (!url || !isStealthEnabled()) return false;
    const str = String(url);
    return AD_PING_PATTERNS.some(p => p.test(str));
  }

  function isBaitElement(el) {
    if (!el || el.nodeType !== 1 || !isStealthEnabled()) return false;
    const cls = typeof el.className === "string" ? el.className.toLowerCase() : "";
    const id = typeof el.id === "string" ? el.id.toLowerCase() : "";
    if (!cls && !id) return false;
    return BAIT_CLASS_TOKENS.some(token => cls.includes(token) || id.includes(token));
  }

  function defineSafeGlobal(name, value) {
    if (typeof window[name] !== "undefined") return;
    try {
      let current = value;
      Object.defineProperty(window, name, {
        get: () => current,
        set: (v) => { current = v; },
        configurable: true,
        enumerable: true
      });
    } catch (_) {}
  }

  // Mock common ad SDK stub objects so publisher scripts don't throw ReferenceErrors
  const noop = function () {};
  const chainNoop = function () { return this; };

  const mockSlot = {
    addService: chainNoop,
    clearCategoryExclusions: chainNoop,
    clearTargeting: chainNoop,
    defineSizeMapping: chainNoop,
    get: () => null,
    getAdUnitPath: () => "",
    getAttributeKeys: () => [],
    getCategoryExclusions: () => [],
    getDomId: () => "",
    getResponseInformation: () => null,
    getSlotElementId: () => "",
    getTargeting: () => [],
    getTargetingKeys: () => [],
    set: chainNoop,
    setCategoryExclusion: chainNoop,
    setClickUrl: chainNoop,
    setCollapseEmptyDiv: chainNoop,
    setSafeFrameConfig: chainNoop,
    setTargeting: chainNoop
  };

  const mockPubAds = {
    addEventListener: chainNoop,
    clear: noop,
    clearCategoryExclusions: chainNoop,
    clearTagForChildDirectedTreatment: chainNoop,
    clearTargeting: chainNoop,
    collapseEmptyDivs: noop,
    defineOutOfPagePassback: () => mockSlot,
    definePassback: () => mockSlot,
    disableInitialLoad: noop,
    display: noop,
    enableAsyncRendering: noop,
    enableSingleRequest: noop,
    enableSyncRendering: noop,
    enableVideoAds: noop,
    get: () => null,
    getAttributeKeys: () => [],
    getSlots: () => [],
    getTargeting: () => [],
    getTargetingKeys: () => [],
    isInitialLoadDisabled: () => false,
    refresh: noop,
    removeEventListener: chainNoop,
    set: chainNoop,
    setCategoryExclusion: chainNoop,
    setCentering: noop,
    setCookieOptions: chainNoop,
    setForceSafeFrame: chainNoop,
    setLocation: chainNoop,
    setPublisherProvidedId: chainNoop,
    setRequestNonPersonalizedAds: chainNoop,
    setSafeFrameConfig: chainNoop,
    setTagForChildDirectedTreatment: chainNoop,
    setTargeting: chainNoop,
    setVideoContent: chainNoop,
    updateCorrelator: noop
  };

  const cmdQueue = [];
  cmdQueue.push = function (...fns) {
    for (const fn of fns) {
      if (typeof fn === "function") {
        try { setTimeout(fn, 0); } catch (_) {}
      }
    }
    return Array.prototype.push.apply(this, fns);
  };

  defineSafeGlobal("canRunAds", true);
  defineSafeGlobal("isAdBlockActive", false);
  defineSafeGlobal("adBlockEnabled", false);
  defineSafeGlobal("adblock", false);
  defineSafeGlobal("google_jobrunner", true);
  defineSafeGlobal("google_ad_status", 1);
  defineSafeGlobal("adsbygoogle", { loaded: true, push: noop });
  defineSafeGlobal("googletag", {
    cmd: cmdQueue,
    apiReady: true,
    pubadsReady: true,
    companionAds: () => ({ addEventListener: chainNoop, setRefreshUnfilledSlots: noop }),
    content: () => ({ addEventListener: chainNoop, setContent: noop }),
    defineOutOfPageSlot: () => mockSlot,
    defineSlot: () => mockSlot,
    destroySlots: () => true,
    disablePublisherConsole: noop,
    display: noop,
    enableServices: noop,
    getVersion: () => "5.0",
    pubads: () => mockPubAds,
    setAdIframeTitle: noop,
    sizeMapping: () => ({ addSize: chainNoop, build: () => [] })
  });
  defineSafeGlobal("pbjs", {
    que: cmdQueue,
    adUnits: [],
    libLoaded: true,
    getAdserverTargeting: () => ({}),
    getBidResponses: () => ({}),
    requestBids: (opts) => {
      if (opts && typeof opts.bidsBackHandler === "function") {
        try { setTimeout(opts.bidsBackHandler, 1); } catch (_) {}
      }
    },
    setConfig: noop
  });

  /* ==========================================================================
   * 1. XHR Hook with Native Event Dispatch
   * ======================================================================== */
  try {
    const _xhrOpen = XMLHttpRequest.prototype.open;
    const _xhrSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      try {
        this.__bAD_intercepted = matchesPing(url);
      } catch (_) {
        this.__bAD_intercepted = false;
      }
      return _xhrOpen.call(this, method, url, ...rest);
    };

    XMLHttpRequest.prototype.send = function (body) {
      if (this.__bAD_intercepted && isStealthEnabled()) {
        const self = this;
        setTimeout(() => {
          try {
            Object.defineProperty(self, "readyState", { get: () => 4, configurable: true });
            Object.defineProperty(self, "status", { get: () => 200, configurable: true });
            Object.defineProperty(self, "statusText", { get: () => "OK", configurable: true });
            Object.defineProperty(self, "responseText", { get: () => "/* b-AD */", configurable: true });
            Object.defineProperty(self, "response", { get: () => "/* b-AD */", configurable: true });
            self.dispatchEvent(new Event("readystatechange"));
            self.dispatchEvent(new ProgressEvent("load", { loaded: 10, total: 10 }));
            self.dispatchEvent(new ProgressEvent("loadend", { loaded: 10, total: 10 }));
          } catch (_) {}
        }, 1);
        return;
      }
      return _xhrSend.call(this, body);
    };
  } catch (_) {}

  /* ==========================================================================
   * 2. Fetch Hook
   * ======================================================================== */
  try {
    const _fetch = window.fetch;
    if (typeof _fetch === "function") {
      window.fetch = function (input, init) {
        try {
          const url = typeof input === "string"
            ? input
            : (input && typeof input.url === "string" ? input.url : "");
          if (matchesPing(url)) {
            return Promise.resolve(
              new Response("/* b-AD ok */", {
                status: 200,
                statusText: "OK",
                headers: { "Content-Type": "application/javascript" }
              })
            );
          }
        } catch (_) {}
        return _fetch.call(this, input, init);
      };
    }
  } catch (_) {}

  /* ==========================================================================
   * 3. Bait Element Geometry & ComputedStyle Spoofing
   * ======================================================================== */
  try {
    const props = ["offsetHeight", "offsetWidth", "clientHeight", "clientWidth"];
    for (const prop of props) {
      const desc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, prop);
      if (desc && typeof desc.get === "function") {
        Object.defineProperty(HTMLElement.prototype, prop, {
          get() {
            const real = desc.get.call(this);
            if (real === 0 && isBaitElement(this)) {
              return prop.includes("Width") ? 300 : 250;
            }
            return real;
          },
          configurable: true
        });
      }
    }

    const _getComputedStyle = window.getComputedStyle;
    if (typeof _getComputedStyle === "function") {
      window.getComputedStyle = function (el, pseudo) {
        const style = _getComputedStyle.call(window, el, pseudo);
        if (!pseudo && isBaitElement(el)) {
          return new Proxy(style, {
            get(target, prop) {
              if (prop === "display") return "block";
              if (prop === "visibility") return "visible";
              if (prop === "opacity") return "1";
              if (prop === "getPropertyValue") {
                return (name) => {
                  if (name === "display") return "block";
                  if (name === "visibility") return "visible";
                  if (name === "opacity") return "1";
                  return target.getPropertyValue(name);
                };
              }
              const val = Reflect.get(target, prop);
              return typeof val === "function" ? val.bind(target) : val;
            }
          });
        }
        return style;
      };
    }
  } catch (_) {}

  /* ==========================================================================
   * 4. Non-Destructive Offscreen Canvas Fingerprint Protection
   * ======================================================================== */
  try {
    const sessionNoise = (Math.floor(Math.random() * 5) + 1);
    const _toDataURL = HTMLCanvasElement.prototype.toDataURL;

    HTMLCanvasElement.prototype.toDataURL = function (...args) {
      if (!isStealthEnabled() || this.width === 0 || this.height === 0 || this.width > 1200 || this.height > 1200) {
        return _toDataURL.apply(this, args);
      }
      try {
        // Clone onto an offscreen canvas so the visible canvas is never altered
        const clone = document.createElement("canvas");
        clone.width = this.width;
        clone.height = this.height;
        const cloneCtx = clone.getContext("2d");
        if (cloneCtx) {
          cloneCtx.drawImage(this, 0, 0);
          const w = Math.min(this.width, 8);
          const h = Math.min(this.height, 8);
          const imgData = cloneCtx.getImageData(0, 0, w, h);
          if (imgData && imgData.data && imgData.data.length >= 4) {
            imgData.data[0] = (imgData.data[0] + sessionNoise) & 0xff;
            cloneCtx.putImageData(imgData, 0, 0);
            return _toDataURL.apply(clone, args);
          }
        }
      } catch (_) {}
      return _toDataURL.apply(this, args);
    };
  } catch (_) {}

  /* ==========================================================================
   * 5. Console Ad-SDK Noise Filter
   * ======================================================================== */
  try {
    const _consoleError = console.error.bind(console);
    const _consoleWarn = console.warn.bind(console);
    const NOISE_RE = /adsbygoogle|doubleclick|googlesyndication|adservice|ERR_BLOCKED_BY_CLIENT/i;

    console.error = (...args) => {
      if (!isStealthEnabled() || !NOISE_RE.test(args.map(String).join(" "))) {
        _consoleError(...args);
      }
    };
    console.warn = (...args) => {
      if (!isStealthEnabled() || !NOISE_RE.test(args.map(String).join(" "))) {
        _consoleWarn(...args);
      }
    };
  } catch (_) {}
})();
