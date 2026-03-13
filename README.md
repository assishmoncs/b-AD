# b-AD v3 — Smart Ad & Tracker Blocker

Chrome Manifest V3 extension. Blocks ads and trackers with automatic mode switching, a dedicated YouTube engine, and a live analytics dashboard.

---

## What b-AD Does

b-AD operates on two layers simultaneously:

**Network layer** — `rules.json` contains 30 `declarativeNetRequest` rules that block requests to known ad and tracker domains before they reach the browser. Zero performance cost.

**DOM layer** — Content scripts scan the page for ad containers and either remove them (Normal Mode) or visually hide them (Stealth Mode) without breaking site layout.

---

## Normal Mode vs Stealth Mode

### Normal Mode
Activated on standard sites with no adblock detection.

- Ad network requests are blocked at the network level
- Ad DOM elements (`ins.adsbygoogle`, `div[data-ad-slot]`, ad iframes, etc.) are removed from the page
- Tracker scripts are blocked from executing
- Maximum effectiveness

### Stealth Mode
Activated automatically when adblock detection is suspected.

**How it is chosen** — `detector_scan.js` runs at `document_start` and checks:
1. A hardcoded list of known detection-heavy sites (YouTube, Twitch, Forbes, Wired, etc.)
2. Inline script content scanned for patterns: `adsbox`, `offsetHeight === 0`, `fuckadblock`, `adBlockEnabled`, `checkAdBlock`, etc.
3. Dynamically injected scripts monitored via `MutationObserver` for the first 6 seconds

**What stealth does** (`stealth_mode.js`):
- Spoofs `window.canRunAds = true`, `window.adsbygoogle.loaded = true`, `window.google_jobrunner = true`
- Intercepts XHR and `fetch` calls to ad-ping URLs and returns fake 200 OK responses
- Patches `HTMLElement.offsetHeight` to return 1 for bait elements (defeats height-check detectors)
- Ad DOM elements are hidden with `visibility:hidden; max-height:1px` instead of deleted, so their dimensions remain non-zero
- Console errors from blocked ad scripts are suppressed

---

## YouTube Ad Skipping (`youtube_engine.js`)

YouTube uses a complex single-page app with aggressive ad injection and adblock detection. b-AD handles it with a dedicated engine:

**Detection** — Polls for `.html5-video-player.ad-showing` and `.html5-video-player.ad-interrupting` every 300 ms.

**Skip sequence** (under 1 second):
1. Immediately attempts to click `.ytp-ad-skip-button` or `.ytp-ad-skip-button-modern`
2. If no skip button, sets `video.currentTime = video.duration` to jump to the end of the ad
3. After 300 ms, if the ad persists: mutes the video and sets `playbackRate = 16`
4. After 1.2 s: restores `muted = false` and `playbackRate = 1` for normal viewing
5. Audio is always restored automatically once the ad ends

**Layout ads** (display ads in feed, masthead, companion) — Hidden via injected CSS using 18 precise YouTube-specific selectors. A `MutationObserver` catches ads injected by YouTube's SPA router on every page navigation.

**Interval strategy** — Checks every 300 ms for the first 20 seconds of a page load (catches pre-roll ads fast), then drops to every 1 second to save CPU during long watch sessions.

---

## File Structure

```
b-ad-extension/
├── manifest.json          MV3 manifest
├── background.js          Service worker — analytics counter
├── content.js             DOM ad handler — normal and stealth paths
├── detector_scan.js       Mode detection — sets window.__bAD.mode
├── stealth_mode.js        XHR/fetch patches, global spoofing
├── youtube_engine.js      YouTube-specific ad skip and hide engine
├── rules.json             30 declarativeNetRequest block rules
├── tracker_list.json      Tracker domain reference
├── popup.html             Analytics dashboard
├── popup.js               Dashboard logic
├── popup.css              Industrial dark-theme styles
├── icons/                 Extension icons (16, 48, 128 px)
└── README.md              This file
```

---

## Installing in Chrome Developer Mode

1. Download and extract the ZIP to a folder on your computer.
2. Open Chrome and navigate to `chrome://extensions`.
3. Enable **Developer mode** using the toggle in the top-right corner.
4. Click **Load unpacked**.
5. Select the extracted `b-ad-extension/` folder.
6. The b-AD icon appears in your Chrome toolbar.
7. Click the icon at any time to view live blocking statistics.

To update rules or add new blocked domains, edit `rules.json`, save, then click the refresh icon next to b-AD on the `chrome://extensions` page.

---

## Privacy

b-AD is entirely local. No data is ever transmitted to any server. All statistics are stored only in your browser via `chrome.storage.local` and can be reset at any time from the popup dashboard.

---

## License

MIT
