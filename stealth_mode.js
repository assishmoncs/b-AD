/* Optional page-world privacy helpers. Enabled only after the isolated script
 * confirms both the user setting and the site's stealth mode. */
(() => {
  "use strict";

  if (window.__bAD_Stealth_Initialized__) return;
  Object.defineProperty(window, "__bAD_Stealth_Initialized__", { value: true });

  const enabled = () => {
    const root = document.documentElement;
    return root?.dataset.badStealthActive === "1" && root.dataset.badMode === "stealth";
  };
  const baitTokens = ["adsbox", "ad-placeholder", "ad-tester", "pub_300x250", "pub_728x90"];
  const isBait = element => {
    if (!enabled() || !(element instanceof HTMLElement)) return false;
    const name = `${element.id} ${typeof element.className === "string" ? element.className : ""}`.toLowerCase();
    return baitTokens.some(token => name.includes(token));
  };

  for (const property of ["offsetHeight", "offsetWidth", "clientHeight", "clientWidth"]) {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, property);
    if (!descriptor?.get) continue;
    Object.defineProperty(HTMLElement.prototype, property, {
      configurable: true,
      get() {
        const actual = descriptor.get.call(this);
        if (actual === 0 && isBait(this)) return property.includes("Width") ? 300 : 250;
        return actual;
      }
    });
  }

  const nativeGetComputedStyle = window.getComputedStyle;
  window.getComputedStyle = function (element, pseudo) {
    const style = nativeGetComputedStyle.call(window, element, pseudo);
    if (pseudo || !isBait(element)) return style;
    return new Proxy(style, {
      get(target, property) {
        if (property === "display") return "block";
        if (property === "visibility") return "visible";
        if (property === "getPropertyValue") {
          return name => name === "display" ? "block" : name === "visibility" ? "visible" : target.getPropertyValue(name);
        }
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      }
    });
  };

  const nativeToDataURL = HTMLCanvasElement.prototype.toDataURL;
  const noise = Math.floor(Math.random() * 5) + 1;
  HTMLCanvasElement.prototype.toDataURL = function (...args) {
    if (!enabled() || !this.width || !this.height || this.width > 1200 || this.height > 1200) {
      return nativeToDataURL.apply(this, args);
    }
    try {
      const clone = document.createElement("canvas");
      clone.width = this.width;
      clone.height = this.height;
      const context = clone.getContext("2d");
      context.drawImage(this, 0, 0);
      const image = context.getImageData(0, 0, 1, 1);
      image.data[0] = (image.data[0] + noise) & 255;
      context.putImageData(image, 0, 0);
      return nativeToDataURL.apply(clone, args);
    } catch (_) {
      return nativeToDataURL.apply(this, args);
    }
  };
})();
