# b-AD Ultra 6.0

b-AD Ultra is a Chrome Manifest V3 extension for blocking selected ad and tracker domains, hiding common ad elements, managing custom rules, and controlling protection per site.

## Install

1. Open `chrome://extensions` in Chrome 116 or later.
2. Enable **Developer mode** and choose **Load unpacked**.
3. Select this repository folder.
4. Pin b-AD to the toolbar to access the popup.

The extension starts with network blocking, cosmetic ad filtering, YouTube ad controls, and tracking-link cleanup enabled. Stealth helpers, consent-overlay hiding, and SponsorBlock are off by default for new installs. Existing settings are kept during an upgrade.

## Controls

- **Global protection** pauses or resumes both static network rulesets, custom network rules, and page features.
- **Pause site** bypasses b-AD's DNR rules for that site and its subdomains. The popup reloads the tab after the change. If you change paused sites in Settings, reload an open tab to restore its page state.
- **Strip tracking links** controls a separate DNR ruleset that removes common query parameters from top-level navigations.
- **Custom network rules** accept domain filters such as `||ads.example.com^`.
- **Element Zapper** creates a CSS selector that you can remove in Settings. `Ctrl+Shift+Z` (`Command+Shift+Z` on macOS) opens it; `Esc` exits.
- **YouTube controls** try to use available ad skip buttons or accelerate an ad while restoring playback settings afterward. YouTube changes its UI frequently, so this behavior may vary.
- **SponsorBlock** is optional. When enabled, b-AD sends the current YouTube video ID to `sponsor.ajay.app` to retrieve community-submitted skip segments.
- **Stealth helpers** are optional. On selected sites they can change bait element geometry and canvas export output. They do not fake successful network requests or replace advertising SDK globals.

## Activity and privacy

The popup reports page actions observed by the extension: ad elements hidden or ads skipped, consent overlays hidden, SponsorBlock segments skipped, and video seconds skipped. These are not counts of every network request blocked by DNR. Chrome's DNR match debug event is unavailable to a published extension, so b-AD does not claim precise network-block totals or estimated bandwidth savings.

Activity and configuration are stored in `chrome.storage.local`; per-tab activity counts use `chrome.storage.session`. b-AD has no developer analytics endpoint. SponsorBlock is the only built-in external API call, and it is off by default for new installs. Exported JSON backups stay on your computer unless you share them.

The extension requests access to all HTTP/HTTPS sites because it applies network rules and cosmetic filters across the web. The popup's per-site pause is available if a site breaks.

## Development and release checks

Run `npm test` for manifest, rule, state, and DNR-control tests. Run `npm run smoke` for an isolated Chrome test of the UI, network rule controls, and cosmetic pause/resume. The extension has no runtime package dependencies. Before publishing, manually check YouTube playback, custom rule errors, and a service-worker restart. Run `git diff --check` and `npm run package` to create a release ZIP containing only runtime files and icons.

## Files

- `manifest.json`: permissions, content scripts, commands, and DNR resources.
- `rules.json`: 74 built-in network blocking rules.
- `tracking_rules.json`: 36 optional tracking-parameter rules.
- `background.js`: settings, DNR synchronization, and activity storage.
- `content.js`, `detector_scan.js`, `stealth_mode.js`, `youtube_engine.js`, `zapper.js`: page features.
- `popup.*`, `options.*`: user interface.

See [CHANGELOG.md](CHANGELOG.md) for migration notes. Licensed under MIT; see [LICENSE](LICENSE).
