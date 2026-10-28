/**
 * b-AD Ultra v5.0 Enterprise — Popup Dashboard Controller
 */

"use strict";

const trackerMeta = {};
let activeTabInfo = { id: null, host: "" };
let resetConfirmTimer = null;

async function loadTrackerDatabase() {
  try {
    const res = await fetch(chrome.runtime.getURL("tracker_list.json"));
    const data = await res.json();
    if (data && Array.isArray(data.trackers)) {
      for (const t of data.trackers) {
        trackerMeta[t.domain] = {
          name: t.name || t.domain,
          category: t.category || "Tracker",
          risk: t.risk || "Medium"
        };
      }
    }
  } catch (_) {}
}

function fmtNum(n) {
  n = Number(n) || 0;
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return String(n);
}

function fmtBytes(b) {
  b = Number(b) || 0;
  if (b <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(Math.floor(Math.log(b) / Math.log(1024)), 3);
  return (b / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1) + " " + units[i];
}

function fmtDuration(sec) {
  sec = Math.round(Number(sec) || 0);
  if (sec <= 0) return "0s";
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return s > 0 ? `${m}m ${s}s` : `${m}m`;
  }
  const h = (sec / 3600).toFixed(1);
  return `${h}h`;
}

function fmtRelativeTime(ts) {
  const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (diffSec < 5) return "just now";
  if (diffSec < 60) return `${diffSec}s ago`;
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  return `${Math.floor(diffSec / 3600)}h ago`;
}

function topEntry(counts) {
  if (!counts || typeof counts !== "object") return ["—", 0];
  const entries = Object.entries(counts);
  if (!entries.length) return ["—", 0];
  return entries.sort((a, b) => b[1] - a[1])[0];
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[c]);
}

function queryActiveTab() {
  return new Promise(resolve => {
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      void chrome.runtime.lastError;
      const tab = tabs && tabs[0];
      if (!tab || !tab.url) return resolve({ id: null, host: "" });
      try {
        const u = new URL(tab.url);
        if (u.protocol.startsWith("http")) {
          return resolve({ id: tab.id, host: u.hostname.replace(/^www\./, "").toLowerCase() });
        }
      } catch (_) {}
      resolve({ id: tab.id, host: "" });
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
      const targetEl = document.getElementById(targetId);
      if (targetEl) targetEl.classList.add("active");
    });
  });
}

