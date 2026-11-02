/** b-AD Ultra 6.0 settings */

"use strict";

let staticRulesCache = [];
let resetConfirmActive = false;

function sendCommand(message, onSuccess) {
  chrome.runtime.sendMessage(message, response => {
    const error = chrome.runtime.lastError;
    if (error || !response?.ok) {
      showToast(response?.error || error?.message || "Could not save change", true);
      loadState();
      return;
    }
    if (onSuccess) onSuccess(response);
  });
}

function showToast(message, isError = false) {
  const container = document.getElementById("toastContainer");
  if (!container) return;
  const item = document.createElement("div");
  item.className = "toast-item" + (isError ? " error" : "");
  item.textContent = (isError ? "✕ " : "✓ ") + message;
  container.appendChild(item);
  setTimeout(() => item.remove(), 3200);
}

function fmtNum(n) {
  n = Number(n) || 0;
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return String(n);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[c]);
}

function setupTabs() {
  const btns = document.querySelectorAll(".nav-btn");
  const panes = document.querySelectorAll(".tab-pane");

  const activate = b => {
      btns.forEach(btn => btn.classList.remove("active"));
      btns.forEach(btn => btn.setAttribute("aria-selected", String(btn === b)));
      panes.forEach(pane => pane.classList.remove("active"));

      b.classList.add("active");
      const targetId = b.dataset.tab;
      const pane = document.getElementById(targetId);
      if (pane) pane.classList.add("active");
  };
  btns.forEach((b, index) => {
    b.addEventListener("click", () => activate(b));
    b.addEventListener("keydown", event => {
      if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === "Home" ? 0 : event.key === "End" ? btns.length - 1 :
        (index + (event.key === "ArrowDown" ? 1 : -1) + btns.length) % btns.length;
      activate(btns[next]);
      btns[next].focus();
    });
  });
}

async function loadStaticRules() {
  try {
    const responses = await Promise.all(["rules.json", "tracking_rules.json"].map(name =>
      fetch(chrome.runtime.getURL(name))));
    const rulesets = await Promise.all(responses.map(res => res.json()));
    if (rulesets.every(Array.isArray)) {
      staticRulesCache = rulesets.flat();
      renderStaticRules("");
    }
  } catch (_) { showToast("Could not load built-in rules", true); }
}

function renderStaticRules(query) {
  const container = document.getElementById("staticRulesList");
  const countBadge = document.getElementById("staticRulesCount");
  const q = (query || "").trim().toLowerCase();

  const filtered = staticRulesCache.filter(r => {
    const filter = r.id >= 75 ? `Tracking parameters ${r.condition.urlFilter}` : (r.condition && r.condition.urlFilter) || "";
    const actionType = (r.action && r.action.type) || "block";
    return !q || filter.toLowerCase().includes(q) || actionType.toLowerCase().includes(q);
  });

  countBadge.textContent = filtered.length;

  if (!filtered.length) {
    container.innerHTML = '<div class="empty-msg">No static rules match your search query.</div>';
    return;
  }

  container.innerHTML = filtered.map(r => {
    const filter = r.id >= 75 ? `Strip tracking links matching ${r.condition.urlFilter}` : r.condition.urlFilter;
    const action = (r.action && r.action.type) ? r.action.type.toUpperCase() : "BLOCK";
    return `
      <div class="rule-item">
        <div class="rule-meta">
          <span class="rule-badge">#${r.id} • ${escapeHtml(action)}</span>
          <span>${escapeHtml(filter)}</span>
        </div>
        <span style="color:#64748b;font-size:11px;">Priority ${r.priority || 1}</span>
      </div>
    `;
  }).join("");
}

function loadState() {
  chrome.runtime.sendMessage({ type: "GET_STATS" }, data => {
    const error = chrome.runtime.lastError;
    if (error || !data) { showToast(error?.message || "Could not load settings", true); return; }

    const selectors = data.customSelectors || [];
    const dnrRules = data.customDnrRules || [];
    const whitelist = data.disabledSites || [];
    const cfg = data.settings || {};

    // Update KPI Strip
    document.getElementById("kpiAds").textContent = fmtNum(data.adsBlocked || 0);
    document.getElementById("kpiTrackers").textContent = fmtNum(data.cookiesCleaned || 0);
    document.getElementById("kpiBandwidth").textContent = fmtNum(data.sponsorsSkipped || 0);
    document.getElementById("kpiCustomRules").textContent = fmtNum(selectors.length + dnrRules.length);

    // Update Module Checkboxes
    document.querySelectorAll("input[data-opt-setting]").forEach(el => {
      const key = el.dataset.optSetting;
      el.checked = cfg[key] === true;
    });

    renderSelectors(selectors);
    renderDnrRules(dnrRules);
    renderWhitelist(whitelist);
  });
}

