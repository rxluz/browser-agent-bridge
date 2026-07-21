// Simulates the Chrome extension: connects to the bridge over WebSocket and
// answers commands with fake data. Used only to test the server plumbing.
const { WebSocket } = require("ws");

const PORT = process.env.BRIDGE_PORT || 8765;
const TOKEN = process.env.BRIDGE_TOKEN;

if (!TOKEN) {
  console.error("BRIDGE_TOKEN is required");
  process.exit(1);
}
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/?token=${TOKEN}&role=extension`);

const fakeTabs = [
  { id: 1, url: "https://example.com", title: "Example", active: true, windowId: 10, index: 0, status: "complete" },
  { id: 2, url: "https://news.ycombinator.com", title: "HN", active: false, windowId: 10, index: 1, status: "complete" }
];

ws.on("open", () => console.log("mock extension connected"));
ws.on("message", (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.type === "ping") return ws.send(JSON.stringify({ type: "pong" }));
  let result;
  switch (msg.action) {
    case "ping": result = { pong: true }; break;
    case "list_tabs": result = fakeTabs; break;
    case "get_active_tab": result = fakeTabs[0]; break;
    case "create_tab": result = { id: 3, url: msg.params.url, title: "new", active: true, windowId: 10, index: 2, status: "loading" }; break;
    case "get_content": result = { title: "Example", url: "https://example.com", text: "This domain is for use in illustrative examples." }; break;
    default: return ws.send(JSON.stringify({ id: msg.id, ok: false, error: "unknown action " + msg.action }));
  }
  ws.send(JSON.stringify({ id: msg.id, ok: true, result }));
});
ws.on("error", (e) => console.error("mock error", e.message));
