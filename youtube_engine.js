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
    ".ytp-ad-skip-button-slot button"
  ];

  function notify() {
    try { chrome.runtime.sendMessage({ type: "BAD_BLOCKED", url: "youtube.com", kind: "ad" }); } catch (_) {}
  }

  function injectStyles() {
    if (document.getElementById("b-ad-yt-v3")) return;
    const s = document.createElement("style");
    s.id = "b-ad-yt-v3";
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

  function handleAd() {
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
    YT_HIDE_SELECTORS.forEach(sel => {
      try {
        document.querySelectorAll(sel).forEach(el => {
          el.style.setProperty("display", "none", "important");
        });
      } catch (_) {}
    });
  }

  function startObserver() {
    const obs = new MutationObserver(() => {
      handleAd();
      hideStaticAds();
    });
    obs.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
  }

  const fastInterval = setInterval(() => {
    handleAd();
    hideStaticAds();
  }, 300);

  setTimeout(() => {
    clearInterval(fastInterval);
    setInterval(() => {
      handleAd();
      hideStaticAds();
    }, 1000);
  }, 20000);

  injectStyles();
  hideStaticAds();
  startObserver();
})();
