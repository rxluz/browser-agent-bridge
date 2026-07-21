// Browser Agent Bridge - background service worker (Manifest V3)
// Connects to a local bridge server over WebSocket and executes browser
// commands (open tabs, navigate, read content, screenshot, interact).

const DEFAULTS = { host: "127.0.0.1", port: 8765, token: "" };

let connected = false;

async function getConfig() {
  const stored = await chrome.storage.local.get(["host", "port", "token"]);
  return { ...DEFAULTS, ...stored };
}

function setBadge(ok) {
  chrome.action.setBadgeText({ text: ok ? "on" : "off" });
  chrome.action.setBadgeBackgroundColor({ color: ok ? "#0a7d33" : "#a00" });
}

let socket = null;
let reconnectTimer = null;

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, 5000);
}

function sendToBridge(message, target = socket) {
  if (target && target.readyState === WebSocket.OPEN) {
    target.send(JSON.stringify(message));
  }
}

async function connect(newCfg) {
  const cfg = newCfg ? { ...DEFAULTS, ...newCfg } : await getConfig();

  if (!cfg.token || cfg.token.length < 32) {
    connected = false;
    setBadge(false);
    return;
  }

  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  let next;
  try {
    next = new WebSocket(
      `ws://${cfg.host}:${cfg.port}/?token=${encodeURIComponent(cfg.token)}&role=extension`
    );
  } catch (e) {
    connected = false;
    setBadge(false);
    scheduleReconnect();
    return;
  }

  socket = next;
  next.onopen = () => {
    if (socket !== next) return;
    connected = true;
    setBadge(true);
  };
  next.onclose = () => {
    if (socket !== next) return;
    socket = null;
    connected = false;
    setBadge(false);
    scheduleReconnect();
  };
  next.onerror = () => {
    try { next.close(); } catch (e) { /* noop */ }
  };
  next.onmessage = async (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch (e) {
      return;
    }
    if (message.type === "ping") {
      sendToBridge({ type: "pong" }, next);
      return;
    }
    if (!message.id || !message.action) return;

    try {
      const result = await handle(message.action, message.params || {});
      sendToBridge({ id: message.id, ok: true, result }, next);
    } catch (e) {
      sendToBridge({
        id: message.id,
        ok: false,
        error: String((e && e.message) || e)
      }, next);
    }
  };
}

// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------

function tabInfo(t) {
  if (!t) return null;
  return {
    id: t.id,
    url: t.url,
    title: t.title,
    active: t.active,
    windowId: t.windowId,
    index: t.index,
    status: t.status
  };
}

async function activeTabId() {
  const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!t) throw new Error("No active tab");
  return t.id;
}

async function runInPage(p, func, args) {
  const tabId = p.tabId != null ? p.tabId : await activeTabId();
  const [inj] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
  return inj.result;
}

// Universal in-page JavaScript execution.
// Uses the chrome.userScripts API (USER_SCRIPT world), which is NOT subject to
// the page's Content-Security-Policy, so arbitrary code runs on ANY site
// (including strict-CSP apps). The USER_SCRIPT world doesn't return the
// completion value from execute(), so the injected code posts its result back
// via chrome.runtime.sendMessage (received on onUserScriptMessage). This also
// transparently supports async code (a returned Promise is awaited).
// Falls back to MAIN-world eval when the userScripts API isn't enabled.
let userWorldConfigured = false;
let evalSeq = 0;
const evalPending = new Map(); // rid -> { resolve, reject, timer }

if (chrome.runtime.onUserScriptMessage) {
  chrome.runtime.onUserScriptMessage.addListener((msg) => {
    if (msg && msg.ch === "agent" && msg.kind === "evalResult") {
      const p = evalPending.get(msg.rid);
      if (p) {
        clearTimeout(p.timer);
        evalPending.delete(msg.rid);
        p.resolve(msg);
      }
    }
  });
}

