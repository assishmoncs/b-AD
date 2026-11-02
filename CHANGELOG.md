# Changelog

## 6.0.0

- Connected the tracking-link switch to its own network ruleset and made DNR failures visible to the user.
- Fixed pause/resume so cosmetic hiding is reversible and scanning starts after resuming a page that began paused.
- Replaced debug-only network counters and speculative savings with measured page-action counts. Historical v5 activity counters reset on upgrade; custom rules and user settings remain.
- Made stealth helpers, consent-overlay hiding, and SponsorBlock opt-in for new installs. Removed fake successful network responses, advertising SDK stubs, and console suppression.
- Updated the popup and Settings UI with clearer controls, responsive layout, keyboard navigation, error feedback, and privacy wording.
- Added configuration tests and validation for custom domain rules and paused sites.
- During upgrade, legacy `*://domain/*` network filters are converted to `||domain^`; unsupported legacy filters are removed.

## 5.0.0

Previous release.
