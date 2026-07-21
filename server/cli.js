#!/usr/bin/env node
// Small CLI to send commands to the bridge server.
//
//   node cli.js <action> [json-params]
//
// Examples:
//   node cli.js status
//   node cli.js list_tabs
//   node cli.js create_tab '{"url":"https://example.com"}'
//   node cli.js get_content '{"maxLength":2000}'

const http = require("http");

const HOST = process.env.BRIDGE_HOST || "127.0.0.1";
const PORT = parseInt(process.env.BRIDGE_PORT || "8765", 10);
const TOKEN = process.env.BRIDGE_TOKEN;

const action = process.argv[2];
const rawParams = process.argv[3];

if (!action) {
  console.error("Usage: node cli.js <action> [json-params]");
  process.exit(1);
}

if (!TOKEN) {
  console.error("BRIDGE_TOKEN is required");
  process.exit(1);
}

function request(method, path, bodyObj) {
  return new Promise((resolve, reject) => {
    const body = bodyObj ? JSON.stringify(bodyObj) : null;
    const req = http.request(
      {
        host: HOST,
        port: PORT,
        path,
        method,
        headers: {
          "Content-Type": "application/json",
          "X-Bridge-Token": TOKEN
        }
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode, json: JSON.parse(data || "{}") });
          } catch (e) {
            resolve({ status: res.statusCode, json: data });
          }
        });
      }
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

(async () => {
  try {
    if (action === "status") {
      const { json } = await request("GET", "/status");
      console.log(JSON.stringify(json, null, 2));
      return;
    }
    let params = {};
    if (rawParams) {
      params = JSON.parse(rawParams);
    }
    const { json } = await request("POST", "/command", { action, params });
    console.log(JSON.stringify(json, null, 2));
  } catch (e) {
    console.error("Error:", e.message);
    process.exit(1);
  }
})();