function renderStatusBanner(mode, isPausedGlobal, isPausedSite) {
  const card = document.getElementById("statusCard");
  const shield = document.getElementById("headerShield");
  const label = document.getElementById("statusLabel");
  const badge = document.getElementById("modeBadge");

  if (isPausedGlobal) {
    card.className = "status-card paused";
    shield.className = "shield-badge paused";
    label.textContent = "PROTECTION PAUSED (GLOBAL)";
    badge.textContent = "DISABLED";
    badge.className = "mode-badge stealth";
    return;
  }

  if (isPausedSite) {
    card.className = "status-card paused";
    shield.className = "shield-badge paused";
    label.textContent = "PAUSED ON THIS SITE";
    badge.textContent = "WHITELISTED";
    badge.className = "mode-badge stealth";
    return;
  }

  card.className = "status-card";
  shield.className = "shield-badge";

  if (mode === "youtube") {
    label.textContent = "YOUTUBE ENGINE 5.0 ACTIVE";
    badge.textContent = "YT SHIELD";
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

  const max = pairs[0][1] || 1;
  list.innerHTML = pairs.slice(0, 35).map(([domain, count], i) => {
    const pct = Math.max(4, Math.round((count / max) * 100));
    const meta = trackerMeta[domain] || {
      category: domain.includes("ad") ? "Ad Network" : "Tracking Domain",
      risk: "Medium"
    };
    const tagClass = meta.risk === "Critical" || meta.risk === "High" ? "tag-red" : "";
    return `
      <div class="domain-row">
        <div class="domain-main">
          <div class="domain-info">
            <span class="domain-rank">${i + 1}</span>
            <span class="domain-name" title="${esc(domain)}">${esc(domain)}</span>
            <span class="domain-tag ${tagClass}">${esc(meta.category)}</span>
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

function renderActivityLog(events) {
  const list = document.getElementById("activityList");
  const cnt = document.getElementById("activityCount");
  const items = Array.isArray(events) ? events : [];
  cnt.textContent = items.length;

  if (!items.length) {
    list.innerHTML = '<div class="domains-empty">No recent events recorded in this session.</div>';
    return;
  }

  list.innerHTML = items.slice(0, 25).map(ev => {
    const badgeClass = ev.kind === "ad" ? "tag-red" : ev.kind === "tracker" ? "tag-amber" : "";
    const kindLabel = ev.kind === "sponsor" ? "SPONSOR" : ev.kind === "cookie" ? "GDPR" : ev.kind.toUpperCase();
    return `
      <div class="domain-row">
        <div class="domain-main">
          <div class="domain-info">
            <span class="domain-tag ${badgeClass}">${esc(kindLabel)}</span>
            <span class="domain-name">${esc(ev.domain)}</span>
          </div>
          <span class="domain-rank" style="width:auto;">${esc(fmtRelativeTime(ev.ts))}</span>
        </div>
      </div>
    `;
  }).join("");
}

async function refresh() {
  activeTabInfo = await queryActiveTab();
  const currentHost = activeTabInfo.host;
  document.getElementById("currentHost").textContent = currentHost || "browser internal page";

  chrome.runtime.sendMessage({ type: "GET_STATS", tabId: activeTabInfo.id }, stats => {
    void chrome.runtime.lastError;
    if (!stats) return;

    const ads = stats.adsBlocked || 0;
    const trk = stats.trackersBlocked || 0;
    const spn = (stats.sponsorsSkipped || 0) + (stats.cookiesCleaned || 0);
    const bw = stats.bandwidthSaved || 0;
    const timeSec = stats.timeSavedSec || Math.round((ads + trk) * 0.14);
    const dc = stats.domainCounts || {};
    const siteModes = stats.siteModes || {};
    const disabledSites = stats.disabledSites || [];
    const globallyDisabled = !!stats.globallyDisabled;
    const tabHits = stats.activeTabBlocked || 0;

    document.getElementById("tabHitSummary").textContent =
      globallyDisabled
        ? "Protection paused globally"
        : `${fmtNum(tabHits)} blocked on active tab`;

    const isPausedSite = currentHost && disabledSites.some(
      s => currentHost === s || currentHost.endsWith("." + s)
    );

    // Master Global Toggle
    document.getElementById("globalToggle").checked = !globallyDisabled;

    // Module Setting Switches
    const cfg = stats.settings || {};
    document.querySelectorAll("input[data-setting]").forEach(input => {
      const key = input.dataset.setting;
      input.checked = cfg[key] !== false;
    });

    // Site Toggle Button
    const btnSite = document.getElementById("btnSiteToggle");
    if (!currentHost) {
      btnSite.style.display = "none";
    } else {
      btnSite.style.display = "block";
      if (isPausedSite) {
        btnSite.textContent = "Resume Site";
        btnSite.className = "site-toggle-btn paused";
      } else {
        btnSite.textContent = "Pause Site";
        btnSite.className = "site-toggle-btn";
      }
    }

    // KPI Metrics
    document.getElementById("adsBlocked").textContent = fmtNum(ads);
    document.getElementById("trackersBlocked").textContent = fmtNum(trk);
    document.getElementById("bandwidthSaved").textContent = fmtBytes(bw);
    document.getElementById("timeSaved").textContent = fmtDuration(timeSec);

    const topDom = topEntry(dc)[0];
    document.getElementById("topDomainPill").textContent = `Top: ${topDom}`;
    document.getElementById("barTotal").textContent = `${fmtNum(ads + trk)} total`;

    // Ratio Segment Bar
    const total = Math.max(1, ads + trk + spn);
    document.getElementById("segAds").style.width = ((Math.max(0, ads - spn) / total) * 100).toFixed(1) + "%";
    document.getElementById("segTrack").style.width = ((trk / total) * 100).toFixed(1) + "%";
    document.getElementById("segSponsors").style.width = ((spn / total) * 100).toFixed(1) + "%";

    // Render Mode, Domains & Activity Log
    const mode = currentHost.includes("youtube.com")
      ? "youtube"
      : (siteModes[currentHost] || "normal");
    renderStatusBanner(mode, globallyDisabled, isPausedSite);

    const query = document.getElementById("domainSearch").value;
    renderDomains(dc, query);
    renderActivityLog(stats.recentEvents || []);
  });
}

function bindEvents() {
  // Global Toggle
  document.getElementById("globalToggle").addEventListener("change", e => {
    chrome.runtime.sendMessage({ type: "TOGGLE_GLOBAL", value: !e.target.checked }, refresh);
  });

  // Per-Site Whitelist Toggle (with automatic tab reload)
  document.getElementById("btnSiteToggle").addEventListener("click", async () => {
    const info = await queryActiveTab();
    if (!info.host) return;
    chrome.runtime.sendMessage(
      { type: "TOGGLE_SITE", host: info.host, reloadTabId: info.id },
      refresh
    );
  });

  // Visual Zapper Trigger
  document.getElementById("btnZap").addEventListener("click", async () => {
    const info = await queryActiveTab();
    if (info.id) {
      chrome.tabs.sendMessage(info.id, { type: "START_ZAPPER" }, () => {
        void chrome.runtime.lastError;
        window.close();
      });
    }
  });

  // Quick Rule Drawer Toggle & Save
  const drawer = document.getElementById("quickRuleDrawer");
  const ruleInput = document.getElementById("quickRuleInput");
  const feedback = document.getElementById("quickRuleFeedback");

  document.getElementById("btnQuickRule").addEventListener("click", () => {
    drawer.hidden = !drawer.hidden;
    if (!drawer.hidden) ruleInput.focus();
  });

  const submitQuickRule = () => {
    const val = ruleInput.value.trim();
    if (!val) return;
    const isDnr = val.startsWith("||") || val.startsWith("|http") || val.includes("^");
    const msg = isDnr
      ? { type: "ADD_DYNAMIC_RULE", filter: val }
      : { type: "ADD_CUSTOM_SELECTOR", selector: val };

    chrome.runtime.sendMessage(msg, res => {
      if (res && res.ok) {
        ruleInput.value = "";
        feedback.textContent = isDnr
          ? "✓ Saved dynamic network DNR rule!"
          : "✓ Saved custom CSS cosmetic selector!";
        feedback.style.color = "#10b981";
        refresh();
      } else {
        feedback.textContent = (res && res.error) || "Invalid rule syntax.";
        feedback.style.color = "#ef4444";
      }
    });
  };

  document.getElementById("btnSaveQuickRule").addEventListener("click", submitQuickRule);
  ruleInput.addEventListener("keydown", e => {
    if (e.key === "Enter") submitQuickRule();
  });

  // Options Control Center Trigger
  document.getElementById("btnOptions").addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
  });

  // Module Setting Switches
  document.querySelectorAll("input[data-setting]").forEach(input => {
    input.addEventListener("change", () => {
      const key = input.dataset.setting;
      chrome.runtime.sendMessage(
        { type: "UPDATE_SETTINGS", settings: { [key]: input.checked } },
        refresh
      );
    });
  });

  // Two-Step Non-Blocking Reset Confirmation
  const btnReset = document.getElementById("btnReset");
  const resetText = document.getElementById("resetBtnText");
  btnReset.addEventListener("click", () => {
    if (!btnReset.classList.contains("confirming")) {
      btnReset.classList.add("confirming");
      resetText.textContent = "CLICK AGAIN TO CONFIRM RESET";
      clearTimeout(resetConfirmTimer);
      resetConfirmTimer = setTimeout(() => {
        btnReset.classList.remove("confirming");
        resetText.textContent = "RESET TELEMETRY COUNTERS";
      }, 3500);
      return;
    }
    clearTimeout(resetConfirmTimer);
    btnReset.classList.remove("confirming");
    resetText.textContent = "RESET TELEMETRY COUNTERS";
    chrome.runtime.sendMessage({ type: "RESET_STATS", includeRules: false }, refresh);
  });

  document.getElementById("domainSearch").addEventListener("input", refresh);
}

document.addEventListener("DOMContentLoaded", async () => {
  await loadTrackerDatabase();
  setupTabs();
  bindEvents();
  refresh();
  setInterval(refresh, 2000);
});
