"use strict";

function fmtNum(n) {
  n = n || 0;
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return String(n);
}

function fmtBytes(b) {
  b = b || 0;
  if (!b) return "0 B";
  const u = ["B","KB","MB","GB"];
  const i = Math.min(Math.floor(Math.log(b) / Math.log(1024)), 3);
  return (b / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1) + " " + u[i];
}

function topEntry(counts) {
  if (!counts) return ["—", 0];
  const entries = Object.entries(counts);
  if (!entries.length) return ["—", 0];
  return entries.sort((a, b) => b[1] - a[1])[0];
}

function topN(counts, n) {
  if (!counts) return [];
  return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, n);
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]);
}

function getCurrentMode(siteModes) {
  return new Promise(res => {
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      if (!tabs[0] || !tabs[0].url) return res(null);
      try {
        const host = new URL(tabs[0].url).hostname.replace(/^www\./, "");
        if (host.includes("youtube.com")) return res("youtube");
        for (const [site, mode] of Object.entries(siteModes || {})) {
          if (host === site || host.endsWith("." + site)) return res(mode);
        }
        res(null);
      } catch (_) { res(null); }
    });
  });
}

function renderMode(mode) {
  const strip = document.getElementById("modeStrip");
  const icon  = document.getElementById("modeIcon");
  const text  = document.getElementById("modeText");
  strip.className = "mode-strip";
  if (mode === "youtube") {
    strip.classList.add("mode-youtube");
    icon.textContent = "▶";
    text.textContent = "YOUTUBE ENGINE ACTIVE";
  } else if (mode === "stealth") {
    strip.classList.add("mode-stealth");
    icon.textContent = "⬡";
    text.textContent = "STEALTH MODE — hiding ads";
  } else if (mode === "normal") {
    strip.classList.add("mode-normal");
    icon.textContent = "◉";
    text.textContent = "NORMAL MODE — blocking ads";
  } else {
    text.textContent = "SCANNING PAGE…";
  }
}

function renderDomains(counts) {
  const list  = document.getElementById("domainsList");
  const cnt   = document.getElementById("domainsCount");
  const pairs = topN(counts, 6);
  cnt.textContent = Object.keys(counts || {}).length;

  if (!pairs.length) {
    list.innerHTML = '<div class="domains-empty">No data — start browsing</div>';
    return;
  }

  const max = pairs[0][1];
  list.innerHTML = pairs.map(([domain, count], i) => {
    const pct = ((count / max) * 100).toFixed(0);
    return `<div class="domain-row">
      <span class="domain-rank">${i + 1}</span>
      <span class="domain-name">${esc(domain)}</span>
      <span class="domain-count">${fmtNum(count)}</span>
      <span class="domain-mini"><span class="domain-mini-fill" style="width:${pct}%"></span></span>
    </div>`;
  }).join("");
}

async function refresh() {
  chrome.storage.local.get(
    { adsBlocked: 0, trackersBlocked: 0, bandwidthSaved: 0, domainCounts: {}, siteModes: {} },
    async stats => {
      const ads  = stats.adsBlocked      || 0;
      const trk  = stats.trackersBlocked || 0;
      const bw   = stats.bandwidthSaved  || 0;
      const dc   = stats.domainCounts    || {};

      document.getElementById("adsBlocked").textContent      = fmtNum(ads);
      document.getElementById("trackersBlocked").textContent = fmtNum(trk);
      document.getElementById("bandwidthSaved").textContent  = fmtBytes(bw);
      document.getElementById("topDomain").textContent       = topEntry(dc)[0];
      document.getElementById("barTotal").textContent        = fmtNum(ads + trk) + " total";

      const total = ads + trk || 1;
      document.getElementById("segAds").style.width   = ((ads / total) * 100).toFixed(1) + "%";
      document.getElementById("segTrack").style.width = ((trk / total) * 100).toFixed(1) + "%";

      renderDomains(dc);

      const mode = await getCurrentMode(stats.siteModes);
      renderMode(mode);
    }
  );
}

document.getElementById("btnReset").addEventListener("click", () => {
  if (!confirm("Reset all b-AD statistics?")) return;
  chrome.storage.local.set(
    { adsBlocked: 0, trackersBlocked: 0, bandwidthSaved: 0, domainCounts: {}, siteModes: {} },
    refresh
  );
});

refresh();
setInterval(refresh, 2500);
