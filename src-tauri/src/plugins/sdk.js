// NotNotch plugin API, version 1 (docs/plugins.md). NotNotch puts this script first in every plugin page, before the
// plugin's own scripts. The page runs in a sandboxed frame with an opaque origin; its only way out is this
// message channel to NotNotch, which checks every message again.
(() => {
  "use strict";
  // The page's CSP blocks fetch, sockets, images and forms from other hosts but not WebRTC, which can reach any
  // server through ICE. Its constructors go before plugin code runs.
  for (const name of ["RTCPeerConnection", "webkitRTCPeerConnection", "RTCDataChannel", "RTCRtpSender", "RTCRtpReceiver", "RTCRtpTransceiver"]) {
    try { delete window[name]; } catch { /* not there */ }
  }
  // No clipboard: no Clipboard API, no execCommand copy, and copy, cut and paste events never reach the page.
  try { delete Navigator.prototype.clipboard; } catch { /* not there */ }
  try { Object.defineProperty(Document.prototype, "execCommand", { value: () => false, writable: false, configurable: false }); } catch { /* not there */ }
  for (const type of ["copy", "cut", "paste"]) window.addEventListener(type, (e) => e.stopImmediatePropagation(), true);
  // A nested frame would bring fresh copies of what was removed: frames are taken away as soon as they appear.
  for (const C of [window.HTMLIFrameElement, window.HTMLFrameElement, window.HTMLObjectElement, window.HTMLEmbedElement]) {
    for (const p of ["contentWindow", "contentDocument"]) {
      try { if (C) Object.defineProperty(C.prototype, p, { get: () => null, configurable: false }); } catch { /* not there */ }
    }
  }
  new MutationObserver((records) => {
    for (const r of records) for (const n of r.addedNodes) {
      if (n.nodeType !== 1) continue;
      if (/^(IFRAME|FRAME|OBJECT|EMBED)$/.test(n.nodeName)) n.remove();
      else n.querySelectorAll?.("iframe,frame,object,embed").forEach((f) => f.remove());
    }
  }).observe(document, { childList: true, subtree: true });

  const pending = new Map();
  const listeners = new Map();
  let next = 1;
  const call = (type, args) =>
    new Promise((resolve, reject) => {
      const id = next++;
      pending.set(id, { resolve, reject });
      parent.postMessage({ notnotch: 1, id, type, ...args }, "*");
    });
  window.addEventListener("message", (e) => {
    const d = e.data;
    if (e.source !== parent || !d || d.notnotch !== 1) return;
    if (typeof d.event === "string") {
      for (const fn of listeners.get(d.event) ?? []) {
        try { fn(d.data); } catch (err) { console.error(err); }
      }
      return;
    }
    const p = pending.get(d.id);
    if (!p) return;
    pending.delete(d.id);
    if (d.ok) p.resolve(d.result);
    else p.reject(new Error(d.error));
  });
  const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

  const notnotch = Object.freeze({
    api: 1,
    /** { api, plugin: { id, name, version }, permissions, theme, language } */
    hello: () => call("hello"),
    theme: () => call("theme"),
    storage: Object.freeze({
      get: (key) => call("storage.get", { key }),
      set: (key, value) => call("storage.set", { key, value }),
      remove: (key) => call("storage.remove", { key }),
      keys: () => call("storage.keys"),
    }),
    /** { status, contentType, body } */
    fetch: (url, init = {}) => call("fetch", clean({ url, method: init.method, headers: init.headers, body: init.body })),
    notify: (title, body) => call("notify", clean({ title, body })),
    resize: (w, h) => call("resize", { w, h }),
    /** "theme": new theme tokens when NotNotch's theme changes. Returns a function that stops listening. */
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(fn);
      return () => listeners.get(event).delete(fn);
    },
  });
  Object.defineProperty(window, "notnotch", { value: notnotch, writable: false, configurable: false, enumerable: true });
})();
