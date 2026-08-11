(function () {
  "use strict";

  let active = false;
  let currentTarget = null;
  let highlightBox = null;
  let labelBox = null;

  function generateSelector(el) {
    if (!el || el === document.body || el === document.documentElement) return "";
    if (el.id && !/\d{5,}/.test(el.id)) return "#" + CSS.escape(el.id);

    const parts = [];
    let curr = el;
    while (curr && curr.nodeType === 1 && curr !== document.body && curr !== document.documentElement) {
      let part = curr.tagName.toLowerCase();
      if (curr.id && !/\d{5,}/.test(curr.id)) {
        part += "#" + CSS.escape(curr.id);
        parts.unshift(part);
        break;
      }
      if (curr.className && typeof curr.className === "string") {
        const classes = curr.className.trim().split(/\s+/).filter(c => c && !c.startsWith("b-ad-") && !/\d{5,}/.test(c));
        if (classes.length) {
          part += "." + classes.slice(0, 2).map(c => CSS.escape(c)).join(".");
        }
      }
      const siblings = Array.from(curr.parentNode ? curr.parentNode.children : []).filter(c => c.tagName === curr.tagName);
      if (siblings.length > 1) {
        const index = siblings.indexOf(curr) + 1;
        part += `:nth-of-type(${index})`;
      }
      parts.unshift(part);
      curr = curr.parentNode;
    }
    return parts.join(" > ");
  }

  function createOverlay() {
    if (highlightBox) return;

    highlightBox = document.createElement("div");
    highlightBox.id = "b-ad-zap-highlight";
    highlightBox.style.cssText = `
      position: absolute !important;
      z-index: 2147483647 !important;
      pointer-events: none !important;
      border: 2px solid #ff3b30 !important;
      background: rgba(255, 59, 48, 0.2) !important;
      box-shadow: 0 0 12px rgba(255, 59, 48, 0.5) !important;
      transition: all 0.05s ease !important;
      border-radius: 4px !important;
      display: none !important;
    `;

    labelBox = document.createElement("div");
    labelBox.id = "b-ad-zap-label";
    labelBox.style.cssText = `
      position: absolute !important;
      top: -24px !important;
      left: 0 !important;
      background: #ff3b30 !important;
      color: #ffffff !important;
      font-family: monospace !important;
      font-size: 11px !important;
      font-weight: bold !important;
      padding: 2px 6px !important;
      border-radius: 3px !important;
      white-space: nowrap !important;
      box-shadow: 0 2px 6px rgba(0,0,0,0.4) !important;
    `;
    highlightBox.appendChild(labelBox);
    (document.body || document.documentElement).appendChild(highlightBox);
  }

  function updateOverlay(el) {
    if (!el || !highlightBox) return;
    const rect = el.getBoundingClientRect();
    const scrollX = window.scrollX || window.pageXOffset;
    const scrollY = window.scrollY || window.pageYOffset;

    highlightBox.style.width = rect.width + "px";
    highlightBox.style.height = rect.height + "px";
    highlightBox.style.left = (rect.left + scrollX) + "px";
    highlightBox.style.top = (rect.top + scrollY) + "px";
    highlightBox.style.display = "block";

    const tag = el.tagName.toLowerCase();
    const cls = el.className && typeof el.className === "string" ? "." + el.className.trim().split(/\s+/)[0] : "";
    labelBox.textContent = `<${tag}${cls}> (Click to Zap, Esc to Exit)`;
  }

  function showToast(msg) {
    const toast = document.createElement("div");
    toast.style.cssText = `
      position: fixed !important;
      bottom: 20px !important;
      right: 20px !important;
      z-index: 2147483647 !important;
      background: #121620 !important;
      color: #30d158 !important;
      border: 1px solid #30d158 !important;
      padding: 10px 16px !important;
      border-radius: 8px !important;
      font-family: sans-serif !important;
      font-size: 12px !important;
      font-weight: 600 !important;
      box-shadow: 0 4px 16px rgba(0,0,0,0.5) !important;
      animation: fadeIn 0.2s ease !important;
    `;
    toast.textContent = "⚡ " + msg;
    (document.body || document.documentElement).appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
  }

  function onMouseMove(e) {
    if (!active) return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || el === highlightBox || el.id === "b-ad-zap-highlight" || el.id === "b-ad-zap-label") return;
    currentTarget = el;
    updateOverlay(el);
  }

  function onClick(e) {
    if (!active || !currentTarget) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    const selector = generateSelector(currentTarget);
    if (selector) {
      try {
        currentTarget.style.setProperty("display", "none", "important");
      } catch (_) {}

      chrome.storage.local.get({ customSelectors: [] }, data => {
        const list = Array.from(new Set([...(data.customSelectors || []), selector]));
        chrome.storage.local.set({ customSelectors: list }, () => {
          showToast(`Zapped element! Custom rule saved: ${selector}`);
          try {
            chrome.runtime.sendMessage({ type: "BAD_BLOCKED", url: location.hostname, kind: "ad" });
          } catch (_) {}
        });
      });
    }

    stopZapper();
  }

  function onKeyDown(e) {
    if (!active) return;
    if (e.key === "Escape") {
      stopZapper();
      showToast("Element Zapper cancelled.");
    }
  }

  function startZapper() {
    if (active) return;
    active = true;
    createOverlay();
    document.addEventListener("mousemove", onMouseMove, true);
    document.addEventListener("click", onClick, true);
    document.addEventListener("keydown", onKeyDown, true);
    document.body.style.cursor = "crosshair";
  }

  function stopZapper() {
    active = false;
    if (highlightBox) highlightBox.style.display = "none";
    document.removeEventListener("mousemove", onMouseMove, true);
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("keydown", onKeyDown, true);
    document.body.style.cursor = "";
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === "START_ZAPPER") {
      startZapper();
      sendResponse({ ok: true });
    }
    if (msg.type === "STOP_ZAPPER") {
      stopZapper();
      sendResponse({ ok: true });
    }
  });
})();
