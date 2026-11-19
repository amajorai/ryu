// Path A document scaffolding for `thirdPartyPluginSrcdoc` (`third-party-plugin.ts`):
// the `<head>` with the default CSP, the bootstrap prelude (theme, locale, the
// `call`/`callStream` RPC helpers and `onPortMessage`), and the activation tail that
// accepts the host port by nonce, then decodes and evaluates the plugin bundle.
// The builder interleaves these with `makePlugin` and `installWindowRyu`; see that
// file's header for the security model.

import { companionLocaleScript } from "./companion-locale.ts";
import {
	COMPANION_THEME_STATE_SCRIPT,
	HOSTED_EXTERNAL_LINKS_SCRIPT,
	indentGeneratedScript,
	RPC_ARGS_SCRIPT,
} from "./companion-script-fragments.ts";
import { COMPANION_THEME_ALIASES } from "./companion-theme-style.ts";
import { dialogEscapeScript } from "./dialog-escape-script.ts";
import { HORIZONTAL_WHEEL_SCROLL_SCRIPT } from "./horizontal-wheel-scroll-script.ts";
import { COMPANION_PRIVACY_STATE_SCRIPT } from "./notification-privacy.ts";
import { handshakeAnnounceScript } from "./rpc.ts";
import { companionRpcResultSettleScript } from "./rpc-error-decode-script.ts";
import { livenessResponderScript } from "./sandbox-liveness-gate.ts";

/** Script-safe JSON literals (already escaped by the caller) baked into the prelude. */
export interface PluginBootstrapLiterals {
	codeLiteral: string;
	mountContextLiteral: string;
	nonceLiteral: string;
	pluginIdLiteral: string;
	themeTokensLiteral: string;
}

/** The document start through the plugin root `<div>`.
 *
 *  @param htmlAttributes  Sanitized `lang`/`dir` attributes for `<html>`.
 *  @param defaultCspMeta  The default CSP `<meta>`, or "" when the user opted out.
 *  @param themeHead       First-paint theme `<style>` blocks, or "". */
export function pluginDocumentHead(
	htmlAttributes: string,
	defaultCspMeta: string,
	themeHead: string
): string {
	return `<!doctype html>
<html ${htmlAttributes}>
<head>
<meta charset="utf-8" />
<!-- A null-origin sandbox isolates the DOM but does NOT block network. When the
     default CSP setting is on, this per-document policy denies network
     (connect-src 'none') and remote code (default-src 'none' + inline-only
     script-src), so a benign-looking bundle cannot fetch/beacon out capability
     results or eval() a remote payload at runtime. Only the trusted inline
     bootstrap + inline styles + data: images run. If the user turns the setting
     off for a custom app, its UI can make direct network requests; privileged host
     APIs remain grant-gated and continue through Core.
     In the default policy, script-src includes 'unsafe-eval' because the bootstrap
     executes the plugin bundle via new Function (CSP gates that under 'unsafe-eval',
     NOT 'unsafe-inline'); connect-src 'none' still blocks fetching a remote payload
     to eval. If the user opts out of the default policy, direct requests are allowed. -->
${defaultCspMeta}
<style>
  :root { color-scheme: light dark; }
  html, body { margin: 0; height: 100%; }
  body {
    padding: 0;
    font: 13px/1.5 system-ui, sans-serif;
    color: #e7e7e7; background: #18181b;
  }
  #ryu-plugin-error {
    display: none; margin: 16px;
    padding: 10px 12px; border: 1px solid #7f1d1d; border-radius: 6px;
    background: #27272a; color: #f87171; font-size: 12px; white-space: pre-wrap;
  }
</style>
${themeHead}
</head>
<body>
  <div id="ryu-plugin-error"></div>
  <div id="ryu-plugin-root"></div>`;
}

