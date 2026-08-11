"use strict";

function setupTabs() {
  const btns = document.querySelectorAll(".nav-btn");
  const panes = document.querySelectorAll(".tab-pane");

  btns.forEach(b => {
    b.addEventListener("click", () => {
      btns.forEach(btn => btn.classList.remove("active"));
      panes.forEach(pane => pane.classList.remove("active"));

      b.classList.add("active");
      const targetId = b.dataset.tab;
      document.getElementById(targetId).classList.add("active");
    });
  });
}

function loadStats() {
  chrome.storage.local.get({ customSelectors: [], customDnrRules: [], disabledSites: [] }, data => {
    renderSelectors(data.customSelectors || []);
    renderDnrRules(data.customDnrRules || []);
    renderWhitelist(data.disabledSites || []);
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
      <span>${escapeHtml(sel)}</span>
      <button class="btn-del" data-type="selector" data-index="${index}">✕</button>
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
      <span>${escapeHtml(rule.filter)}</span>
      <button class="btn-del" data-type="dnr" data-index="${index}">✕</button>
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

  container.innerHTML = list.map((site, index) => `
    <div class="rule-item">
      <span>${escapeHtml(site)}</span>
      <button class="btn-del" data-type="whitelist" data-index="${index}">✕</button>
    </div>
  `).join("");
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[c]);
}

function bindEvents() {
  // Add Selector
  document.getElementById("btnAddSelector").addEventListener("click", () => {
    const val = document.getElementById("inputSelector").value.trim();
    if (!val) return;
    chrome.storage.local.get({ customSelectors: [] }, data => {
      const updated = Array.from(new Set([...(data.customSelectors || []), val]));
      chrome.storage.local.set({ customSelectors: updated }, () => {
        document.getElementById("inputSelector").value = "";
        loadStats();
      });
    });
  });

  // Add Dynamic DNR Rule
  document.getElementById("btnAddDnr").addEventListener("click", () => {
    const filter = document.getElementById("inputDnrFilter").value.trim();
    if (!filter) return;
    chrome.runtime.sendMessage({ type: "ADD_DYNAMIC_RULE", filter }, () => {
      document.getElementById("inputDnrFilter").value = "";
      loadStats();
    });
  });

  // Add Whitelist Site
  document.getElementById("btnAddWhitelist").addEventListener("click", () => {
    const val = document.getElementById("inputWhitelist").value.trim().toLowerCase().replace(/^www\./, "");
    if (!val) return;
    chrome.storage.local.get({ disabledSites: [] }, data => {
      const updated = Array.from(new Set([...(data.disabledSites || []), val]));
      chrome.storage.local.set({ disabledSites: updated }, () => {
        document.getElementById("inputWhitelist").value = "";
        loadStats();
      });
    });
  });

  // Delete Click Delegate
  document.addEventListener("click", e => {
    if (!e.target.classList.contains("btn-del")) return;
    const type = e.target.dataset.type;
    const index = parseInt(e.target.dataset.index, 10);

    if (type === "selector") {
      chrome.storage.local.get({ customSelectors: [] }, data => {
        const list = data.customSelectors || [];
        list.splice(index, 1);
        chrome.storage.local.set({ customSelectors: list }, loadStats);
      });
    }

    if (type === "dnr") {
      chrome.storage.local.get({ customDnrRules: [] }, data => {
        const list = data.customDnrRules || [];
        const item = list[index];
        if (item && item.id && chrome.declarativeNetRequest.updateDynamicRules) {
          chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [item.id] });
        }
        list.splice(index, 1);
        chrome.storage.local.set({ customDnrRules: list }, loadStats);
      });
    }

    if (type === "whitelist") {
      chrome.storage.local.get({ disabledSites: [] }, data => {
        const list = data.disabledSites || [];
        list.splice(index, 1);
        chrome.storage.local.set({ disabledSites: list }, loadStats);
      });
    }
  });

  // Export JSON
  document.getElementById("btnExport").addEventListener("click", () => {
    chrome.storage.local.get(null, data => {
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `b-ad-ultra-backup-${Date.now()}.json`;
      a.click();
    });
  });

  // Import JSON Trigger
  document.getElementById("btnImportTrigger").addEventListener("click", () => {
    document.getElementById("fileImport").click();
  });

  // Import File Listener
  document.getElementById("fileImport").addEventListener("change", e => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = event => {
      try {
        const parsed = JSON.parse(event.target.result);
        chrome.storage.local.set(parsed, () => {
          alert("Configuration imported successfully!");
          loadStats();
        });
      } catch (_) {
        alert("Failed to parse configuration file.");
      }
    };
    reader.readAsText(file);
  });

  // Reset All
  document.getElementById("btnResetAll").addEventListener("click", () => {
    if (confirm("Reset ALL b-AD Ultra data, custom rules, and statistics?")) {
      chrome.storage.local.clear(() => {
        chrome.runtime.sendMessage({ type: "RESET_STATS" }, loadStats);
      });
    }
  });
}

document.addEventListener("DOMContentLoaded", () => {
  setupTabs();
  bindEvents();
  loadStats();
});
