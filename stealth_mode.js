(function () {
  "use strict";

  const AD_PING_PATTERNS = [
    /pagead\/js\/adsbygoogle/,
    /doubleclick\.net/,
    /googlesyndication\.com/,
    /adservice\.google/,
    /fuckadblock/i,
    /blockthrough/i,
    /adngin/i,
    /pagead2\.googlesyndication/
  ];

  function matchesPing(url) {
    return AD_PING_PATTERNS.some(p => p.test(String(url)));
  }

  function defineIfAbsent(name, value) {
    if (typeof window[name] === "undefined") {
      try {
        Object.defineProperty(window, name, { get: () => value, configurable: true });
      } catch (_) {}
    }
  }

  defineIfAbsent("canRunAds", true);
  defineIfAbsent("google_jobrunner", true);
  defineIfAbsent("adsbygoogle", { loaded: true, push: () => {} });
  defineIfAbsent("googletag", { cmd: [], apiReady: true });
  defineIfAbsent("pbjs", { que: [], adUnits: [] });
  defineIfAbsent("adblock", false);
  defineIfAbsent("adBlockEnabled", false);
  defineIfAbsent("isAdBlockActive", false);

  // XHR Hook
  const _xhrOpen = XMLHttpRequest.prototype.open;
  const _xhrSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...args) {
    this.__blocked = matchesPing(url);
    return _xhrOpen.apply(this, [method, url, ...args]);
  };

  XMLHttpRequest.prototype.send = function (body) {
    if (this.__blocked) {
      setTimeout(() => {
        try {
          Object.defineProperty(this, "readyState",   { get: () => 4 });
          Object.defineProperty(this, "status",       { get: () => 200 });
          Object.defineProperty(this, "responseText", { get: () => "" });
          Object.defineProperty(this, "response",     { get: () => "" });
          if (typeof this.onreadystatechange === "function") this.onreadystatechange();
          if (typeof this.onload === "function") this.onload();
        } catch (_) {}
      }, 1);
      return;
    }
    return _xhrSend.apply(this, [body]);
  };

  // Fetch Hook
  const _fetch = window.fetch;
  window.fetch = function (input, init) {
    const url = typeof input === "string" ? input : (input && input.url) || "";
    if (matchesPing(url)) {
      return Promise.resolve(new Response("", { status: 200 }));
    }
    return _fetch.apply(this, [input, init]);
  };

  // Height Check Bait Spoofing
  const _ohDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
  if (_ohDesc && _ohDesc.get) {
    const BAIT = ["adsbox", "ad-placement", "ad-placeholder", "doubleclick"];
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
      get() {
        const real = _ohDesc.get.call(this);
        if (real === 0) {
          const cls = typeof this.className === "string" ? this.className : "";
          if (BAIT.some(c => cls.includes(c))) return 1;
        }
        return real;
      },
      configurable: true
    });
  }

  // Canvas Fingerprint Protection
  try {
    const _toDataURL = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = function (...args) {
      const ctx = this.getContext("2d");
      if (ctx) {
        try {
          const imgData = ctx.getImageData(0, 0, Math.min(this.width, 10), Math.min(this.height, 10));
          if (imgData.data.length > 0) {
            imgData.data[0] = (imgData.data[0] + 1) % 255;
            ctx.putImageData(imgData, 0, 0);
          }
        } catch (_) {}
      }
      return _toDataURL.apply(this, args);
    };
  } catch (_) {}

  // Suppress AdBlock Error Noise
  const _consoleError = console.error.bind(console);
  const _consoleWarn  = console.warn.bind(console);
  const NOISE_RE = /adsbygoogle|doubleclick|googlesyndication|adservice|adblock/i;

  console.error = (...a) => { if (!NOISE_RE.test(a.join(" "))) _consoleError(...a); };
  console.warn  = (...a) => { if (!NOISE_RE.test(a.join(" "))) _consoleWarn(...a); };
})();
