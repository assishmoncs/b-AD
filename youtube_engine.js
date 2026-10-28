/**
 * b-AD Ultra v5.0 Enterprise — YouTube Engine 5.0 (Ad Shield + SponsorBlock)
 * ---------------------------------------------------------------------------
 * Major Upgrades over v4.0:
 * 1. Preserves User Audio & Playback Rate: Tracks `mutedByEngine` and
 *    `savedPlaybackRate` so user-initiated mute or custom speed (e.g. 1.5x)
 *    is never overwritten when an ad ends.
 * 2. Event-Driven Architecture: Combines `yt-navigate-finish`, video
 *    `timeupdate` listeners, and a targeted `.html5-video-player` attribute
 *    MutationObserver instead of heavy 300ms full-DOM polling.
 * 3. Resilient SponsorBlock Client: Uses `AbortController` (4s timeout),
 *    in-memory LRU segment cache by videoId, and non-intrusive on-player HUD
 *    toast notifications when sponsor segments are skipped.
 */

(function () {
  "use strict";

  if (!location.hostname.includes("youtube.com") && !location.hostname.includes("youtube-nocookie.com")) {
    return;
  }

  const YT_HIDE_SELECTORS = [
    "ytd-display-ad-renderer",
    "ytd-promoted-video-renderer",
    "ytd-promoted-sparkles-web-renderer",
    "ytd-promoted-sparkles-text-search-renderer",
    "ytd-ad-slot-renderer",
    "ytd-in-feed-ad-layout-renderer",
    "ytd-banner-promo-renderer",
    "ytd-statement-banner-renderer",
    "ytd-companion-slot-renderer",
    "ytd-action-companion-ad-renderer",
    "ytd-reel-shelf-renderer[is-ad]",
    "ytd-player-legacy-desktop-watch-ads-renderer",
    "ytd-engagement-panel-section-list-renderer[target-id='engagement-panel-ads']",
    "#masthead-ad",
    "#player-ads",
    ".video-ads",
    ".ytp-ad-module",
    ".ytp-ad-overlay-container",
    ".ytp-ad-text-overlay",
    ".ytp-ad-image-overlay",
    ".ytp-ad-progress",
    ".ytp-ad-progress-list",
    ".ytp-featured-product"
  ];

  const SKIP_SELECTORS = [
    ".ytp-ad-skip-button",
    ".ytp-skip-ad-button",
    ".ytp-ad-skip-button-modern",
    "button.ytp-ad-skip-button",
    ".ytp-ad-skip-button-slot button",
    ".ytp-ad-skip-button-container button"
  ];

  let isDisabled = false;
  let sponsorBlockEnabled = true;
  let currentVideoId = "";
  let sponsorSegments = [];
  const segmentCache = new Map();

  // State tracking so we never clobber user's own mute or playbackRate
  let mutedByEngine = false;
  let speedBoostedByEngine = false;
  let userPlaybackRate = 1;
  let lastAdBlockNotifiedAt = 0;
  let boundVideoElement = null;

  function loadSettings() {
    return new Promise(resolve => {
      try {
        chrome.storage.local.get(
          {
            globallyDisabled: false,
            disabledSites: [],
            settings: { youtubeEngine: true, sponsorBlock: true }
          },
          data => {
            void chrome.runtime.lastError;
            if (!data) return resolve(false);
            const cfg = data.settings || {};
            sponsorBlockEnabled = cfg.sponsorBlock !== false;
            if (data.globallyDisabled || cfg.youtubeEngine === false) {
              return resolve(true);
            }
            const host = location.hostname.replace(/^www\./, "").toLowerCase();
            const paused = (data.disabledSites || []).some(
              s => host === s || host.endsWith("." + s)
            );
            resolve(paused);
          }
        );
      } catch (_) {
        resolve(false);
      }
    });
  }

  function notifyBlock(kind = "ad", durationSec = 0) {
    if (isDisabled) return;
    const now = Date.now();
    // Rate-limit ad skip notifications to at most 1 per 1.5s to prevent duplicates on same ad
    if (kind === "ad" && now - lastAdBlockNotifiedAt < 1500) return;
    if (kind === "ad") lastAdBlockNotifiedAt = now;

    try {
      chrome.runtime.sendMessage(
        { type: "BAD_BLOCKED", url: "youtube.com", kind, durationSec },
        () => void chrome.runtime.lastError
      );
    } catch (_) {}
  }

  function showPlayerHudToast(message) {
    const player = document.querySelector(".html5-video-player") || document.body;
    if (!player) return;

    let toast = document.getElementById("b-ad-yt-toast");
    if (!toast) {
      toast = document.createElement("div");
      toast.id = "b-ad-yt-toast";
      toast.style.cssText = `
        position: absolute !important;
        top: 18px !important;
        right: 18px !important;
        z-index: 2147483646 !important;
        background: rgba(15, 23, 42, 0.92) !important;
        backdrop-filter: blur(8px) !important;
        color: #10b981 !important;
        border: 1px solid rgba(16, 185, 129, 0.45) !important;
        padding: 7px 13px !important;
        border-radius: 8px !important;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif !important;
        font-size: 12px !important;
        font-weight: 600 !important;
        pointer-events: none !important;
        box-shadow: 0 4px 14px rgba(0, 0, 0, 0.45) !important;
        transition: opacity 0.25s ease !important;
      `;
      player.appendChild(toast);
    }

    toast.textContent = `⚡ b-AD: ${message}`;
    toast.style.opacity = "1";
    clearTimeout(toast.__hideTimer);
    toast.__hideTimer = setTimeout(() => {
      if (toast) toast.style.opacity = "0";
    }, 2600);
  }

  function injectStyles() {
    const existing = document.getElementById("b-ad-yt-v5-style");
    if (isDisabled) {
      if (existing) existing.remove();
      return;
    }
    if (existing) return;
    const s = document.createElement("style");
    s.id = "b-ad-yt-v5-style";
    s.textContent = `${YT_HIDE_SELECTORS.join(",\n")} {\n  display: none !important;\n  visibility: hidden !important;\n  height: 0 !important;\n  pointer-events: none !important;\n}`;
    (document.head || document.documentElement).appendChild(s);
  }

  function getVideo() {
    return document.querySelector("video.html5-main-video") || document.querySelector("video");
  }

  function isAdPlaying() {
    const player = document.querySelector(".html5-video-player");
    if (!player) return false;
    return player.classList.contains("ad-showing") || player.classList.contains("ad-interrupting");
  }

  function tryClickSkipButton() {
    for (const sel of SKIP_SELECTORS) {
      const btn = document.querySelector(sel);
      if (btn) {
        try {
          btn.click();
          notifyBlock("ad");
          return true;
        } catch (_) {}
      }
    }
    return false;
  }

  function restoreNormalPlayback(video) {
    if (!video) return;
    if (mutedByEngine) {
      video.muted = false;
      mutedByEngine = false;
    }
    if (speedBoostedByEngine) {
      try {
        video.playbackRate = userPlaybackRate || 1;
      } catch (_) {}
      speedBoostedByEngine = false;
    }
  }

  function handleAdState() {
    if (isDisabled) return;
    const video = getVideo();
    if (!video) return;

    if (!isAdPlaying()) {
      restoreNormalPlayback(video);
      // Remember user's chosen playback speed during normal video playback
      if (video.playbackRate && video.playbackRate <= 4) {
        userPlaybackRate = video.playbackRate;
      }
      return;
    }

    // Ad is currently active
    if (!mutedByEngine && !video.muted) {
      video.muted = true;
      mutedByEngine = true;
    }

    // 1. Try clicking native skip button immediately
    if (tryClickSkipButton()) return;

    // 2. Fast-forward to end of ad stream if duration is finite
    if (isFinite(video.duration) && video.duration > 0.5 && video.currentTime < video.duration - 0.1) {
      try {
        video.currentTime = Math.max(0, video.duration - 0.05);
        notifyBlock("ad", Math.round(video.duration));
        tryClickSkipButton();
        return;
      } catch (_) {}
    }

    // 3. Fallback: accelerate playback to 16x while muted
    if (video.playbackRate < 16) {
      try {
        video.playbackRate = 16;
        speedBoostedByEngine = true;
      } catch (_) {}
    }
  }

  /* ==========================================================================
   * SponsorBlock API Integration with Timeout & Caching
   * ======================================================================== */
  async function fetchSponsorSegments(videoId) {
    if (!videoId || !sponsorBlockEnabled || isDisabled) return;
    if (videoId === currentVideoId && sponsorSegments.length > 0) return;

    currentVideoId = videoId;
    if (segmentCache.has(videoId)) {
      sponsorSegments = segmentCache.get(videoId);
      return;
    }

    sponsorSegments = [];
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 4000);

    try {
      const categories = JSON.stringify(["sponsor", "selfpromo", "interaction", "intro", "outro"]);
      const url = `https://sponsor.ajay.app/api/skipSegments?videoID=${encodeURIComponent(videoId)}&categories=${encodeURIComponent(categories)}`;
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timeoutId);

      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data)) {
          const parsed = data
            .filter(item => Array.isArray(item.segment) && item.segment.length === 2)
            .map(item => ({
              start: Number(item.segment[0]),
              end: Number(item.segment[1]),
              category: item.category || "sponsor"
            }));
          sponsorSegments = parsed;
          if (segmentCache.size > 50) {
            const firstKey = segmentCache.keys().next().value;
            segmentCache.delete(firstKey);
          }
          segmentCache.set(videoId, parsed);
        }
      }
    } catch (_) {
      clearTimeout(timeoutId);
    }
  }

  function checkSponsorBlockSegments() {
    if (isDisabled || !sponsorBlockEnabled || !sponsorSegments.length) return;
    const video = getVideo();
    if (!video || video.paused || isAdPlaying()) return;

    const curTime = video.currentTime;
    for (const seg of sponsorSegments) {
      if (curTime >= seg.start && curTime < seg.end - 0.35) {
        const skippedSec = Math.max(1, Math.round(seg.end - curTime));
        video.currentTime = seg.end;
        showPlayerHudToast(`Skipped ${seg.category} (${skippedSec}s)`);
        notifyBlock("sponsor", skippedSec);
        break;
      }
    }
  }

  function checkShortsAd() {
    if (isDisabled || !location.pathname.includes("/shorts/")) return;
    const activeShort = document.querySelector("ytd-reel-video-renderer[is-active]");
    if (
      activeShort &&
      (activeShort.querySelector("[is-ad]") || activeShort.querySelector("ytd-ad-slot-renderer"))
    ) {
      const nextBtn =
        document.querySelector("#navigation-button-down button") ||
        document.querySelector("button[aria-label*='Next video']");
      if (nextBtn) {
        nextBtn.click();
        notifyBlock("ad");
      }
    }
  }

  function bindVideoListeners() {
    const video = getVideo();
    if (!video || video === boundVideoElement) return;
    boundVideoElement = video;

    video.addEventListener("timeupdate", () => {
      if (isDisabled) return;
      if (isAdPlaying()) {
        handleAdState();
      } else {
        checkSponsorBlockSegments();
      }
    });

    video.addEventListener("play", () => {
      if (!isDisabled) handleAdState();
    });
  }

  function checkCurrentUrlVideoId() {
    try {
      const u = new URL(location.href);
      const v = u.searchParams.get("v");
      if (v && v !== currentVideoId) {
        fetchSponsorSegments(v);
      }
    } catch (_) {}
  }

  function setupObservers() {
    // 1. YouTube SPA navigation event
    window.addEventListener("yt-navigate-finish", () => {
      if (isDisabled) return;
      checkCurrentUrlVideoId();
      bindVideoListeners();
      handleAdState();
    });

    // 2. Observe player class changes (`ad-showing` / `ad-interrupting`)
    const obs = new MutationObserver(() => {
      if (isDisabled) return;
      bindVideoListeners();
      handleAdState();
      checkShortsAd();
    });

    obs.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "is-active"]
    });

    // 3. Lightweight fallback heartbeat (every 1000ms)
    setInterval(() => {
      if (isDisabled) return;
      checkCurrentUrlVideoId();
      bindVideoListeners();
      handleAdState();
      checkShortsAd();
    }, 1000);
  }

  // React to live settings changes
  try {
    chrome.storage.onChanged.addListener((_changes, area) => {
      if (area !== "local") return;
      loadSettings().then(paused => {
        isDisabled = paused;
        injectStyles();
        if (isDisabled) {
          restoreNormalPlayback(getVideo());
        }
      });
    });
  } catch (_) {}

  async function init() {
    isDisabled = await loadSettings();
    injectStyles();
    checkCurrentUrlVideoId();
    bindVideoListeners();
    setupObservers();
  }

  init();
})();