async function evalInPage(tabId, code) {
  if (chrome.userScripts) {
    if (!userWorldConfigured) {
      try {
        await chrome.userScripts.configureWorld({
          csp: "script-src 'self' 'unsafe-eval' 'unsafe-inline'",
          messaging: true
        });
      } catch (e) { /* best effort */ }
      userWorldConfigured = true;
    }

    const rid = "e" + ++evalSeq + "_" + Date.now();
    const wrapped =
      "(() => { var __rid=" + JSON.stringify(rid) + ";" +
      " var __post=function(m){ try{ chrome.runtime.sendMessage(Object.assign({ch:'agent',kind:'evalResult',rid:__rid},m)); }catch(e){} };" +
      " try {" +
      "   var v = (0, eval)(" + JSON.stringify(code) + ");" +
      "   Promise.resolve(v).then(function(val){ var o; try{o=JSON.parse(JSON.stringify(val));}catch(e){o=(val===undefined?null:String(val));} __post({ok:true,value:o}); }," +
      "     function(err){ __post({ok:false,error:String((err&&err.message)||err)}); });" +
      " } catch(e){ __post({ok:false,error:String((e&&e.message)||e)}); } })()";

    const resultPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        evalPending.delete(rid);
        reject(new Error("eval timeout waiting for page result"));
      }, 30000);
      evalPending.set(rid, { resolve, reject, timer });
    });

    await chrome.userScripts.execute({
      target: { tabId },
      js: [{ code: wrapped }],
      world: "USER_SCRIPT",
      injectImmediately: true
    });

    const msg = await resultPromise;
    if (!msg.ok) throw new Error(msg.error || "eval error");
    return msg.value;
  }

  // Fallback: MAIN world (page CSP applies; fails on strict-CSP sites).
  try {
    const [inj] = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: (c) => {
        const v = (0, eval)(c);
        return typeof v === "object" && v !== null ? JSON.parse(JSON.stringify(v)) : v;
      },
      args: [code]
    });
    return inj.result;
  } catch (e) {
    throw new Error(
      "eval blocked (likely by the page CSP). Enable this extension's " +
        "'Allow user scripts' toggle in chrome://extensions > Details. (" +
        String((e && e.message) || e) + ")"
    );
  }
}

// ---------------------------------------------------------------------------
// Trusted input via chrome.debugger (CDP Input domain).
// Synthetic DOM events (isTrusted:false) are ignored by hardened editors
// (Lexical, Draft.js, ProseMirror, Google Docs Kix, etc.) for deletion and
// key handling. CDP-dispatched input is trusted, so it works on ANY site.
// These are generic primitives; no site-specific logic lives here.
// ---------------------------------------------------------------------------
function dbgAttach(tabId) {
  return new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId }, "1.3", () => {
      const e = chrome.runtime.lastError;
      if (e && !/already attached/i.test(e.message)) reject(new Error(e.message));
      else resolve();
    });
  });
}
function dbgSend(tabId, method, params) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params || {}, (r) => {
      const e = chrome.runtime.lastError;
      if (e) reject(new Error(e.message));
      else resolve(r);
    });
  });
}
function dbgDetach(tabId) {
  return new Promise((resolve) => {
    chrome.debugger.detach({ tabId }, () => {
      void chrome.runtime.lastError;
      resolve();
    });
  });
}

// Modifier bitmask: Alt=1, Ctrl=2, Meta/Cmd=4, Shift=8.
const KEYMAP = {
  Enter: { windowsVirtualKeyCode: 13, code: "Enter", key: "Enter", text: "\r" },
  Backspace: { windowsVirtualKeyCode: 8, code: "Backspace", key: "Backspace" },
  Delete: { windowsVirtualKeyCode: 46, code: "Delete", key: "Delete" },
  Tab: { windowsVirtualKeyCode: 9, code: "Tab", key: "Tab" },
  Escape: { windowsVirtualKeyCode: 27, code: "Escape", key: "Escape" },
  Space: { windowsVirtualKeyCode: 32, code: "Space", key: " ", text: " " },
  ArrowLeft: { windowsVirtualKeyCode: 37, code: "ArrowLeft", key: "ArrowLeft" },
  ArrowUp: { windowsVirtualKeyCode: 38, code: "ArrowUp", key: "ArrowUp" },
  ArrowRight: { windowsVirtualKeyCode: 39, code: "ArrowRight", key: "ArrowRight" },
  ArrowDown: { windowsVirtualKeyCode: 40, code: "ArrowDown", key: "ArrowDown" },
  Home: { windowsVirtualKeyCode: 36, code: "Home", key: "Home" },
  End: { windowsVirtualKeyCode: 35, code: "End", key: "End" },
  PageUp: { windowsVirtualKeyCode: 33, code: "PageUp", key: "PageUp" },
  PageDown: { windowsVirtualKeyCode: 34, code: "PageDown", key: "PageDown" }
};

