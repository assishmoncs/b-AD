(function () {
  "use strict";

  if (!location.hostname.includes("youtube.com")) return;

  const YT_HIDE_SELECTORS = [
    "ytd-display-ad-renderer",
    "ytd-promoted-video-renderer",
    "ytd-promoted-sparkles-web-renderer",
    "ytd-ad-slot-renderer",
    "ytd-in-feed-ad-layout-renderer",
    "ytd-banner-promo-renderer",
    "ytd-statement-banner-renderer",
    "ytd-companion-slot-renderer",
    "ytd-reel-shelf-renderer[is-ad]",
    "ytd-player-legacy-desktop-watch-ads-renderer",
    "#masthead-ad",
    "#player-ads",
    ".video-ads",
    ".ytp-ad-module",
    ".ytp-ad-overlay-container",
    ".ytp-ad-text-overlay",
    ".ytp-ad-image-overlay",
    ".ytp-ad-progress",
    ".ytp-ad-progress-list"
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
  let currentVideoId = "";
  let sponsorSegments = [];

  function checkDisabledStatus() {
    return new Promise(res => {
      try {
        chrome.storage.local.get({ globallyDisabled: false, disabledSites: [] }, stats => {
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

  function notify() {
    if (isDisabled) return;
    try {
      chrome.runtime.sendMessage({ type: "BAD_BLOCKED", url: "youtube.com", kind: "ad" });
    } catch (_) {}
  }

  function injectStyles() {
    if (document.getElementById("b-ad-yt-v4")) return;
    const s = document.createElement("style");
    s.id = "b-ad-yt-v4";
    s.textContent = YT_HIDE_SELECTORS.join(",\n") + "{\ndisplay:none!important;\nvisibility:hidden!important;\n}";
    (document.head || document.documentElement).appendChild(s);
  }

  function getVideo() {
    return document.querySelector("video.html5-main-video") || document.querySelector("video");
  }

  function isAdPlaying() {
    const player = document.querySelector(".html5-video-player");
    return player && (player.classList.contains("ad-showing") || player.classList.contains("ad-interrupting"));
  }

  function trySkip() {
    if (isDisabled) return false;
    for (const sel of SKIP_SELECTORS) {
      const btn = document.querySelector(sel);
      if (btn) {
        btn.click();
        notify();
        return true;
      }
    }
    return false;
  }

  function skipByTime() {
    if (isDisabled) return false;
    const video = getVideo();
    if (!video) return false;
    if (isAdPlaying() && isFinite(video.duration) && video.duration > 0) {
      video.muted = true;
      video.currentTime = video.duration;
      notify();
      return true;
    }
    return false;
  }

  function restoreAudio() {
    const video = getVideo();
    if (video && video.muted && !isAdPlaying()) {
      video.muted = false;
    }
  }

  // SponsorBlock API Integration
  async function fetchSponsorSegments(videoId) {
    if (!videoId || videoId === currentVideoId) return;
    currentVideoId = videoId;
    sponsorSegments = [];
    try {
      const categories = '["sponsor","selfpromo","interaction","intro","outro"]';
      const url = `https://sponsor.ajay.app/api/skipSegments?videoID=${videoId}&categories=${encodeURIComponent(categories)}`;
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data)) {
          sponsorSegments = data.map(item => item.segment);
        }
      }
    } catch (_) {}
  }

  function checkSponsorBlock() {
    if (isDisabled || !sponsorSegments.length) return;
    const video = getVideo();
    if (!video || isAdPlaying()) return;

    const curTime = video.currentTime;
    for (const [start, end] of sponsorSegments) {
      if (curTime >= start && curTime < end - 0.5) {
        video.currentTime = end;
        notify();
        break;
      }
    }
  }

  function checkShortsAd() {
    if (isDisabled) return;
    if (location.pathname.includes("/shorts/")) {
      const activeShort = document.querySelector("ytd-reel-video-renderer[is-active]");
      if (activeShort && (activeShort.querySelector("[is-ad]") || activeShort.querySelector(".ytd-ad-slot-renderer"))) {
        const nextBtn = document.querySelector("#navigation-button-down button") || document.querySelector("button.ytd-shorts");
        if (nextBtn) {
          nextBtn.click();
          notify();
        }
      }
    }
  }

  function handleAd() {
    if (isDisabled) return;
    checkShortsAd();
    checkSponsorBlock();

    if (!isAdPlaying()) {
      restoreAudio();
      return;
    }
    if (trySkip()) return;
    skipByTime();

    setTimeout(() => {
      trySkip();
      skipByTime();
    }, 100);

    setTimeout(() => {
      if (isAdPlaying()) {
        const video = getVideo();
        if (video) {
          video.muted = true;
          video.playbackRate = 16;
        }
      }
    }, 300);

    setTimeout(() => {
      if (!isAdPlaying()) {
        const video = getVideo();
        if (video) {
          video.muted = false;
          video.playbackRate = 1;
        }
      }
    }, 1200);
  }

  function hideStaticAds() {
    if (isDisabled) return;
    YT_HIDE_SELECTORS.forEach(sel => {
      try {
        document.querySelectorAll(sel).forEach(el => {
          el.style.setProperty("display", "none", "important");
        });
      } catch (_) {}
    });
  }

  function watchURLChanges() {
    let lastUrl = location.href;
    setInterval(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        const u = new URL(location.href);
        const v = u.searchParams.get("v");
        if (v) fetchSponsorSegments(v);
      }
    }, 1000);

    const u = new URL(location.href);
    const v = u.searchParams.get("v");
    if (v) fetchSponsorSegments(v);
  }

  async function init() {
    isDisabled = await checkDisabledStatus();
    if (isDisabled) return;

    injectStyles();
    hideStaticAds();
    watchURLChanges();

    setInterval(() => {
      if (isDisabled) return;
      handleAd();
      hideStaticAds();
    }, 300);
  }

  init();
})();
