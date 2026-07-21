const $ = (id) => document.getElementById(id);

function render(connected, cfg) {
  $("dot").className = "dot" + (connected ? " on" : "");
  $("statusText").textContent = connected ? "Connected to bridge" : "Not connected";
  $("host").value = cfg.host;
  $("port").value = cfg.port;
  $("token").value = cfg.token;
}

function setError(message) {
  $("error").textContent = message;
}

function refresh() {
  chrome.runtime.sendMessage({ type: "getStatus" }, (resp) => {
    if (resp) render(resp.connected, resp.cfg);
  });
}

$("save").addEventListener("click", () => {
  const cfg = {
    host: $("host").value.trim() || "127.0.0.1",
    port: parseInt($("port").value, 10) || 8765,
    token: $("token").value
  };
  if (cfg.token.length < 32) {
    setError("Use a random token with at least 32 characters.");
    return;
  }
  setError("");
  chrome.runtime.sendMessage({ type: "saveConfig", cfg }, () => setTimeout(refresh, 400));
});

$("reconnect").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "reconnect" }, () => setTimeout(refresh, 400));
});

refresh();
setInterval(refresh, 1500);