function keySpec(key) {
  if (KEYMAP[key]) return Object.assign({}, KEYMAP[key]);
  if (typeof key === "string" && key.length === 1) {
    const isAlpha = /[a-zA-Z]/.test(key);
    return {
      key,
      code: isAlpha ? "Key" + key.toUpperCase() : "",
      text: key,
      windowsVirtualKeyCode: key.toUpperCase().charCodeAt(0)
    };
  }
  return null;
}

const KEY_ALIASES = {
  backspace: "Backspace",
  del: "Delete",
  delete: "Delete",
  down: "ArrowDown",
  end: "End",
  enter: "Enter",
  esc: "Escape",
  escape: "Escape",
  home: "Home",
  left: "ArrowLeft",
  pagedown: "PageDown",
  pageup: "PageUp",
  return: "Enter",
  right: "ArrowRight",
  space: "Space",
  spacebar: "Space",
  tab: "Tab",
  up: "ArrowUp"
};

const MODIFIER_ALIASES = {
  alt: 1,
  cmd: 4,
  command: 4,
  control: 2,
  ctrl: 2,
  meta: 4,
  option: 1,
  shift: 8
};

function normalizeKeyInput(key, modifiers) {
  if (typeof key !== "string" || key.length === 0) {
    throw new Error("key must be a non-empty string");
  }

  let normalizedModifiers = Number.isInteger(modifiers) ? modifiers : 0;
  const parts = key.split("+").map((part) => part.trim()).filter(Boolean);
  const rawKey = parts.pop() || key;

  for (const modifier of parts) {
    const bit = MODIFIER_ALIASES[modifier.toLowerCase()];
    if (!bit) throw new Error("Unknown key modifier: " + modifier);
    normalizedModifiers |= bit;
  }

  const normalizedKey = KEY_ALIASES[rawKey.toLowerCase()] || rawKey;
  return { key: normalizedKey, modifiers: normalizedModifiers };
}

function targetFromParams(p) {
  if (typeof p.selector === "string" && p.selector) return { selector: p.selector };
  const agentId = p.agentId != null ? p.agentId : p.id;
  if (agentId != null) return { agentId: String(agentId) };
  return null;
}

function targetFromFocus(focus) {
  if (typeof focus === "string" && focus) return { selector: focus };
  if (focus && typeof focus === "object" && !Array.isArray(focus)) {
    return targetFromParams(focus);
  }
  return null;
}

