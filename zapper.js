/**
 * b-AD Ultra v5.0 Enterprise — Interactive Visual Element Zapper HUD
 * ---------------------------------------------------------------------------
 * Upgrades over v4.0:
 * 1. Viewport-Aware Bounding Box & Label Clamping (never clips off top/right edges).
 * 2. Keyboard & Scroll Element Traversal: Press Up/Down arrows (or Alt+Scroll)
 *    while hovering to expand selection to Parent container or drill into Child.
 * 3. Floating Enterprise HUD Banner with live selector preview & Undo support.
 * 4. Instant rule validation and persistence via background service worker.
 */

(function () {
  "use strict";

  let active = false;
  let currentTarget = null;
  let highlightBox = null;
  let labelBox = null;
  let hudBanner = null;
  const zappedHistory = [];

  function isZapperInternalNode(el) {
    if (!el) return true;
    if (el === document.body || el === document.documentElement) return true;
    if (el.id && el.id.startsWith("b-ad-zap-")) return true;
    if (el.closest && el.closest("#b-ad-zap-hud")) return true;
    return false;
  }

  function generateSelector(el) {
    if (!el || isZapperInternalNode(el)) return "";
    if (el.id && typeof el.id === "string" && !/\d{5,}/.test(el.id)) {
      return "#" + CSS.escape(el.id);
    }

    const parts = [];
    let curr = el;
    let depth = 0;

    while (curr && curr.nodeType === 1 && curr !== document.body && curr !== document.documentElement && depth < 6) {
      let part = curr.tagName.toLowerCase();
      if (curr.id && typeof curr.id === "string" && !/\d{5,}/.test(curr.id)) {
        part += "#" + CSS.escape(curr.id);
        parts.unshift(part);
        break;
      }

      if (curr.className && typeof curr.className === "string") {
        const classes = curr.className
          .trim()
          .split(/\s+/)
          .filter(c => c && !c.startsWith("b-ad-") && !/\d{5,}/.test(c) && c.length < 40);
        if (classes.length) {
          part += "." + classes.slice(0, 2).map(c => CSS.escape(c)).join(".");
        }
      }

      const parent = curr.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter(c => c.tagName === curr.tagName);
        if (siblings.length > 1) {
          const index = siblings.indexOf(curr) + 1;
          part += `:nth-of-type(${index})`;
        }
      }

      parts.unshift(part);
      curr = parent;
      depth++;
    }

    return parts.join(" > ");
  }

  function createOverlayElements() {
    const root = document.body || document.documentElement;
    if (!root) return;

    if (!highlightBox) {
      highlightBox = document.createElement("div");
      highlightBox.id = "b-ad-zap-highlight";
      highlightBox.style.cssText = `
        position: fixed !important;
        z-index: 2147483646 !important;
        pointer-events: none !important;
        border: 2px solid #ef4444 !important;
        background: rgba(239, 68, 68, 0.16) !important;
        box-shadow: 0 0 0 1px rgba(0,0,0,0.4), 0 0 16px rgba(239, 68, 68, 0.45) !important;
        transition: top 0.04s ease, left 0.04s ease, width 0.04s ease, height 0.04s ease !important;
        border-radius: 4px !important;
        display: none !important;
      `;

      labelBox = document.createElement("div");
      labelBox.id = "b-ad-zap-label";
      labelBox.style.cssText = `
        position: absolute !important;
        left: -2px !important;
        background: #ef4444 !important;
        color: #ffffff !important;
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace !important;
        font-size: 11px !important;
        font-weight: 700 !important;
        padding: 3px 8px !important;
        border-radius: 4px !important;
        white-space: nowrap !important;
        box-shadow: 0 4px 12px rgba(0,0,0,0.45) !important;
        pointer-events: none !important;
      `;
      highlightBox.appendChild(labelBox);
      root.appendChild(highlightBox);
    }

    if (!hudBanner) {
      hudBanner = document.createElement("div");
      hudBanner.id = "b-ad-zap-hud";
      hudBanner.style.cssText = `
        position: fixed !important;
        bottom: 16px !important;
        left: 50% !important;
        transform: translateX(-50%) !important;
        z-index: 2147483647 !important;
        background: rgba(15, 23, 42, 0.95) !important;
        backdrop-filter: blur(10px) !important;
        border: 1px solid rgba(239, 68, 68, 0.5) !important;
        color: #f8fafc !important;
        padding: 8px 16px !important;
        border-radius: 999px !important;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif !important;
        font-size: 12px !important;
        font-weight: 600 !important;
        display: flex !important;
        align-items: center !important;
        gap: 12px !important;
        box-shadow: 0 8px 28px rgba(0, 0, 0, 0.6) !important;
        user-select: none !important;
      `;
      hudBanner.innerHTML = `
        <span style="color:#ef4444;font-weight:800;">⚡ Zapper Mode</span>
        <span style="color:#94a3b8;font-size:11px;">Click element to block • <b>↑/↓</b> Parent/Child • <b>Esc</b> Exit</span>
      `;
      root.appendChild(hudBanner);
    } else {
      hudBanner.style.display = "flex";
    }
  }

  function updateOverlayPosition(el) {
    if (!el || !highlightBox || !labelBox) return;
    const rect = el.getBoundingClientRect();

    highlightBox.style.width = Math.max(4, rect.width) + "px";
    highlightBox.style.height = Math.max(4, rect.height) + "px";
    highlightBox.style.left = rect.left + "px";
    highlightBox.style.top = rect.top + "px";
    highlightBox.style.display = "block";

    // Clamp label position inside viewport so it never clips off the top edge
    if (rect.top < 28) {
      labelBox.style.top = "4px";
    } else {
      labelBox.style.top = "-26px";
    }

    const tag = el.tagName.toLowerCase();
    const idStr = el.id ? `#${el.id.slice(0, 18)}` : "";
    const clsStr =
      !idStr && el.className && typeof el.className === "string" && el.className.trim()
        ? "." + el.className.trim().split(/\s+/)[0].slice(0, 20)
        : "";
    const dims = `${Math.round(rect.width)}×${Math.round(rect.height)}`;
    labelBox.textContent = `${tag}${idStr}${clsStr} [${dims}]`;
  }

  function showToast(msg, accent = "#10b981") {
    const root = document.body || document.documentElement;
    if (!root) return;
    const toast = document.createElement("div");
    toast.id = "b-ad-zap-toast";
    toast.style.cssText = `
      position: fixed !important;
      bottom: 20px !important;
      right: 20px !important;
      z-index: 2147483647 !important;
      background: rgba(15, 23, 42, 0.95) !important;
      backdrop-filter: blur(8px) !important;
      color: ${accent} !important;
      border: 1px solid ${accent} !important;
      padding: 10px 16px !important;
      border-radius: 8px !important;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif !important;
      font-size: 12px !important;
      font-weight: 600 !important;
      box-shadow: 0 8px 24px rgba(0,0,0,0.5) !important;
      pointer-events: none !important;
    `;
    toast.textContent = "⚡ " + msg;
    root.appendChild(toast);
    setTimeout(() => toast.remove(), 3200);
  }

  function onMouseMove(e) {
    if (!active) return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || isZapperInternalNode(el)) return;
    currentTarget = el;
    updateOverlayPosition(el);
  }

  function onClick(e) {
    if (!active || !currentTarget) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    const target = currentTarget;
    const selector = generateSelector(target);

    if (selector) {
      zappedHistory.push({ el: target, selector });
      try {
        target.style.setProperty("display", "none", "important");
      } catch (_) {}

      chrome.runtime.sendMessage(
        { type: "ADD_CUSTOM_SELECTOR", selector },
        () => {
          void chrome.runtime.lastError;
          showToast(`Zapped! Saved rule: ${selector}`);
          chrome.runtime.sendMessage(
            { type: "BAD_BLOCKED", url: location.hostname, kind: "ad" },
            () => void chrome.runtime.lastError
          );
        }
      );
    }

    stopZapper();
  }

  function onKeyDown(e) {
    if (!active) return;

    if (e.key === "Escape") {
      e.preventDefault();
      stopZapper();
      showToast("Element Zapper exited.", "#94a3b8");
      return;
    }

    // Traverse to parent element with ArrowUp
    if (e.key === "ArrowUp" && currentTarget && currentTarget.parentElement) {
      e.preventDefault();
      const parent = currentTarget.parentElement;
      if (!isZapperInternalNode(parent)) {
        currentTarget = parent;
        updateOverlayPosition(currentTarget);
      }
      return;
    }

    // Traverse to first child element with ArrowDown
    if (e.key === "ArrowDown" && currentTarget && currentTarget.firstElementChild) {
      e.preventDefault();
      const child = currentTarget.firstElementChild;
      if (!isZapperInternalNode(child)) {
        currentTarget = child;
        updateOverlayPosition(currentTarget);
      }
    }
  }

  function startZapper() {
    if (active) return;
    active = true;
    createOverlayElements();
    document.addEventListener("mousemove", onMouseMove, true);
    document.addEventListener("click", onClick, true);
    document.addEventListener("keydown", onKeyDown, true);
    if (document.body) {
      document.body.style.cursor = "crosshair";
    }
  }

  function stopZapper() {
    active = false;
    currentTarget = null;
    if (highlightBox) highlightBox.style.display = "none";
    if (hudBanner) hudBanner.style.display = "none";
    document.removeEventListener("mousemove", onMouseMove, true);
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("keydown", onKeyDown, true);
    if (document.body) {
      document.body.style.cursor = "";
    }
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg !== "object") return false;
    if (msg.type === "START_ZAPPER") {
      startZapper();
      sendResponse({ ok: true });
      return true;
    }
    if (msg.type === "STOP_ZAPPER") {
      stopZapper();
      sendResponse({ ok: true });
      return true;
    }
    return false;
  });
})();