function renderSelectors(list) {
  const container = document.getElementById("selectorsList");
  const countBadge = document.getElementById("selectorsCount");
  countBadge.textContent = list.length;

  if (!list.length) {
    container.innerHTML = '<div class="empty-msg">No custom cosmetic selectors added yet.</div>';
    return;
  }

  container.innerHTML = list.map((sel, index) => `
    <div class="rule-item">
      <div class="rule-meta">
        <span class="rule-badge">CSS</span>
        <span>${escapeHtml(sel)}</span>
      </div>
      <button class="btn-del" data-type="selector" data-index="${index}" title="Remove selector">✕</button>
    </div>
  `).join("");
}

function renderDnrRules(list) {
  const container = document.getElementById("dnrList");
  const countBadge = document.getElementById("dnrCount");
  countBadge.textContent = list.length;

  if (!list.length) {
    container.innerHTML = '<div class="empty-msg">No dynamic network rules added yet.</div>';
    return;
  }

  container.innerHTML = list.map((rule, index) => `
    <div class="rule-item">
      <div class="rule-meta">
        <span class="rule-badge">DNR #${escapeHtml(rule.id)}</span>
        <span>${escapeHtml(rule.filter)}</span>
      </div>
      <button class="btn-del" data-type="dnr" data-id="${escapeHtml(rule.id)}" data-index="${index}" title="Remove DNR rule">✕</button>
    </div>
  `).join("");
}

function renderWhitelist(list) {
  const container = document.getElementById("whitelistList");
  const countBadge = document.getElementById("whitelistCount");
  countBadge.textContent = list.length;

  if (!list.length) {
    container.innerHTML = '<div class="empty-msg">No domains whitelisted.</div>';
    return;
  }

  container.innerHTML = list.map(site => `
    <div class="rule-item">
      <div class="rule-meta">
        <span class="rule-badge" style="color:#10b981;border-color:rgba(16,185,129,0.3);background:rgba(16,185,129,0.12);">ALLOW</span>
        <span>${escapeHtml(site)}</span>
      </div>
      <button class="btn-del" data-type="whitelist" data-site="${escapeHtml(site)}" title="Remove from whitelist">✕</button>
    </div>
  `).join("");
}