// Resolves controls through open shadow roots and same-origin frames, matching
// the snapshot/click lookup model. It also verifies focus before trusted input.
function targetOperationFn(target, operation, text) {
  function selectorFor(t) {
    if (!t) return null;
    if (t.selector) return t.selector;
    if (t.agentId != null) return '[data-agent-id="' + String(t.agentId).replace(/"/g, '\\"') + '"]';
    return null;
  }

  function find(root, selector) {
    var direct = null;
    try { direct = root.querySelector ? root.querySelector(selector) : null; } catch (e) { return null; }
    if (direct) return direct;

    var all = [];
    try { all = root.querySelectorAll ? root.querySelectorAll("*") : []; } catch (e) { return null; }
    for (var i = 0; i < all.length; i++) {
      var node = all[i];
      if (node.shadowRoot) {
        var shadowMatch = find(node.shadowRoot, selector);
        if (shadowMatch) return shadowMatch;
      }
      if (node.tagName === "IFRAME") {
        try {
          var doc = node.contentDocument;
          if (doc) {
            var frameMatch = find(doc, selector);
            if (frameMatch) return frameMatch;
          }
        } catch (e) { /* cross-origin frame */ }
      }
    }
    return null;
  }

  var el = target && target.active ? document.activeElement : find(document, selectorFor(target));
  if (!el) return { ok: false, reason: "not found" };

  try { el.scrollIntoView({ block: "center", inline: "center" }); } catch (e) {}
  try { el.focus({ preventScroll: true }); } catch (e) { try { el.focus(); } catch (ignored) {} }
  var root = el.getRootNode ? el.getRootNode() : el.ownerDocument;
  if (el.ownerDocument.activeElement !== el && (!root || root.activeElement !== el)) {
    return { ok: false, reason: "could not focus target" };
  }

  if (operation === "focus") return { ok: true, tag: el.tagName.toLowerCase() };

  if (operation === "type") {
    if ("value" in el) {
      var win = el.ownerDocument.defaultView;
      var proto = el.tagName === "TEXTAREA"
        ? win.HTMLTextAreaElement.prototype
        : win.HTMLInputElement.prototype;
      var desc = Object.getOwnPropertyDescriptor(proto, "value");
      if (desc && desc.set) desc.set.call(el, text);
      else el.value = text;
      if (el._valueTracker && el._valueTracker.setValue) el._valueTracker.setValue("");
    } else if (el.isContentEditable) {
      el.textContent = text;
    } else {
      return { ok: false, reason: "target is not editable" };
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true, typed: true };
  }

  if (operation === "select") {
    if (typeof el.select === "function" && "value" in el) {
      el.select();
    } else if (el.isContentEditable) {
      var range = el.ownerDocument.createRange();
      range.selectNodeContents(el);
      var selection = el.ownerDocument.defaultView.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    } else {
      return { ok: false, reason: "target is not editable" };
    }
    return { ok: true };
  }

  return { ok: false, reason: "unknown target operation" };
}

async function targetOperation(tabId, target, operation, text) {
  const [inj] = await chrome.scripting.executeScript({
    target: { tabId },
    func: targetOperationFn,
    args: [target, operation, text]
  });
  const result = inj && inj.result;
  if (!result || !result.ok) {
    throw new Error("Target " + ((result && result.reason) || "could not be resolved"));
  }
  return result;
}

async function focusInPage(tabId, target) {
  return targetOperation(tabId, target, "focus", "");
}

async function pressKey(tabId, key, modifiers, count) {
  const spec = keySpec(key);
  if (!spec) throw new Error("Unknown key: " + key);
  const mods = modifiers || 0;
  const isCombo = (mods & (1 | 2 | 4)) !== 0; // Alt/Ctrl/Meta -> command, not text
  const n = count || 1;
  await dbgAttach(tabId);
  try {
    for (let i = 0; i < n; i++) {
      const down = Object.assign({ type: spec.text && !isCombo ? "keyDown" : "rawKeyDown", modifiers: mods }, spec);
      if (isCombo) delete down.text;
      if ((mods & (2 | 4)) !== 0 && spec.code === "KeyA") {
        down.commands = ["selectAll"];
      }
      await dbgSend(tabId, "Input.dispatchKeyEvent", down);
      await dbgSend(tabId, "Input.dispatchKeyEvent", Object.assign({ type: "keyUp", modifiers: mods }, spec, { text: undefined }));
    }
  } finally {
    await dbgDetach(tabId);
  }
}

// Trusted mouse click at absolute (top-document) viewport coordinates via CDP.
async function clickAt(tabId, x, y, clickCount) {
  await dbgAttach(tabId);
  try {
    await dbgSend(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await dbgSend(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: clickCount || 1 });
    await dbgSend(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: clickCount || 1 });
  } finally {
    await dbgDetach(tabId);
  }
}