/** The trusted bootstrap from `<script>` through `onPortMessage`. */
export function pluginBridgePrelude(
	literals: PluginBootstrapLiterals,
	closeOnEscape: boolean
): string {
	const {
		codeLiteral,
		mountContextLiteral,
		nonceLiteral,
		pluginIdLiteral,
		themeTokensLiteral,
	} = literals;
	const themeAliases = JSON.stringify(COMPANION_THEME_ALIASES);
	return `<script>
  (function () {
    var NONCE = ${nonceLiteral};
    var UI_CODE_B64 = ${codeLiteral};
    var PLUGIN_ID = ${pluginIdLiteral};
    var MOUNT_CONTEXT = ${mountContextLiteral};
    var INITIAL_THEME_TOKENS = ${themeTokensLiteral};
    var THEME_ALIASES = ${themeAliases};
    var port = null;
    var nextId = 1;
    var pending = {};
    var errEl = document.getElementById("ryu-plugin-error");

${indentGeneratedScript(COMPANION_THEME_STATE_SCRIPT, "    ")}
${indentGeneratedScript(COMPANION_PRIVACY_STATE_SCRIPT, "    ")}

    function applyThemeTokens(tokens) {
      if (!tokens || typeof tokens !== "object") return;
      var root = document.documentElement;
      Object.keys(tokens).forEach(function (name) {
        var value = tokens[name];
        if (/^--[a-z0-9-]+$/.test(name) && typeof value === "string" && value.length > 0 && !/[{}<>;]/.test(value)) {
          root.style.setProperty(name, value);
        }
      });
      Object.keys(THEME_ALIASES).forEach(function (alias) {
        var source = THEME_ALIASES[alias];
        var value = tokens[source];
        if (typeof value === "string" && value.length > 0 && !/[{}<>;]/.test(value)) {
          root.style.setProperty(alias, value);
        }
      });
      applyThemeState(tokens);
    }

    applyThemeTokens(INITIAL_THEME_TOKENS);
    window.addEventListener("message", function (ev) {
      var msg = ev.data;
      if (ev.source !== window.parent || !msg || msg.kind !== "ryu-plugin-theme" || msg.nonce !== NONCE) return;
      applyThemeTokens(msg.tokens);
    });

${HORIZONTAL_WHEEL_SCROLL_SCRIPT}
${dialogEscapeScript(closeOnEscape)}
${indentGeneratedScript(companionLocaleScript(), "    ")}

    function fail(text) {
      if (errEl) {
        errEl.textContent = String(text);
        errEl.style.display = "block";
      }
    }

${indentGeneratedScript(RPC_ARGS_SCRIPT, "    ")}

    // RPC over the transferred MessageChannel port. Resolves/rejects by id.
    function call(method, args) {
      return new Promise(function (resolve, reject) {
        if (!port) { reject(new Error("bridge not ready")); return; }
        var id = nextId++;
        pending[id] = { resolve: resolve, reject: reject };
        port.postMessage({ kind: "ryu-plugin-rpc", id: id, method: method, args: rpcArgs(args || []) });
      });
    }

${indentGeneratedScript(HOSTED_EXTERNAL_LINKS_SCRIPT, "    ")}

    // Streaming RPC: the host pushes many "ryu-plugin-rpc-chunk" frames (delivered
    // to onChunk) then one terminal result. Returns { promise, cancel } — cancel
    // sends an "agent.cancel" carrying the stream's id so the host aborts it.
    function callStream(method, args, onChunk) {
      var id = nextId++;
      var resolve, reject;
      var promise = new Promise(function (res, rej) { resolve = res; reject = rej; });
      pending[id] = { resolve: resolve, reject: reject, onChunk: onChunk };
      if (port) port.postMessage({ kind: "ryu-plugin-rpc", id: id, method: method, args: rpcArgs(args || []) });
      else reject(new Error("bridge not ready"));
      function cancel() {
        if (!port) return;
        port.postMessage({ kind: "ryu-plugin-rpc", id: nextId++, method: "agent.cancel", args: [id] });
      }
      return { promise: promise, cancel: cancel };
    }

    function onPortMessage(ev) {
      var msg = ev.data;
      if (!msg) return;
      ${livenessResponderScript()}
      if (msg.kind === "ryu-widget-set-globals" && msg.globals && msg.globals.openedFile) {
        window.dispatchEvent(new CustomEvent("ryu:file-changed", { detail: msg.globals.openedFile }));
        return;
      }
      if (msg.kind === "ryu-plugin-rpc-chunk") {
        var pc = pending[msg.id];
        if (pc && typeof pc.onChunk === "function") pc.onChunk(msg.delta);
        return;
      }
      if (msg.kind !== "ryu-plugin-rpc-result") return;
      var p = pending[msg.id];
      if (!p) return;
      delete pending[msg.id];
      // Reject on ANY error (string legacy OR structured { code, message }).
${companionRpcResultSettleScript()}
    }`;
}

/** Port acceptance, bundle evaluation, the ready announce, and the document end. */
export function pluginActivationScript(): string {
	return `    var connectedContext = null;

    // The host posts the channel port after verifying our handshake. Accept ONLY
    // a message carrying our nonce and a port.
    window.addEventListener("message", function (ev) {
      var msg = ev.data;
      if (!msg || msg.kind !== "ryu-plugin-host-port" || msg.nonce !== NONCE) return;
      var p = ev.ports && ev.ports[0];
      if (!p || port) return;
      port = p;
      port.onmessage = onPortMessage;

      // Install window.ryu BEFORE the bundle runs so an app's top-level code (and the
      // SDK bridge adoption) sees a live host bridge.
      installWindowRyu();
      followHostLocale();

      // Decode + evaluate the plugin bundle once the bridge is live. The plugin's
      // id is baked into this trusted bootstrap (not secret); the host re-validates
      // every route claim against the same id, so scoping is enforced host-side.
      var pluginId = PLUGIN_ID;
      try {
        var source = atobUtf8(UI_CODE_B64);
        var moduleExports = {};
        // Evaluate the bundle with activate/deactivate collectable via the
        // module object. The SDK packs an ESM-less IIFE that assigns to
        // globalThis.__ryuPlugin, OR a body that defines a top-level activate().
        var factory = new Function("exports", "module", "context", source + "\\n;return (typeof activate === 'function') ? { activate: activate, deactivate: (typeof deactivate === 'function' ? deactivate : undefined) } : (module.exports || exports);");
        var mod = factory(moduleExports, { exports: moduleExports }, null);
        var resolved = (mod && typeof mod.activate === "function")
          ? mod
          : (globalThis.__ryuPlugin || null);
        if (!resolved || typeof resolved.activate !== "function") {
          fail("plugin bundle does not export activate(context)");
          return;
        }
        connectedContext = makePlugin(pluginId);
        Promise.resolve(resolved.activate(connectedContext)).catch(function (e) {
          fail("activate() threw: " + (e && e.message ? e.message : e));
        });
      } catch (e) {
        fail("failed to run plugin bundle: " + (e && e.message ? e.message : e));
      }
    });

    // Minimal base64 → UTF-8 decode (atob yields Latin-1; re-decode as UTF-8 so
    // non-ASCII plugin source survives).
    function atobUtf8(b64) {
      var bin = atob(b64);
      var bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new TextDecoder("utf-8").decode(bytes);
    }

    // Announce readiness (host verifies event.source + this nonce), and keep
    // announcing until the port lands — see handshakeAnnounceScript for why a
    // single announce is a silently unrecoverable failure on this path.
${handshakeAnnounceScript()}
  })();
</script>
</body>
</html>`;
}
