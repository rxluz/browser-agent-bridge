// Browser Agent Bridge server.
// Exposes an HTTP API for an agent (curl / cli.js) and relays commands to the
// Chrome extension over WebSocket. Bind to localhost only.

const http = require("http");
const { randomUUID } = require("crypto");
const { WebSocketServer } = require("ws");

const HOST = process.env.BRIDGE_HOST || "127.0.0.1";
const PORT = parseInt(process.env.BRIDGE_PORT || "8765", 10);
const TOKEN = process.env.BRIDGE_TOKEN;
const TIMEOUT = parseInt(process.env.BRIDGE_TIMEOUT || "30000", 10);
const EVAL_ENABLED = process.env.BRIDGE_ENABLE_EVAL === "1";

if (!["127.0.0.1", "::1", "localhost"].includes(HOST) && process.env.BRIDGE_ALLOW_NETWORK !== "1") {
  throw new Error("BRIDGE_HOST must be a loopback address unless BRIDGE_ALLOW_NETWORK=1 is set explicitly");
}

if (!TOKEN || TOKEN.length < 32) {
  throw new Error("BRIDGE_TOKEN must be set to a random token of at least 32 characters");
}

let extension = null; // active extension WebSocket
const pending = new Map(); // requestId -> { resolve, reject, timer }

function log(...args) {
  console.log("[bridge]", ...args);
}

function rejectPending(error) {
  for (const [id, request] of pending) {
    clearTimeout(request.timer);
    pending.delete(id);
    request.reject(error);
  }
}

function waitForExtension(ms) {
  if (extension && extension.readyState === 1) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const iv = setInterval(() => {
      if (extension && extension.readyState === 1) {
        clearInterval(iv);
        resolve();
      } else if (Date.now() - start > ms) {
        clearInterval(iv);
        reject(new Error("Extension not connected"));
      }
    }, 150);
  });
}

async function dispatch(action, params) {
  if (action === "eval" && !EVAL_ENABLED) {
    throw new Error("eval is disabled; restart with BRIDGE_ENABLE_EVAL=1 to enable arbitrary page JavaScript");
  }

  // Tolerate startup and brief Manifest V3 service-worker reconnects.
  await waitForExtension(25000);
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("Timeout waiting for extension response"));
    }, TIMEOUT);
    pending.set(id, { resolve, reject, timer });
    try {
      extension.send(JSON.stringify({ id, action, params }));
    } catch (e) {
      clearTimeout(timer);
      pending.delete(id);
      reject(e);
    }
  });
}

// ---------------------------------------------------------------------------
// HTTP API
// ---------------------------------------------------------------------------

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const token = req.headers["x-bridge-token"] || url.searchParams.get("token");

  const sendJson = (code, obj) => {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(obj));
  };

  if (token !== TOKEN) {
    return sendJson(401, { error: "unauthorized" });
  }

  if (req.method === "GET" && url.pathname === "/status") {
    return sendJson(200, {
      extensionConnected: !!(extension && extension.readyState === 1)
    });
  }

  if (req.method === "POST" && url.pathname === "/command") {
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > 5e6) req.destroy(); // basic guard
    });
    req.on("end", async () => {
      let cmd;
      try {
        cmd = JSON.parse(body || "{}");
      } catch (e) {
        return sendJson(400, { error: "invalid json body" });
      }
      if (!cmd.action) {
        return sendJson(400, { error: "missing 'action'" });
      }
      try {
        const resp = await dispatch(cmd.action, cmd.params || {});
        if (resp.ok) {
          sendJson(200, { ok: true, result: resp.result });
        } else {
          sendJson(200, { ok: false, error: resp.error });
        }
      } catch (e) {
        sendJson(502, { ok: false, error: String((e && e.message) || e) });
      }
    });
    return;
  }

  sendJson(404, { error: "not found" });
});

// ---------------------------------------------------------------------------
// WebSocket (extension side)
// ---------------------------------------------------------------------------

const wss = new WebSocketServer({ server, path: "/" });

wss.on("connection", (socket, req) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const token = url.searchParams.get("token");
  const role = url.searchParams.get("role");

  if (token !== TOKEN) {
    socket.close(1008, "bad token");
    return;
  }
  if (role !== "extension") {
    socket.close(1008, "unknown role");
    return;
  }

  if (extension && extension !== socket) {
    try { extension.close(1000, "replaced"); } catch (e) { /* noop */ }
  }
  extension = socket;
  log("extension connected");

  socket.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch (e) {
      return;
    }
    if (msg.type === "pong") return;
    if (!msg.id) return;
    const p = pending.get(msg.id);
    if (p) {
      clearTimeout(p.timer);
      pending.delete(msg.id);
      p.resolve(msg);
    }
  });

  socket.on("close", () => {
    if (extension === socket) {
      extension = null;
      rejectPending(new Error("Extension disconnected before responding"));
      log("extension disconnected");
    }
  });

  socket.on("error", () => {
    try { socket.close(); } catch (e) { /* noop */ }
  });
});

// Keep the extension's service worker awake with periodic pings.
setInterval(() => {
  if (extension && extension.readyState === 1) {
    extension.send(JSON.stringify({ type: "ping" }));
  }
}, 20000);

server.listen(PORT, HOST, () => {
  log(`listening on http://${HOST}:${PORT}`);
  log("token: ***set***");
  log(`page eval: ${EVAL_ENABLED ? "enabled" : "disabled"}`);
});
