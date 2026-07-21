"use strict";

const assert = require("assert");
const { spawn } = require("child_process");
const http = require("http");

const token = "test-token-that-is-long-enough-for-security-checks";

function startBridgeStub() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.headers["x-bridge-token"] !== token) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }

      if (req.method === "GET" && req.url === "/status") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ extensionConnected: true }));
        return;
      }

      let body = "";
      req.on("data", (chunk) => body += chunk);
      req.on("end", () => {
        const command = JSON.parse(body);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          ok: true,
          result: { action: command.action, params: command.params }
        }));
      });
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function createMcpClient(port) {
  const child = spawn(process.execPath, ["index.js"], {
    cwd: __dirname + "/..",
    env: {
      ...process.env,
      BRIDGE_HOST: "127.0.0.1",
      BRIDGE_PORT: String(port),
      BRIDGE_TOKEN: token
    },
    stdio: ["pipe", "pipe", "pipe"]
  });
  child.stdin.setDefaultEncoding("utf8");

  const pending = new Map();
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop();
    for (const line of lines) {
      if (!line) continue;
      const message = JSON.parse(line);
      const resolve = pending.get(message.id);
      if (resolve) {
        pending.delete(message.id);
        resolve(message);
      }
    }
  });

  return {
    request(id, method, params) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${method}`)), 3_000);
        pending.set(id, (message) => {
          clearTimeout(timer);
          resolve(message);
        });
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      });
    },
    close() {
      child.kill();
    }
  };
}

async function main() {
  const bridge = await startBridgeStub();
  const port = bridge.address().port;
  const client = createMcpClient(port);

  try {
    const initialized = await client.request(1, "initialize", { protocolVersion: "2025-03-26" });
    assert.strictEqual(initialized.result.protocolVersion, "2025-03-26");
    assert.strictEqual(initialized.result.serverInfo.name, "browser-agent-bridge");

    const listed = await client.request(2, "tools/list", {});
    assert.deepStrictEqual(listed.result.tools.map((tool) => tool.name), [
      "browser_status",
      "browser_command"
    ]);

    const status = await client.request(3, "tools/call", {
      name: "browser_status",
      arguments: {}
    });
    assert.deepStrictEqual(JSON.parse(status.result.content[0].text), { extensionConnected: true });

    const command = await client.request(4, "tools/call", {
      name: "browser_command",
      arguments: { action: "snapshot", params: { viewportOnly: true } }
    });
    assert.deepStrictEqual(JSON.parse(command.result.content[0].text), {
      action: "snapshot",
      params: { viewportOnly: true }
    });

    const rejected = await client.request(5, "tools/call", {
      name: "browser_command",
      arguments: { action: "not-supported" }
    });
    assert.strictEqual(rejected.result.isError, true);
    assert.match(rejected.result.content[0].text, /Unsupported action/);

    process.stdout.write("mcp server tests passed\n");
  } finally {
    client.close();
    await new Promise((resolve) => bridge.close(resolve));
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