// ---------------------------------------------------------------------------
// Injected DOM snapshot: a lean, generic "interactive element" walker.
// Pierces open shadow DOM and same-origin iframes, tags each element with a
// data-agent-id and returns absolute (top-document) center coordinates so the
// agent can act by coordinate (works even inside iframes / canvas apps).
// Runs in the isolated content-script world via chrome.scripting (func form,
// so it is NOT subject to the page CSP). No site-specific logic.
// ---------------------------------------------------------------------------
function agentSnapshotFn(opts) {
  opts = opts || {};
  var max = opts.max || 200;
  var viewportOnly = !!opts.viewportOnly;
  var TW = window.innerWidth || 0;
  var TH = window.innerHeight || 0;
  var out = [];
  var idc = 0;
  // Clear stale ids across open shadow DOM and same-origin frames so the
  // IDs returned by this snapshot map to exactly one current element.
  function clearIds(node) {
    if (!node) return;
    if (node.nodeType === 1) {
      try { node.removeAttribute("data-agent-id"); } catch (e) {}
      if (node.shadowRoot) clearIds(node.shadowRoot);
      if (node.tagName === "IFRAME") {
        try { clearIds(node.contentDocument && node.contentDocument.documentElement); } catch (e) {}
      }
    }
    var children = node.childNodes;
    if (children) for (var i = 0; i < children.length; i++) clearIds(children[i]);
  }
  clearIds(document.documentElement);
  var ITAGS = { A: 1, BUTTON: 1, INPUT: 1, SELECT: 1, TEXTAREA: 1, SUMMARY: 1, LABEL: 1, OPTION: 1 };
  var IROLES = { button: 1, link: 1, menuitem: 1, menuitemcheckbox: 1, menuitemradio: 1, radio: 1, checkbox: 1, tab: 1, "switch": 1, combobox: 1, searchbox: 1, textbox: 1, option: 1, slider: 1, listbox: 1, treeitem: 1 };
  function vis(el) {
    var r;
    try { r = el.getBoundingClientRect(); } catch (e) { return null; }
    if (r.width <= 1 || r.height <= 1) return null;
    var s;
    try { s = getComputedStyle(el); } catch (e) { return null; }
    if (s.visibility === "hidden" || s.display === "none" || parseFloat(s.opacity) === 0) return null;
    return r;
  }
  function interactiveKind(el) {
    if (ITAGS[el.tagName]) return el.disabled ? null : "tag";
    var role = el.getAttribute && el.getAttribute("role");
    if (role && IROLES[role.toLowerCase()]) return "role";
    if (el.isContentEditable) return "editable";
    if (el.hasAttribute && (el.hasAttribute("onclick") || el.getAttribute("tabindex") === "0")) return "attr";
    try { if (getComputedStyle(el).cursor === "pointer") return "cursor"; } catch (e) {}
    return null;
  }
  function nameOf(el) {
    var g = el.getAttribute ? function (a) { return el.getAttribute(a); } : function () { return null; };
    var n = g("aria-label") || g("placeholder") || g("title") || g("name") || g("alt");
    if (!n) {
      var t = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
      n = t || (el.value ? String(el.value) : "");
    }
    return (n || "").slice(0, 140);
  }
  function rec(node, ox, oy, parentCaptured) {
    if (out.length >= max) return;
    var capturedHere = false;
    if (node.nodeType === 1) {
      var el = node;
      var r = vis(el);
      var kind = r ? interactiveKind(el) : null;
      if (kind) {
        // Skip descendants of an already-captured widget unless this element is
        // distinctly interactive on its own (a real control, role, or editable).
        var distinct = kind === "tag" || kind === "role" || kind === "editable";
        if (!parentCaptured || distinct) {
          var cx = r.left + r.width / 2 + ox;
          var cy = r.top + r.height / 2 + oy;
          var inVp = cx >= 0 && cx <= TW && cy >= 0 && cy <= TH;
          if (!viewportOnly || inVp) {
            var id = idc++;
            try { el.setAttribute("data-agent-id", String(id)); } catch (e) {}
            out.push({
              id: id,
              agentId: String(id),
              tag: el.tagName.toLowerCase(),
              role: (el.getAttribute && el.getAttribute("role")) || null,
              type: (el.getAttribute && el.getAttribute("type")) || null,
              name: nameOf(el),
              x: Math.round(cx),
              y: Math.round(cy),
              w: Math.round(r.width),
              h: Math.round(r.height),
              inViewport: inVp
            });
            capturedHere = true;
          }
        }
      }
      if (!capturedHere && el.hasAttribute && el.hasAttribute("data-agent-id")) {
        try { el.removeAttribute("data-agent-id"); } catch (e) {}
      }
      if (el.shadowRoot) {
        var sk = el.shadowRoot.childNodes;
        for (var i = 0; i < sk.length; i++) rec(sk[i], ox, oy, parentCaptured || capturedHere);
      }
      if (el.tagName === "IFRAME") {
        try {
          var idoc = el.contentDocument;
          if (idoc && idoc.documentElement) {
            var ir = el.getBoundingClientRect();
            rec(idoc.documentElement, ox + ir.left, oy + ir.top, false);
          }
        } catch (e) { /* cross-origin */ }
        return;
      }
    }
    var kids = node.childNodes;
    if (kids) for (var j = 0; j < kids.length; j++) rec(kids[j], ox, oy, parentCaptured || capturedHere);
  }
  rec(document.documentElement, 0, 0, false);
  return { count: out.length, url: location.href, title: document.title, elements: out };
}

