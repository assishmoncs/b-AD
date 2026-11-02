/** b-AD Ultra 6.0 popup */

"use strict";

let activeTabInfo = { id: null, host: "" };
let resetConfirmTimer = null;
let noticeTimer = null;

function showNotice(message) {
  const notice = document.getElementById("popupNotice");
  notice.textContent = message;
  notice.hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { notice.hidden = true; }, 4500);
}

function sendCommand(message, onSuccess = refresh) {
  chrome.runtime.sendMessage(message, response => {
    const error = chrome.runtime.lastError;
    if (error || !response?.ok) {
      showNotice(response?.error || error?.message || "Could not update protection");
      refresh();
      return;
    }
    onSuccess(response);
  });
}

function fmtNum(n) {
  n = Number(n) || 0;
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return String(n);
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

  const activate = btn => {
      tabs.forEach(t => t.classList.remove("active"));
      tabs.forEach(t => t.setAttribute("aria-selected", String(t === btn)));
      contents.forEach(c => c.classList.remove("active"));

      btn.classList.add("active");
      const targetId = btn.dataset.tab;
      const targetEl = document.getElementById(targetId);
      if (targetEl) targetEl.classList.add("active");
  };
  tabs.forEach((btn, index) => {
    btn.addEventListener("click", () => activate(btn));
    btn.addEventListener("keydown", event => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 :
        (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
      activate(tabs[next]);
      tabs[next].focus();
    });
  });
}

