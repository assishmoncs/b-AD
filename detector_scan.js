(function () {
  "use strict";

  const STEALTH_DOMAINS = [
    "youtube.com", "twitch.tv", "forbes.com", "wired.com",
    "theatlantic.com", "businessinsider.com", "mirror.co.uk",
    "independent.co.uk", "hulu.com", "dailymotion.com",
    "espn.com", "bleacherreport.com", "cbssports.com"
  ];

  const DETECTION_PATTERNS = [
    /adsbox/i,
    /ad[-_]?banner/i,
    /ad[-_]?container/i,
    /adblock/i,
    /adBlockEnabled/i,
    /offsetHeight\s*[=<>!]+\s*0/,
    /getComputedStyle.*display.*none/i,
    /document\.getElementById.*ad/i,
    /blockthrough/i,
    /fuckadblock/i,
    /adngin/i,
    /detect.*adblock/i,
    /adblock.*detect/i,
    /pagead\/js/i,
    /checkAdBlock/i,
    /isAdBlocked/i,
    /adBlockCheck/i,
    /window\.canRunAds/i,
    /google_jobrunner/i
  ];

  function isDomainStealthRequired() {
    const host = location.hostname.replace(/^www\./, "");
    return STEALTH_DOMAINS.some(d => host === d || host.endsWith("." + d));
  }

  function scanText(text) {
    return DETECTION_PATTERNS.some(p => p.test(text));
  }

  function scanExistingScripts() {
    const scripts = document.querySelectorAll("script");
    for (const s of scripts) {
      if (s.textContent && scanText(s.textContent)) return true;
    }
    return false;
  }

  let stealthNeeded = isDomainStealthRequired() || scanExistingScripts();

  window.__bAD = {
    mode: stealthNeeded ? "stealth" : "normal",
    version: "3.0.0"
  };

  if (!stealthNeeded) {
    const obs = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node.nodeType !== 1) continue;
          if (node.tagName === "SCRIPT") {
            if (node.src && /fuckadblock|adngin|blockthrough/i.test(node.src)) {
              window.__bAD.mode = "stealth";
              obs.disconnect();
              return;
            }
            if (node.textContent && scanText(node.textContent)) {
              window.__bAD.mode = "stealth";
              obs.disconnect();
              return;
            }
          }
        }
      }
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });
    setTimeout(() => obs.disconnect(), 6000);
  }

  window.addEventListener("load", () => {
    try {
      chrome.runtime.sendMessage({
        type: "BAD_MODE_REPORT",
        mode: window.__bAD.mode,
        host: location.hostname
      });
    } catch (_) {}
  }, { once: true });
})();