// Deep resolver: find an element by selector across shadow DOM + same-origin
// iframes, scroll it into view, and return its absolute center coordinates.
function resolveClickFn(sel) {
  function pick(root) {
    var list = [];
    try { list = root.querySelectorAll ? root.querySelectorAll(sel) : []; } catch (e) { return null; }
    for (var i = 0; i < list.length; i++) {
      var r = list[i].getBoundingClientRect();
      if (r.width > 0 && r.height > 0) return list[i];
    }
    return list[0] || null;
  }
  function find(root, ox, oy) {
    var el = pick(root);
    if (el) {
      try { el.scrollIntoView({ block: "center", inline: "center" }); } catch (e) {}
      var r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2 + ox, y: r.top + r.height / 2 + oy };
    }
    var all = [];
    try { all = root.querySelectorAll ? root.querySelectorAll("*") : []; } catch (e) {}
    for (var i = 0; i < all.length; i++) {
      var n = all[i];
      if (n.shadowRoot) {
        var f = find(n.shadowRoot, ox, oy);
        if (f) return f;
      }
      if (n.tagName === "IFRAME") {
        try {
          var idoc = n.contentDocument;
          if (idoc) {
            var ir = n.getBoundingClientRect();
            var f2 = find(idoc, ox + ir.left, oy + ir.top);
            if (f2) return f2;
          }
        } catch (e) {}
      }
    }
    return null;
  }
  return find(document, 0, 0);
}

