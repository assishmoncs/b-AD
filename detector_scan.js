/**
 * b-AD Ultra v5.0 Enterprise — Anti-Adblock Detector & Mode Scanner
 * ---------------------------------------------------------------------------
 * Runs in ISOLATED world at document_start.
 * Classifies whether the current host requires Stealth Evasion Mode or Normal
 * Strict Mode, and synchronizes mode state with the MAIN-world stealth script
 * via DOM dataset attributes (`document.documentElement.dataset.badMode`).
 */

(function () {
  "use strict";

  const STEALTH_DOMAINS = [
    "youtube.com", "twitch.tv", "forbes.com", "wired.com",
    "theatlantic.com", "businessinsider.com", "mirror.co.uk",
    "independent.co.uk", "hulu.com", "dailymotion.com",
    "espn.com", "bleacherreport.com", "cbssports.com",
    "nytimes.com", "washingtonpost.com", "bloomberg.com",
    "Reuters.com".toLowerCase(), "cnbc.com", "fandom.com"
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
    /blockadblock/i,
    /adngin/i,
    /admiral/i,
    /detect.*adblock/i,
    /adblock.*detect/i,
    /pagead\/js/i,
    /checkAdBlock/i,
    /isAdBlocked/i,
    /adBlockCheck/i,
    /window\.canRunAds/i,
    /google_jobrunner/i
  ];

  const cleanHost = (location.hostname || "").replace(/^www\./, "").toLowerCase();

  function isDomainStealthRequired() {
    if (!cleanHost) return false;
    return STEALTH_DOMAINS.some(d => cleanHost === d || cleanHost.endsWith("." + d));
  }

  function scanText(text) {
    if (!text || text.length > 250000) return false;
    return DETECTION_PATTERNS.some(p => p.test(text));
  }

  function scanExistingScripts() {
    try {
      const scripts = document.querySelectorAll("script");
      for (const s of scripts) {
        if (s.src && /fuckadblock|blockadblock|adngin|blockthrough|admiral/i.test(s.src)) {
          return true;
        }
        if (s.textContent && scanText(s.textContent)) {
          return true;
        }
      }
    } catch (_) {}
    return false;
  }

  function applyMode(mode) {
    window.__bAD = window.__bAD || {};
    window.__bAD.mode = mode;
    window.__bAD.version = "5.0.0";
    try {
      if (document.documentElement) {
        document.documentElement.dataset.badMode = mode;
      }
      window.dispatchEvent(new CustomEvent("__bAD_MODE_UPDATE__", { detail: { mode } }));
    } catch (_) {}
  }

  let stealthNeeded = isDomainStealthRequired() || scanExistingScripts();
  applyMode(stealthNeeded ? "stealth" : "normal");

  if (!stealthNeeded && document.documentElement) {
    const obs = new MutationObserver(mutations => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node.nodeType !== 1 || node.tagName !== "SCRIPT") continue;
          if (
            (node.src && /fuckadblock|blockadblock|adngin|blockthrough|admiral/i.test(node.src)) ||
            (node.textContent && scanText(node.textContent))
          ) {
            stealthNeeded = true;
            applyMode("stealth");
            obs.disconnect();
            return;
          }
        }
      }
    });

    obs.observe(document.documentElement, { childList: true, subtree: true });
    setTimeout(() => obs.disconnect(), 6000);
  }

  // Sync user settings & whitelist state to MAIN world stealth script
  try {
    chrome.storage.local.get({ globallyDisabled: false, disabledSites: [], settings: { stealthMode: true } }, data => {
      void chrome.runtime.lastError;
      const isWhitelisted = (data.disabledSites || []).some(
        s => cleanHost === s || cleanHost.endsWith("." + s)
      );
      const stealthActive = !data.globallyDisabled && !isWhitelisted && (!data.settings || data.settings.stealthMode !== false);
      if (document.documentElement) {
        document.documentElement.dataset.badStealthActive = stealthActive ? "1" : "0";
      }
    });
  } catch (_) {}

  window.addEventListener("load", () => {
    if (!cleanHost) return;
    try {
      chrome.runtime.sendMessage({
        type: "BAD_MODE_REPORT",
        mode: (window.__bAD && window.__bAD.mode) || "normal",
        host: cleanHost
      }, () => void chrome.runtime.lastError);
    } catch (_) {}
  }, { once: true });
})();
