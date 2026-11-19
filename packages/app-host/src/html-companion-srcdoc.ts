// ── Path B: full-HTML companion (ui_format: "html") ─────────────────────────────
//
// A heavy app (React + Excalidraw + Mermaid, …) is impractical to ship as a single
// `new Function`-eval'd ESM module: the CSS is dropped, `process.env` is undefined,
// and fonts fight the CSP. Instead it is built to ONE self-contained HTML document
// via `vite-plugin-singlefile` (the same pipeline the inline widget apps use), and
// mounted DIRECTLY as the iframe `srcdoc` — no bundle eval. This builder wraps that
// app HTML by injecting, as the FIRST children of <head> (so both run before the
// app's own deferred module scripts):
//   1. A per-document default CSP that keeps the egress lock (`connect-src 'none'`) but
//      widens `font-src`/`img-src`/`worker-src` to `data:`/`blob:` so Excalidraw's
//      inlined fonts, blob-URL images, and workers load. With the default policy,
//      the frame cannot fetch/beacon/eval-remote; the host port remains available.
//      The user's opt-out omits this fallback only for custom apps without a
//      trusted declaration.
//   2. The SAME `window.ryu` bridge `installWindowRyu` provides (model/agent/storage/
//      spaces + mount context), but installed SYNCHRONOUSLY with an OUTBOX: the app's
//      module scripts run on parse, before the host transfers the port, so a
//      `spaces.getDoc` in the app's first effect must QUEUE and flush on connect
//      rather than reject with "bridge not ready" (the Path A eval avoids this by
//      only running the bundle after the port arrives; Path B cannot).
// The RPC envelope, method names, handshake nonce, and port protocol are byte-for-
// byte identical to Path A, so `ExtensionHost`'s host side is unchanged.

import type { z } from "zod";
import { buildHtmlCompanionCsp, type CompanionCsp } from "./companion-csp.ts";
import {
	type CompanionLocale,
	companionLocaleScript,
} from "./companion-locale.ts";
import {
	COMPANION_THEME_STATE_SCRIPT,
	type companionScriptLiteralSchema,
	HOSTED_EXTERNAL_LINKS_SCRIPT,
	indentGeneratedScript,
	RPC_ARGS_SCRIPT,
	scriptSafe,
} from "./companion-script-fragments.ts";
import {
	buildCompanionThemeLayoutCss,
	buildThemeTokenStyle,
	COMPANION_THEME_ALIASES,
} from "./companion-theme-style.ts";
import { dialogEscapeScript } from "./dialog-escape-script.ts";
import { HORIZONTAL_WHEEL_SCROLL_SCRIPT } from "./horizontal-wheel-scroll-script.ts";
import { htmlCompanionWindowRyuCoreScript } from "./html-companion-window-ryu.ts";
import { HTML_COMPANION_WINDOW_RYU_APPS_SCRIPT } from "./html-companion-window-ryu-apps.ts";
import { HTML_COMPANION_WINDOW_RYU_SHELL_SCRIPT } from "./html-companion-window-ryu-shell.ts";
import { COMPANION_PRIVACY_STATE_SCRIPT } from "./notification-privacy.ts";
import { handshakeAnnounceScript } from "./rpc.ts";
import { companionRpcResultSettleScript } from "./rpc-error-decode-script.ts";
import { livenessResponderScript } from "./sandbox-liveness-gate.ts";

/** Build the injected `<head>` fragment: the CSP meta + the synchronous, outbox-
 *  backed `window.ryu` bridge bootstrap. `*Literal` args are already script-safe
 *  JSON literals (escaped by the caller). */