async function handle(action, p) {
  switch (action) {
    case "ping":
      return { pong: true };

    case "list_tabs": {
      const tabs = await chrome.tabs.query({});
      return tabs.map(tabInfo);
    }

    case "get_active_tab": {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      return tabInfo(tab);
    }

    case "create_tab": {
      const tab = await chrome.tabs.create({ url: p.url, active: p.active !== false });
      return tabInfo(tab);
    }

    case "close_tab": {
      await chrome.tabs.remove(p.tabId);
      return { closed: true };
    }

    case "activate_tab": {
      const tab = await chrome.tabs.update(p.tabId, { active: true });
      if (tab && tab.windowId != null) {
        await chrome.windows.update(tab.windowId, { focused: true });
      }
      return tabInfo(tab);
    }

    case "navigate": {
      const tabId = p.tabId != null ? p.tabId : await activeTabId();
      const tab = await chrome.tabs.update(tabId, { url: p.url });
      return tabInfo(tab);
    }

    case "reload": {
      const tabId = p.tabId != null ? p.tabId : await activeTabId();
      await chrome.tabs.reload(tabId);
      return { reloaded: true };
    }

    case "go_back": {
      const tabId = p.tabId != null ? p.tabId : await activeTabId();
      await chrome.tabs.goBack(tabId);
      return { ok: true };
    }

    case "go_forward": {
      const tabId = p.tabId != null ? p.tabId : await activeTabId();
      await chrome.tabs.goForward(tabId);
      return { ok: true };
    }

    case "get_content": {
      const tabId = p.tabId != null ? p.tabId : await activeTabId();
      const [inj] = await chrome.scripting.executeScript({
        target: { tabId },
        func: (opts) => {
          const data = { title: document.title, url: location.href };
          if (opts.html) data.html = document.documentElement.outerHTML;
          const text = document.body ? document.body.innerText : "";
          data.text = opts.maxLength ? text.slice(0, opts.maxLength) : text;
          return data;
        },
        args: [{ html: !!p.html, maxLength: p.maxLength || 0 }]
      });
      return inj.result;
    }

    case "get_links": {
      return await runInPage(p, () =>
        Array.from(document.querySelectorAll("a[href]"))
          .slice(0, 500)
          .map((a) => ({ text: a.innerText.trim().slice(0, 120), href: a.href }))
      );
    }

    case "screenshot": {
      if (p.tabId != null) {
        await chrome.tabs.update(p.tabId, { active: true });
      }
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
      return { dataUrl };
    }

    // Trusted click. Accepts absolute {x,y}, a CSS {selector} (resolved deep
    // across shadow DOM + same-origin iframes), or an {agentId} from snapshot.
    case "click": {
      const tabId = p.tabId != null ? p.tabId : await activeTabId();
      let x = p.x;
      let y = p.y;
      if (x == null || y == null) {
        const agentId = p.agentId != null ? p.agentId : p.id;
        const sel = p.selector || (agentId != null ? '[data-agent-id="' + agentId + '"]' : null);
        if (!sel) throw new Error("click requires x/y, selector, or agentId");
        const [inj] = await chrome.scripting.executeScript({
          target: { tabId },
          func: resolveClickFn,
          args: [sel]
        });
        if (!inj || !inj.result) return { clicked: false, reason: "not found" };
        x = inj.result.x;
        y = inj.result.y;
      }
      await clickAt(tabId, x, y, p.clickCount || 1);
      return { clicked: true, x: Math.round(x), y: Math.round(y) };
    }

    // Framework-aware value setter: uses the native value setter + React's
    // internal _valueTracker so onChange fires in React/Vue/Angular inputs.
    case "type": {
      const tabId = p.tabId != null ? p.tabId : await activeTabId();
      const target = targetFromParams(p);
      if (!target) throw new Error("type requires selector, agentId, or id");
      if (typeof p.text !== "string") throw new Error("type requires text");
      await targetOperation(tabId, target, "type", p.text);
      return { typed: true };
    }

    // Indexed snapshot of interactive elements (shadow DOM + same-origin
    // iframes) with absolute coordinates. Tags each with data-agent-id.
    case "snapshot": {
      const tabId = p.tabId != null ? p.tabId : await activeTabId();
      const [inj] = await chrome.scripting.executeScript({
        target: { tabId },
        func: agentSnapshotFn,
        args: [{ max: p.max || 200, viewportOnly: !!p.viewportOnly }]
      });
      return inj.result;
    }

    // Poll until a selector exists, visible page text appears, or a JS
    // expression is truthy (or timeout).
    case "wait_for": {
      const tabId = p.tabId != null ? p.tabId : await activeTabId();
      const timeout = p.timeoutMs || 10000;
      const start = Date.now();
      while (Date.now() - start < timeout) {
        let ok = false;
        if (p.jsCondition) {
          try { ok = !!(await evalInPage(tabId, "(" + p.jsCondition + ")")); } catch (e) { ok = false; }
        } else if (p.selector) {
          try {
            const [inj] = await chrome.scripting.executeScript({
              target: { tabId },
              func: (s) => !!document.querySelector(s),
              args: [p.selector]
            });
            ok = !!(inj && inj.result);
          } catch (e) { ok = false; }
        } else if (typeof p.text === "string") {
          try {
            const [inj] = await chrome.scripting.executeScript({
              target: { tabId },
              func: (text) => (document.body ? document.body.innerText.includes(text) : false),
              args: [p.text]
            });
            ok = !!(inj && inj.result);
          } catch (e) { ok = false; }
        } else {
          ok = true;
        }
        if (ok) return { ready: true, waitedMs: Date.now() - start };
        const remaining = timeout - (Date.now() - start);
        if (remaining > 0) await new Promise((r) => setTimeout(r, Math.min(250, remaining)));
      }
      return { ready: false, timedOut: true, waitedMs: Date.now() - start };
    }

    case "scroll": {
      return await runInPage(
        p,
        (x, y) => {
          window.scrollTo(x, y);
          return { x: window.scrollX, y: window.scrollY };
        },
        [p.x || 0, p.y || 0]
      );
    }

    case "eval": {
      const tabId = p.tabId != null ? p.tabId : await activeTabId();
      const code = typeof p.code === "string" ? p.code : p.script;
      if (typeof code !== "string") throw new Error("eval requires code or script");
      return await evalInPage(tabId, code);
    }

    // Trusted text insertion at the focused editable (works on hardened editors).
    case "insert_text": {
      const tabId = p.tabId != null ? p.tabId : await activeTabId();
      const target = targetFromParams(p) || targetFromFocus(p.focus);
      if (target) await focusInPage(tabId, target);
      await dbgAttach(tabId);
      try {
        await dbgSend(tabId, "Input.insertText", { text: p.text || "" });
      } finally {
        await dbgDetach(tabId);
      }
      return { inserted: true, len: (p.text || "").length };
    }

    // Trusted key press(es): Enter, Backspace, Tab, arrows, or any char.
    // Optional modifiers bitmask (Alt=1, Ctrl=2, Meta=4, Shift=8) and count.
    case "press": {
      const tabId = p.tabId != null ? p.tabId : await activeTabId();
      const target = targetFromParams(p) || targetFromFocus(p.focus);
      if (target) await focusInPage(tabId, target);
      const key = normalizeKeyInput(p.key, p.modifiers);
      await pressKey(tabId, key.key, key.modifiers, p.count || 1);
      return { pressed: key.key, modifiers: key.modifiers, count: p.count || 1 };
    }

    // Universal clear: focus the field, select all its content, trusted-delete it.
    case "clear": {
      const tabId = p.tabId != null ? p.tabId : await activeTabId();
      const target = targetFromParams(p) || targetFromFocus(p.focus) || { active: true };
      await targetOperation(tabId, target, "select", "");
      await pressKey(tabId, "Backspace", 0, 1);
      return { cleared: true };
    }

    case "version":
      return {
        v: 12,
        userScripts: !!chrome.userScripts,
        onUserScriptMessage: !!chrome.runtime.onUserScriptMessage,
        debugger: !!chrome.debugger,
        actions: ["snapshot", "click", "type", "insert_text", "press", "clear", "wait_for", "eval"]
      };

    case "reload_self": {
      setTimeout(() => chrome.runtime.reload(), 250);
      return { reloading: true };
    }

    default:
      throw new Error("Unknown action: " + action);
  }
}

