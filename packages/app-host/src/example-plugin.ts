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

import { HORIZONTAL_WHEEL_SCROLL_SCRIPT } from "./horizontal-wheel-scroll-script.ts";
import { handshakeAnnounceScript } from "./rpc.ts";
import {
	buildCompanionThemeLayoutCss,
	buildThemeTokenStyle,
	companionScriptLiteralSchema,
} from "./third-party-plugin.ts";

/** Build the example plugin's sandboxed document, with the host nonce baked in.
 *  `nonce` MUST be host-generated (e.g. crypto.randomUUID()), never plugin- or
 *  user-controlled. It is JSON-encoded into a string literal in the script. */

export function examplePluginSrcdoc(
	nonce: string,
	themeTokens?: Record<string, string>,
	/** True when the containing Ryu root already applies `--ryu-ui-scale`. */
	scaleInParent = false
): string {
	const scriptSafe = companionScriptLiteralSchema.parse;
	const nonceLiteral = scriptSafe(nonce);
	const themeTokensLiteral = scriptSafe(themeTokens);
	const themeStyle = buildThemeTokenStyle(themeTokens);
	const themeLayoutStyle = themeTokens
		? `<style>${buildCompanionThemeLayoutCss(scaleInParent)}</style>`
		: "";
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<style>
  :root {
    --background: #18181b;
    --foreground: #e7e7e7;
    --card: #27272a;
    --primary: #0099ff;
    --primary-foreground: #ffffff;
    --muted-foreground: #a1a1aa;
    --border: #3f3f46;
    --destructive: #f87171;
    --radius: 0.625rem;
    --ryu-ui-scale: 1;
    --ryu-page-bg-image: none;
    --ryu-page-bg-repeat: repeat;
    --ryu-page-bg-position: 0 0;
    --ryu-page-bg-size: auto;
    --ryu-page-bg-opacity: 1;
    --ryu-page-bg-blur: 0px;
    color-scheme: light dark;
  }
  body {
    margin: 0; padding: 16px;
    font: 13px/1.5 var(--font-sans, system-ui), sans-serif;
    color: var(--foreground); background: var(--background);
    zoom: var(--ryu-ui-scale, 1);
    position: relative; isolation: isolate;
  }
  body::before {
    position: fixed; inset: 0; z-index: -1; content: ""; pointer-events: none;
    background-color: var(--background);
    background-image: var(--ryu-page-bg-image, none);
    background-repeat: var(--ryu-page-bg-repeat, repeat);
    background-position: var(--ryu-page-bg-position, 0 0);
    background-size: var(--ryu-page-bg-size, auto);
    opacity: var(--ryu-page-bg-opacity, 1);
    filter: blur(var(--ryu-page-bg-blur, 0px));
  }
  html[data-ryu-page-bg-active="on"] body { background: transparent !important; }
  h1 { font-size: 14px; margin: 0 0 4px; }
  p.sub { margin: 0 0 12px; color: var(--muted-foreground); font-size: 12px; }
  ul { list-style: none; margin: 0; padding: 0; }
  li {
    padding: 6px 10px; margin-bottom: 4px;
    border: 1px solid var(--border); border-radius: var(--radius);
    background: var(--card);
  }
  .status { margin-top: 12px; font-size: 12px; color: var(--muted-foreground); }
  .err { color: var(--destructive); }
  button {
    font: inherit; padding: 6px 12px; margin-bottom: 12px;
    border: 1px solid var(--border); border-radius: var(--radius);
    background: var(--card); color: var(--foreground); cursor: pointer;
  }
  button:hover { background: var(--primary); color: var(--primary-foreground); }
</style>
${themeTokens ? `${themeStyle}\n${themeLayoutStyle}` : themeStyle}
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
    var INITIAL_THEME_TOKENS = ${themeTokensLiteral};
    var port = null;
    var nextId = 1;
    var pending = {};
    var statusEl = document.getElementById("status");
    var listEl = document.getElementById("agents");
    var loadBtn = document.getElementById("load");

    function applyThemeTokens(tokens) {
      if (!tokens || typeof tokens !== "object") return;
      var root = document.documentElement;
      Object.keys(tokens).forEach(function (name) {
        var value = tokens[name];
        if (/^--[a-z0-9-]+$/.test(name) && typeof value === "string" && value.length > 0 && !/[{}<>;]/.test(value)) {
          root.style.setProperty(name, value);
        }
      });
      var mode = tokens["--ryu-theme-mode"];
      if (mode === "dark" || mode === "light") {
        root.classList.toggle("dark", mode === "dark");
        root.classList.toggle("light", mode === "light");
        root.setAttribute("data-ryu-theme", mode);
      }
      var scheme = tokens["--ryu-color-scheme"];
      if (scheme === "dark" || scheme === "light") root.style.colorScheme = scheme;
      var state = function (token, attribute, activeValue) {
        var value = tokens[token];
        if (typeof value !== "string") return;
        if (value === activeValue) root.setAttribute(attribute, activeValue);
        else root.removeAttribute(attribute);
      };
      state("--ryu-pointer-cursor", "data-pointer-cursor", "true");
      state("--ryu-chrome-shadows", "data-chrome-shadows", "off");
      state("--ryu-inverted-backgrounds", "data-inverted-backgrounds", "on");
      state("--ryu-dialog-overlay-mode", "data-dialog-overlay-blur", "off");
      state("--ryu-popup-overlay-mode", "data-popup-overlay-blur", "on");
      state("--ryu-animations", "data-ryu-animations", "off");
      state("--ryu-page-bg-active", "data-ryu-page-bg-active", "on");
    }

    applyThemeTokens(INITIAL_THEME_TOKENS);
    window.addEventListener("message", function (ev) {
      var msg = ev.data;
      if (ev.source !== window.parent || !msg || msg.kind !== "ryu-plugin-theme" || msg.nonce !== NONCE) return;
      applyThemeTokens(msg.tokens);
    });

${HORIZONTAL_WHEEL_SCROLL_SCRIPT}

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

    // Announce readiness to the host (it verifies event.source + this nonce), and
    // keep announcing until the port lands — see handshakeAnnounceScript.
${handshakeAnnounceScript()}
  })();
</script>
</body>
</html>`;
}