function htmlCompanionHeadFragment(
	nonceLiteral: string,
	pluginIdLiteral: string,
	mountContextLiteral: string,
	cspString: string | null,
	initialThemeTokensLiteral: string,
	closeOnEscape: boolean,
	locale?: CompanionLocale
): string {
	const themeAliases = JSON.stringify(COMPANION_THEME_ALIASES);
	return `${cspString ? `<meta http-equiv="Content-Security-Policy" content="${cspString}" />` : ""}
<script>
  (function () {
    var NONCE = ${nonceLiteral};
    var PLUGIN_ID = ${pluginIdLiteral};
    var MOUNT_CONTEXT = ${mountContextLiteral};
    var INITIAL_THEME_TOKENS = ${initialThemeTokensLiteral};
    var THEME_ALIASES = ${themeAliases};
    var port = null;
    var nextId = 1;
    var pending = {};
    // Envelopes queued before the port arrived; flushed on connect. This is the
    // difference from Path A: the app runs before the port is transferred.
    var outbox = [];

${indentGeneratedScript(COMPANION_THEME_STATE_SCRIPT, "    ")}
${indentGeneratedScript(COMPANION_PRIVACY_STATE_SCRIPT, "    ")}

${indentGeneratedScript(RPC_ARGS_SCRIPT, "    ")}

    function call(method, args) {
      return new Promise(function (resolve, reject) {
        var id = nextId++;
        pending[id] = { resolve: resolve, reject: reject };
        var env = { kind: "ryu-plugin-rpc", id: id, method: method, args: rpcArgs(args || []) };
        if (port) port.postMessage(env); else outbox.push(env);
      });
    }

${indentGeneratedScript(HOSTED_EXTERNAL_LINKS_SCRIPT, "    ")}

    function callStream(method, args, onChunk) {
      var id = nextId++;
      var resolve, reject;
      var promise = new Promise(function (res, rej) { resolve = res; reject = rej; });
      pending[id] = { resolve: resolve, reject: reject, onChunk: onChunk };
      var env = { kind: "ryu-plugin-rpc", id: id, method: method, args: rpcArgs(args || []) };
      if (port) port.postMessage(env); else outbox.push(env);
      function cancel() {
        var c = { kind: "ryu-plugin-rpc", id: nextId++, method: "agent.cancel", args: [id] };
        if (port) port.postMessage(c); else outbox.push(c);
      }
      return { promise: promise, cancel: cancel };
    }

    // The host owns the active theme. Apply the canonical tokens plus the small
    // legacy alias set used by older self-contained companions so every app can
    // follow custom Ryu themes without importing the shell's CSS bundle.
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
${companionRpcResultSettleScript()}
    }

    // Install window.ryu SYNCHRONOUSLY so an app effect that calls spaces.getDoc
    // during first render queues into the outbox instead of throwing. Identical
    // surface to the Path A installWindowRyu().
    var ryu = {
${htmlCompanionWindowRyuCoreScript()}
${HTML_COMPANION_WINDOW_RYU_APPS_SCRIPT}
${HTML_COMPANION_WINDOW_RYU_SHELL_SCRIPT}
	ryu.tokenTable = ryu.realtime;
    try {
        window.ryu = ryu;
        ryu.updateModelContext = ryu.assistant.updateModelContext;
      if (!window.openai) window.openai = ryu;
      window.__ryuHostBridge = true;
    } catch (e) { /* frame globals writable in sandbox; ignore if not */ }

    // Theme updates are host-owned and do not require the companion to request
    // shell integration. The parent sends this message after the frame mounts,
    // while the srcdoc style below still provides the first-paint snapshot.
    window.addEventListener("message", function (ev) {
      var msg = ev.data;
      if (ev.source !== window.parent || !msg || msg.kind !== "ryu-plugin-theme" || msg.nonce !== NONCE) return;
      applyThemeTokens(msg.tokens);
    });

${HORIZONTAL_WHEEL_SCROLL_SCRIPT}
${dialogEscapeScript(closeOnEscape)}
${indentGeneratedScript(companionLocaleScript(locale), "    ")}
    followHostLocale();

    // Accept the port ONLY from the host message carrying our nonce, once.
    window.addEventListener("message", function (ev) {
      var msg = ev.data;
      if (!msg || msg.kind !== "ryu-plugin-host-port" || msg.nonce !== NONCE) return;
      var p = ev.ports && ev.ports[0];
      if (!p || port) return;
      port = p;
      port.onmessage = onPortMessage;
      // Flush anything the app queued before connect.
      for (var i = 0; i < outbox.length; i++) port.postMessage(outbox[i]);
      outbox = [];
    });

    // Announce readiness (host verifies event.source + this nonce, then transfers
    // the port). Posted during head parse and RE-posted until the port arrives: the
    // parent's listener is attached from a React passive effect, which the iframe's
    // load task can beat — see handshakeAnnounceScript.
${handshakeAnnounceScript()}
  })();
</script>`;
}

/**
 * Build a full-HTML companion's sandboxed document (Path B, `ui_format: "html"`).
 *
 * @param nonce       Host-generated per-mount nonce, echoed in the handshake.
 * @param appHtml     The app's self-contained HTML (a `vite-plugin-singlefile`
 *                    build). Mounted directly as `srcdoc`; NOT eval'd.
 * @param pluginId    The owning plugin id (baked into the bridge; not secret — the
 *                    host re-validates every claim against the same id).
 * @param mountContext Optional `{ spaceId, docId }` baked as `window.ryu.context`.
 * @param csp         Optional per-app CSP allowlist (only ever a TRUSTED manifest's).
 *                    Widens `connect-src` (fetch targets) + `img-src`/`media-src`
 *                    (remote assets) for the declared hosts.
 * @param scaleInParent Whether the containing Ryu root already applies the UI scale.
 * @param options Whether to inject the restricted default when no trusted CSP
 *                declaration is present.
 */
export function htmlCompanionSrcdoc(
	nonce: string,
	appHtml: string,
	pluginId: string,
	mountContext?: z.input<typeof companionScriptLiteralSchema>,
	csp?: CompanionCsp,
	themeTokens?: Record<string, string>,
	/** True when the containing Ryu root already applies `--ryu-ui-scale`. */
	scaleInParent = false,
	options?: {
		enforceDefaultCsp?: boolean;
		closeOnEscape?: boolean;
		/** The host UI language: seeds `<html lang dir>`, then follows changes. */
		locale?: CompanionLocale;
	}
): string {
	const enforceDefaultCsp = options?.enforceDefaultCsp ?? true;
	const fragment = htmlCompanionHeadFragment(
		scriptSafe(nonce),
		scriptSafe(pluginId),
		scriptSafe(mountContext),
		csp || enforceDefaultCsp ? buildHtmlCompanionCsp(csp) : null,
		scriptSafe(themeTokens),
		options?.closeOnEscape === true,
		options?.locale
	);
	// The theme-token bridge goes AFTER the bridge script but still inside <head>.
	// It uses an `html:root` selector (higher specificity than the companion's own
	// `:root{…}`), so its resolved host values win regardless of where the app's own
	// inlined <style> sits relative to it.
	const themeStyle = buildThemeTokenStyle(themeTokens);
	const themeLayoutStyle = themeTokens
		? `<style>${buildCompanionThemeLayoutCss(scaleInParent)}</style>`
		: "";
	const head = themeTokens
		? `${fragment}\n${themeStyle}\n${themeLayoutStyle}`
		: fragment;
	// A trusted prefix is stronger than searching for the app's <head>: malformed
	// or hostile HTML may contain an executable token before that tag. Starting the
	// parser with the CSP and bridge guarantees both exist before ANY app token.
	const withoutDoctype = appHtml.replace(/^\s*<!doctype[^>]*>/i, "");
	return `<!doctype html><meta charset="utf-8">${head}\n${withoutDoctype}`;
}