// ---------------------------------------------------------------------------
// Lifecycle + messaging
// ---------------------------------------------------------------------------

function ensureAlarm() {
  chrome.alarms.create("keepalive", { periodInMinutes: 0.5 });
}

// An alarm wakes the worker if Chrome ever reclaims it despite active WebSocket
// traffic, allowing the connection to be restored.
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "keepalive") {
    connect().catch(() => {
      connected = false;
      setBadge(false);
      scheduleReconnect();
    });
  }
});

chrome.runtime.onInstalled.addListener(() => {
  ensureAlarm();
  connect();
});

chrome.runtime.onStartup.addListener(() => {
  ensureAlarm();
  connect();
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return false;
  if (msg.type === "getStatus") {
    getConfig().then((cfg) => sendResponse({ connected, cfg }));
    return true;
  }
  if (msg.type === "saveConfig") {
    chrome.storage.local.set(msg.cfg).then(async () => {
      if (socket) {
        try { socket.close(); } catch (e) { /* noop */ }
        socket = null;
      }
      await connect(msg.cfg);
      sendResponse({ ok: true });
    });
    return true;
  }
  if (msg.type === "reconnect") {
    getConfig().then(async (cfg) => {
      if (socket) {
        try { socket.close(); } catch (e) { /* noop */ }
        socket = null;
      }
      await connect(cfg);
      sendResponse({ ok: true });
    });
    return true;
  }
  return false;
});

// Establish the WebSocket on every service-worker load.
ensureAlarm();
connect().catch(() => {
  connected = false;
  setBadge(false);
  scheduleReconnect();
});
