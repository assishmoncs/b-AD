"use strict";

let trackerCategories = {};

async function loadTrackerCategories() {
  try {
    const res = await fetch(chrome.runtime.getURL("tracker_list.json"));
    const data = await res.json();
    if (data && Array.isArray(data.trackers)) {
      data.trackers.forEach(t => {
        trackerCategories[t.domain] = t.category || "Tracker";
      });
    }
  } catch (_) {}
}

function fmtNum(n) {
  n = n || 0;
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return String(n);
}

function fmtBytes(b) {
  b = b || 0;
  if (!b) return "0 B";
  const u = ["B", "KB", "MB", "GB"];
  const i = Math.min(Math.floor(Math.log(b) / Math.log(1024)), 3);
  return (b / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1) + " " + u[i];
}

function topEntry(counts) {
  if (!counts) return ["—", 0];
  const entries = Object.entries(counts);
  if (!entries.length) return ["—", 0];
  return entries.sort((a, b) => b[1] - a[1])[0];
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[c]);
}

function getActiveTabHost() {
  return new Promise(res => {
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      if (!tabs[0] || !tabs[0].url) return res("");
      try {
        const u = new URL(tabs[0].url);
        if (u.protocol.startsWith("http")) {
          return res(u.hostname.replace(/^www\./, ""));
        }
        res("");
      } catch (_) {
        res("");
      }
    });
  });
}

function setupTabs() {
  const tabs = document.querySelectorAll(".tab-btn");
  const contents = document.querySelectorAll(".tab-content");

  tabs.forEach(btn => {
    btn.addEventListener("click", () => {
      tabs.forEach(t => t.classList.remove("active"));
      contents.forEach(c => c.classList.remove("active"));

      btn.classList.add("active");
      const targetId = btn.dataset.tab;
      document.getElementById(targetId).classList.add("active");
    });
  });
}

function renderMode(mode, isPausedGlobal, isPausedSite) {
  const card = document.getElementById("statusCard");
  const label = document.getElementById("statusLabel");
  const badge = document.getElementById("modeBadge");

  if (isPausedGlobal) {
    card.className = "status-card paused";
    label.textContent = "PROTECTION PAUSED (GLOBAL)";
    badge.textContent = "DISABLED";
    badge.className = "mode-badge";
    return;
  }

  if (isPausedSite) {
    card.className = "status-card paused";
    label.textContent = "PROTECTION PAUSED (THIS SITE)";
    badge.textContent = "WHITELISTED";
    badge.className = "mode-badge";
    return;
  }

  card.className = "status-card";

  if (mode === "youtube") {
    label.textContent = "YOUTUBE SHIELD ACTIVE";
    badge.textContent = "YT ENGINE";
    badge.className = "mode-badge youtube";
  } else if (mode === "stealth") {
    label.textContent = "STEALTH EVASION ACTIVE";
    badge.textContent = "STEALTH";
    badge.className = "mode-badge stealth";
  } else {
    label.textContent = "PROTECTION ACTIVE";
    badge.textContent = "STRICT";
    badge.className = "mode-badge";
  }
}

function renderDomains(counts, query) {
  const list = document.getElementById("domainsList");
  const cnt = document.getElementById("domainsCount");

  const pairs = Object.entries(counts || {})
    .sort((a, b) => b[1] - a[1])
    .filter(([domain]) => !query || domain.toLowerCase().includes(query.toLowerCase()));

  cnt.textContent = pairs.length;

  if (!pairs.length) {
    list.innerHTML = query
      ? '<div class="domains-empty">No matching domains found.</div>'
      : '<div class="domains-empty">No blocked domains recorded yet.</div>';
    return;
  }

  const max = pairs[0][1];
  list.innerHTML = pairs.slice(0, 30).map(([domain, count], i) => {
    const pct = ((count / max) * 100).toFixed(0);
    const category = trackerCategories[domain] || (domain.includes("ad") ? "Ad Network" : "Tracking Domain");
    return `
      <div class="domain-row">
        <div class="domain-main">
          <div class="domain-info">
            <span class="domain-rank">${i + 1}</span>
            <span class="domain-name">${esc(domain)}</span>
            <span class="domain-tag">${esc(category)}</span>
          </div>
          <span class="domain-count">${fmtNum(count)}</span>
        </div>
        <div class="domain-progress">
          <div class="domain-bar" style="width:${pct}%"></div>
        </div>
      </div>
    `;
  }).join("");
}