function bindEvents() {
  // Add Validated Cosmetic Selector
  const addSelector = () => {
    const input = document.getElementById("inputSelector");
    const selector = input.value.trim();
    if (!selector) return;

    // Validate syntax in DOM first
    try {
      document.createDocumentFragment().querySelector(selector);
    } catch (_) {
      showToast("Invalid CSS selector syntax.", true);
      return;
    }

    chrome.runtime.sendMessage({ type: "ADD_CUSTOM_SELECTOR", selector }, res => {
      const error = chrome.runtime.lastError;
      if (!error && res && res.ok) {
        input.value = "";
        showToast(`Added cosmetic selector: ${selector}`);
        loadState();
      } else {
        showToast((res && res.error) || error?.message || "Failed to add selector.", true);
      }
    });
  };

  document.getElementById("btnAddSelector").addEventListener("click", addSelector);
  document.getElementById("inputSelector").addEventListener("keydown", e => {
    if (e.key === "Enter") addSelector();
  });

  // Add Dynamic DNR Rule
  const addDnr = () => {
    const input = document.getElementById("inputDnrFilter");
    const filter = input.value.trim();
    if (!filter) return;

    chrome.runtime.sendMessage({ type: "ADD_DYNAMIC_RULE", filter }, res => {
      const error = chrome.runtime.lastError;
      if (!error && res && res.ok) {
        input.value = "";
        showToast(`Added dynamic DNR rule #${res.ruleId}`);
        loadState();
      } else {
        showToast((res && res.error) || error?.message || "Failed to add DNR rule.", true);
      }
    });
  };

  document.getElementById("btnAddDnr").addEventListener("click", addDnr);
  document.getElementById("inputDnrFilter").addEventListener("keydown", e => {
    if (e.key === "Enter") addDnr();
  });

  // Add Whitelist Site
  const addWhitelist = () => {
    const input = document.getElementById("inputWhitelist");
    const host = input.value.trim();
    if (!host) return;

    chrome.runtime.sendMessage({ type: "ADD_SITE", host }, res => {
      const error = chrome.runtime.lastError;
      if (!error && res && res.ok) {
        input.value = "";
        showToast(`Updated whitelist status for ${host}`);
        loadState();
      } else {
        showToast((res && res.error) || error?.message || "Invalid domain name.", true);
      }
    });
  };

  document.getElementById("btnAddWhitelist").addEventListener("click", addWhitelist);
  document.getElementById("inputWhitelist").addEventListener("keydown", e => {
    if (e.key === "Enter") addWhitelist();
  });

  // Search Static Rules
  document.getElementById("inputSearchStatic").addEventListener("input", e => {
    renderStaticRules(e.target.value);
  });

  // Delete Click Delegate
  document.addEventListener("click", e => {
    const btn = e.target.closest(".btn-del");
    if (!btn) return;
    const type = btn.dataset.type;

    if (type === "selector") {
      const index = parseInt(btn.dataset.index, 10);
      sendCommand({ type: "REMOVE_CUSTOM_SELECTOR", index }, () => {
        showToast("Removed custom cosmetic selector.");
        loadState();
      });
    } else if (type === "dnr") {
      const ruleId = parseInt(btn.dataset.id, 10);
      sendCommand({ type: "REMOVE_DYNAMIC_RULE", ruleId }, () => {
        showToast(`Removed dynamic DNR rule #${ruleId}.`);
        loadState();
      });
    } else if (type === "whitelist") {
      const host = btn.dataset.site;
      sendCommand({ type: "TOGGLE_SITE", host }, () => {
        showToast(`Removed ${host} from whitelist.`);
        loadState();
      });
    }
  });

  // Module Setting Checkboxes
  document.querySelectorAll("input[data-opt-setting]").forEach(el => {
    el.addEventListener("change", () => {
      const key = el.dataset.optSetting;
      sendCommand({ type: "UPDATE_SETTINGS", settings: { [key]: el.checked } }, () =>
        showToast("Setting updated."));
    });
  });

  // Export JSON Backup
  document.getElementById("btnExport").addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "GET_STATS" }, data => {
      if (!data) return;
      const exportPayload = {
        version: chrome.runtime.getManifest().version,
        exportedAt: new Date().toISOString(),
        settings: data.settings,
        customSelectors: data.customSelectors,
        customDnrRules: data.customDnrRules,
        disabledSites: data.disabledSites
      };
      const blob = new Blob([JSON.stringify(exportPayload, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `b-ad-v6-backup-${Date.now()}.json`;
      a.click();
      URL.revokeObjectURL(url);
      showToast("Exported configuration backup JSON.");
    });
  });

  // Import JSON Backup Trigger
  document.getElementById("btnImportTrigger").addEventListener("click", () => {
    document.getElementById("fileImport").click();
  });

  document.getElementById("fileImport").addEventListener("change", e => {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 1024 * 1024) {
      showToast("Backup file exceeds 1 MB.", true);
      e.target.value = "";
      return;
    }
    const reader = new FileReader();
    reader.onload = event => {
      try {
        const parsed = JSON.parse(event.target.result);
        chrome.runtime.sendMessage({ type: "IMPORT_CONFIG", data: parsed }, res => {
          const error = chrome.runtime.lastError;
          if (!error && res && res.ok) {
            showToast("Configuration imported and synchronized with DNR engine!");
            loadState();
          } else {
            showToast((res && res.error) || error?.message || "Configuration import failed.", true);
          }
        });
      } catch (_) {
        showToast("Malformed JSON file.", true);
      }
      e.target.value = "";
    };
    reader.readAsText(file);
  });

  // Non-blocking Two-Step Factory Reset
  const btnResetAll = document.getElementById("btnResetAll");
  btnResetAll.addEventListener("click", () => {
    if (!resetConfirmActive) {
      resetConfirmActive = true;
      btnResetAll.textContent = "Click Again to Confirm Full Factory Reset";
      setTimeout(() => {
        resetConfirmActive = false;
        btnResetAll.textContent = "Reset All Extension Data";
      }, 4000);
      return;
    }
    resetConfirmActive = false;
    btnResetAll.textContent = "Reset All Extension Data";
    sendCommand({ type: "RESET_STATS", includeRules: true }, () => {
      showToast("All extension data and rules reset to factory defaults.");
      loadState();
    });
  });
}

document.addEventListener("DOMContentLoaded", () => {
  setupTabs();
  bindEvents();
  loadStaticRules();
  loadState();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && ["settings", "customSelectors", "customDnrRules", "disabledSites"].some(key => changes[key])) {
      loadState();
    }
  });
});
