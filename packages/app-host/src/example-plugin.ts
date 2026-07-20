// A tiny built-in EXAMPLE plugin used to prove the extension-host loop end to end
// (#446): it renders in a sandboxed null-origin iframe, performs the postMessage
// handshake, then calls the capability-gated `core.listAgents` over the bridge and
// renders the result. It is shipped as an inline `srcdoc` HTML string (NOT a real
// asset URL) so the frame is guaranteed null-origin and inherits no app origin,
// dev-server, or Tauri asset-protocol context.
//
// The host interpolates a per-mount NONCE (a `crypto.randomUUID()`, host-generated,
// never user input) into the markup. The iframe echoes that nonce in its "ready"
// handshake so the host can verify the message is from the frame it created
// (alongside the `event.source === iframe.contentWindow` identity check). After the
// handshake the host transfers a MessageChannel port into the frame and all RPC
// runs over that point-to-point port.

/** Build the example plugin's sandboxed document, with the host nonce baked in.
 *  `nonce` MUST be host-generated (e.g. crypto.randomUUID()), never plugin- or
 *  user-controlled. It is JSON-encoded into a string literal in the script. */
import { HOST_API_VERSION } from "./rpc.ts";

export function examplePluginSrcdoc(nonce: string): string {
	const nonceLiteral = JSON.stringify(nonce);
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<style>
  :root { color-scheme: light dark; }
  body {
    margin: 0; padding: 16px;
    font: 13px/1.5 system-ui, sans-serif;
    color: #e7e7e7; background: #18181b;
  }
  h1 { font-size: 14px; margin: 0 0 4px; }
  p.sub { margin: 0 0 12px; color: #a1a1aa; font-size: 12px; }
  ul { list-style: none; margin: 0; padding: 0; }
  li {
    padding: 6px 10px; margin-bottom: 4px;
    border: 1px solid #3f3f46; border-radius: 6px;
    background: #27272a;
  }
  .status { margin-top: 12px; font-size: 12px; color: #a1a1aa; }
  .err { color: #f87171; }
  button {
    font: inherit; padding: 6px 12px; margin-bottom: 12px;
    border: 1px solid #3f3f46; border-radius: 6px;
    background: #27272a; color: #e7e7e7; cursor: pointer;
  }
  button:hover { background: #3f3f46; }
</style>
</head>
<body>
  <h1>Example plugin</h1>
  <p class="sub">Runs in a sandboxed null-origin iframe. Calls Core only over the host RPC bridge.</p>
  <button id="load" type="button">List agents (core.listAgents)</button>
  <ul id="agents"></ul>
  <div class="status" id="status">Waiting for host bridge…</div>
<script>
  (function () {
    var NONCE = ${nonceLiteral};
    var port = null;
    var nextId = 1;
    var pending = {};
    var statusEl = document.getElementById("status");
    var listEl = document.getElementById("agents");
    var loadBtn = document.getElementById("load");

    function setStatus(text, isErr) {
      statusEl.textContent = text;
      statusEl.className = "status" + (isErr ? " err" : "");
    }

    // RPC over the transferred MessageChannel port. Resolves/rejects by id.
    function call(method, args) {
      return new Promise(function (resolve, reject) {
        if (!port) { reject(new Error("bridge not ready")); return; }
        var id = nextId++;
        pending[id] = { resolve: resolve, reject: reject };
        port.postMessage({ kind: "ryu-plugin-rpc", id: id, method: method, args: args || [] });
      });
    }

    function onPortMessage(ev) {
      var msg = ev.data;
      if (!msg || msg.kind !== "ryu-plugin-rpc-result") return;
      var p = pending[msg.id];
      if (!p) return;
      delete pending[msg.id];
      if (typeof msg.error === "string") p.reject(new Error(msg.error));
      else p.resolve(msg.result);
    }

    // The host posts the channel port to the parent window after verifying our
    // handshake. We accept ONLY a message carrying our nonce and a port.
    window.addEventListener("message", function (ev) {
      var msg = ev.data;
      if (!msg || msg.kind !== "ryu-plugin-host-port" || msg.nonce !== NONCE) return;
      port = ev.ports && ev.ports[0];
      if (!port) return;
      port.onmessage = onPortMessage;
      setStatus("Bridge connected.");
    });

    loadBtn.addEventListener("click", function () {
      setStatus("Loading agents…");
      listEl.innerHTML = "";
      call("core.listAgents", []).then(function (agents) {
        if (!Array.isArray(agents)) { setStatus("Unexpected response.", true); return; }
        for (var i = 0; i < agents.length; i++) {
          var li = document.createElement("li");
          li.textContent = (agents[i] && (agents[i].name || agents[i].id)) || "(unnamed)";
          listEl.appendChild(li);
        }
        setStatus("Loaded " + agents.length + " agent(s) over the gated bridge.");
      }).catch(function (e) {
        setStatus("Call rejected: " + (e && e.message ? e.message : String(e)), true);
      });
    });

    // Announce readiness to the host (it verifies event.source + this nonce).
    window.parent.postMessage({ kind: "ryu-plugin-ready", nonce: NONCE, hostApiVersion: ${JSON.stringify(HOST_API_VERSION)} }, "*");
  })();
</script>
</body>
</html>`;
}