async function refresh() {
  const currentHost = await getActiveTabHost();
  document.getElementById("currentHost").textContent = currentHost || "browser internal page";

  chrome.runtime.sendMessage({ type: "GET_STATS" }, stats => {
    if (!stats) return;

    const ads = stats.adsBlocked || 0;
    const trk = stats.trackersBlocked || 0;
    const bw = stats.bandwidthSaved || 0;
    const dc = stats.domainCounts || {};
    const siteModes = stats.siteModes || {};
    const disabledSites = stats.disabledSites || [];
    const globallyDisabled = !!stats.globallyDisabled;

    const isPausedSite = currentHost && disabledSites.includes(currentHost);

    // Global Toggles
    document.getElementById("globalToggle").checked = !globallyDisabled;
    document.getElementById("settingsGlobalToggle").checked = !globallyDisabled;

    // Site Toggle Button
    const btnSite = document.getElementById("btnSiteToggle");
    if (!currentHost) {
      btnSite.style.display = "none";
    } else {
      btnSite.style.display = "block";
      if (isPausedSite) {
        btnSite.textContent = "Resume Protection";
        btnSite.className = "site-toggle-btn paused";
      } else {
        btnSite.textContent = "Pause Site";
        btnSite.className = "site-toggle-btn";
      }
    }

    // Metrics
    document.getElementById("adsBlocked").textContent = fmtNum(ads);
    document.getElementById("trackersBlocked").textContent = fmtNum(trk);
    document.getElementById("bandwidthSaved").textContent = fmtBytes(bw);
    document.getElementById("topDomain").textContent = topEntry(dc)[0];
    document.getElementById("barTotal").textContent = fmtNum(ads + trk) + " total";

    // Ratio Segment
    const total = ads + trk || 1;
    document.getElementById("segAds").style.width = ((ads / total) * 100).toFixed(1) + "%";
    document.getElementById("segTrack").style.width = ((trk / total) * 100).toFixed(1) + "%";

    // Render Mode & Domains
    const mode = siteModes[currentHost] || (currentHost.includes("youtube.com") ? "youtube" : "normal");
    renderMode(mode, globallyDisabled, isPausedSite);

    const query = document.getElementById("domainSearch").value;
    renderDomains(dc, query);
  });
}

function bindEvents() {
  const toggleGlobal = () => {
    chrome.runtime.sendMessage({ type: "TOGGLE_GLOBAL" }, refresh);
  };

  document.getElementById("globalToggle").addEventListener("change", toggleGlobal);
  document.getElementById("settingsGlobalToggle").addEventListener("change", toggleGlobal);

  document.getElementById("btnSiteToggle").addEventListener("click", async () => {
    const host = await getActiveTabHost();
    if (!host) return;
    chrome.runtime.sendMessage({ type: "TOGGLE_SITE", host }, refresh);
  });

  // Zap Button Trigger
  document.getElementById("btnZap").addEventListener("click", () => {
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      if (tabs[0] && tabs[0].id) {
        chrome.tabs.sendMessage(tabs[0].id, { type: "START_ZAPPER" }, () => {
          window.close();
        });
      }
    });
  });

  // Options Control Center Trigger
  document.getElementById("btnOptions").addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
  });

  document.getElementById("btnReset").addEventListener("click", () => {
    if (confirm("Reset all b-AD blocking statistics and domain telemetry?")) {
      chrome.runtime.sendMessage({ type: "RESET_STATS" }, refresh);
    }
  });

  document.getElementById("domainSearch").addEventListener("input", refresh);
}

document.addEventListener("DOMContentLoaded", async () => {
  await loadTrackerCategories();
  setupTabs();
  bindEvents();
  refresh();
  setInterval(refresh, 2500);
});
