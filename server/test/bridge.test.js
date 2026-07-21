"use strict";

const assert = require("assert");
const { spawn } = require("child_process");
const http = require("http");
const { WebSocket } = require("ws");

const token = "test-token-that-is-long-enough-for-security-checks";
const port = 20_000 + Math.floor(Math.random() * 20_000);

function request(method, path, body, requestToken = token) {
  return new Promise((resolve, reject) => {
    const rawBody = body ? JSON.stringify(body) : undefined;
    const req = http.request({
      host: "127.0.0.1",
      port,
      path,
      method,
      headers: {
        "X-Bridge-Token": requestToken,
        ...(rawBody ? {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(rawBody)
        } : {})
      }
    }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => data += chunk);
      res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
    });
    req.on("error", reject);
    if (rawBody) req.write(rawBody);
    req.end();
  });
}

function waitForOutput(child, matcher) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${matcher}`)), 5_000);
    child.stdout.on("data", (chunk) => {
      if (matcher.test(String(chunk))) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code !== null) {
        clearTimeout(timer);
        reject(new Error(`Bridge exited unexpectedly with code ${code}`));
      }
    });
  });
}

function connectExtension(onCommand) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/?token=${token}&role=extension`);
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
    socket.on("message", (data) => {
      const message = JSON.parse(String(data));
      if (message.type === "ping") {
        socket.send(JSON.stringify({ type: "pong" }));
        return;
      }
      onCommand(socket, message);
    });
  });
}

async function main() {
  const bridge = spawn(process.execPath, ["bridge.js"], {
    cwd: __dirname + "/..",
    env: {
      ...process.env,
      BRIDGE_HOST: "127.0.0.1",
      BRIDGE_PORT: String(port),
      BRIDGE_TOKEN: token,
      BRIDGE_TIMEOUT: "1000"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  try {
    await waitForOutput(bridge, /listening/);

    const unauthorized = await request("GET", "/status", undefined, "wrong-token");
    assert.strictEqual(unauthorized.status, 401);
    assert.deepStrictEqual(unauthorized.body, { error: "unauthorized" });

    const statusBeforeConnect = await request("GET", "/status");
    assert.strictEqual(statusBeforeConnect.body.extensionConnected, false);

    const firstExtension = await connectExtension((socket, message) => {
      socket.send(JSON.stringify({ id: message.id, ok: true, result: { action: message.action } }));
    });

    const statusAfterConnect = await request("GET", "/status");
    assert.strictEqual(statusAfterConnect.body.extensionConnected, true);

    const command = await request("POST", "/command", { action: "ping", params: {} });
    assert.deepStrictEqual(command, {
      status: 200,
      body: { ok: true, result: { action: "ping" } }
    });

    firstExtension.close();
    const disconnectingExtension = await connectExtension((socket) => socket.close());
    const start = Date.now();
    const disconnected = await request("POST", "/command", { action: "ping", params: {} });
    assert.strictEqual(disconnected.status, 502);
    assert.match(disconnected.body.error, /Extension disconnected/);
    assert.ok(Date.now() - start < 500, "disconnect should reject without waiting for the command timeout");
    disconnectingExtension.close();

    process.stdout.write("bridge tests passed\n");
  } finally {
    bridge.kill();
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