function renderStatusBanner(mode, isPausedGlobal, isPausedSite, supported) {
  const card = document.getElementById("statusCard");
  const shield = document.getElementById("headerShield");
  const label = document.getElementById("statusLabel");
  const badge = document.getElementById("modeBadge");

  if (!supported) {
    card.className = "status-card paused";
    shield.className = "shield-badge paused";
    label.textContent = "UNAVAILABLE ON THIS PAGE";
    badge.textContent = "BROWSER PAGE";
    badge.className = "mode-badge stealth";
    return;
  }
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
    label.textContent = "YOUTUBE CONTROLS ACTIVE";
    badge.textContent = "YOUTUBE";
    badge.className = "mode-badge youtube";
  } else if (mode === "stealth") {
    label.textContent = "STEALTH HELPERS ACTIVE";
    badge.textContent = "STEALTH";
    badge.className = "mode-badge stealth";
  } else {
    label.textContent = "PROTECTION ACTIVE";
    badge.textContent = "ON";
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
      : '<div class="domains-empty">No page actions recorded yet.</div>';
    return;
  }

  const max = pairs[0][1] || 1;
  list.innerHTML = pairs.slice(0, 35).map(([domain, count], i) => {
    const pct = Math.max(4, Math.round((count / max) * 100));
    return `
      <div class="domain-row">
        <div class="domain-main">
          <div class="domain-info">
            <span class="domain-rank">${i + 1}</span>
            <span class="domain-name" title="${esc(domain)}">${esc(domain)}</span>
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
    const kindLabel = ev.kind === "sponsor" ? "SPONSOR" : ev.kind === "cookie" ? "CONSENT" : ev.kind.toUpperCase();
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
    if (!stats) { showNotice("Could not load extension status"); return; }

    const ads = stats.adsBlocked || 0;
    const consent = stats.cookiesCleaned || 0;
    const sponsors = stats.sponsorsSkipped || 0;
    const timeSec = stats.timeSavedSec || 0;
    const dc = stats.domainCounts || {};
    const siteModes = stats.siteModes || {};
    const disabledSites = stats.disabledSites || [];
    const globallyDisabled = !!stats.globallyDisabled;
    const tabHits = stats.activeTabBlocked || 0;

    document.getElementById("tabHitSummary").textContent =
      globallyDisabled
        ? "Protection paused globally"
        : `${fmtNum(tabHits)} page actions on this tab`;

    const isPausedSite = currentHost && disabledSites.some(
      s => currentHost === s || currentHost.endsWith("." + s)
    );

    // Master Global Toggle
    document.getElementById("globalToggle").checked = !globallyDisabled;

    // Module Setting Switches
    const cfg = stats.settings || {};
    document.querySelectorAll("input[data-setting]").forEach(input => {
      const key = input.dataset.setting;
      input.checked = cfg[key] === true;
    });

    // Site Toggle Button
    const btnSite = document.getElementById("btnSiteToggle");
    document.getElementById("btnZap").disabled = !currentHost;
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
    document.getElementById("trackersBlocked").textContent = fmtNum(consent);
    document.getElementById("bandwidthSaved").textContent = fmtNum(sponsors);
    document.getElementById("timeSaved").textContent = fmtDuration(timeSec);

    const topDom = topEntry(dc)[0];
    document.getElementById("topDomainPill").textContent = `Top: ${topDom}`;
    document.getElementById("barTotal").textContent = `${fmtNum(ads + consent + sponsors)} total`;

    // Ratio Segment Bar
    const total = Math.max(1, ads + consent + sponsors);
    document.getElementById("segAds").style.width = ((ads / total) * 100).toFixed(1) + "%";
    document.getElementById("segTrack").style.width = ((consent / total) * 100).toFixed(1) + "%";
    document.getElementById("segSponsors").style.width = ((sponsors / total) * 100).toFixed(1) + "%";

    // Render Mode, Domains & Activity Log
    const mode = (currentHost === "youtube.com" || currentHost.endsWith(".youtube.com")) && cfg.youtubeEngine
      ? "youtube"
      : (cfg.stealthMode ? siteModes[currentHost] || "normal" : "normal");
    renderStatusBanner(mode, globallyDisabled, isPausedSite, !!currentHost);

    const query = document.getElementById("domainSearch").value;
    renderDomains(dc, query);
    renderActivityLog(stats.recentEvents || []);
  });
}

function bindEvents() {
  // Global Toggle
  document.getElementById("globalToggle").addEventListener("change", e => {
    sendCommand({ type: "TOGGLE_GLOBAL", value: !e.target.checked });
  });

  // Per-Site Whitelist Toggle (with automatic tab reload)
  document.getElementById("btnSiteToggle").addEventListener("click", async () => {
    const info = await queryActiveTab();
    if (!info.host) return;
    sendCommand({ type: "TOGGLE_SITE", host: info.host, reloadTabId: info.id });
  });

  // Visual Zapper Trigger
  document.getElementById("btnZap").addEventListener("click", async () => {
    const info = await queryActiveTab();
    if (info.id) {
      chrome.tabs.sendMessage(info.id, { type: "START_ZAPPER" }, () => {
        const error = chrome.runtime.lastError;
        if (error) showNotice(error.message || "Zapper unavailable on this page");
        else window.close();
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
    const isDnr = val.startsWith("||");
    if (!isDnr) {
      try { document.createDocumentFragment().querySelector(val); }
      catch (_) {
        feedback.textContent = "Invalid CSS selector syntax.";
        feedback.style.color = "#ef4444";
        return;
      }
    }
    const msg = isDnr
      ? { type: "ADD_DYNAMIC_RULE", filter: val }
      : { type: "ADD_CUSTOM_SELECTOR", selector: val };

    chrome.runtime.sendMessage(msg, res => {
      const error = chrome.runtime.lastError;
      if (!error && res && res.ok) {
        ruleInput.value = "";
        feedback.textContent = isDnr
          ? "✓ Saved dynamic network DNR rule!"
          : "✓ Saved custom CSS cosmetic selector!";
        feedback.style.color = "#10b981";
        refresh();
      } else {
        feedback.textContent = (res && res.error) || error?.message || "Invalid rule syntax.";
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
      sendCommand({ type: "UPDATE_SETTINGS", settings: { [key]: input.checked } });
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
        resetText.textContent = "RESET ACTIVITY COUNTERS";
      }, 3500);
      return;
    }
    clearTimeout(resetConfirmTimer);
    btnReset.classList.remove("confirming");
    resetText.textContent = "RESET ACTIVITY COUNTERS";
    sendCommand({ type: "RESET_STATS", includeRules: false });
  });

  document.getElementById("domainSearch").addEventListener("input", refresh);
}

document.addEventListener("DOMContentLoaded", () => {
  setupTabs();
  bindEvents();
  refresh();
  setInterval(refresh, 2000);
});
