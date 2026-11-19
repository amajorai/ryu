// Builds the sandboxed document for a Ryu App WIDGET (decisions doc D2/D3).
//
// A widget is delivered as ONE self-contained HTML document (the Vite single-file
// bundle: inline <style> + an inline `<script type="module">`). This module turns
// that document into the exact srcdoc the host mounts, WITHOUT the `new Function`/
// `eval` bootstrap the third-party plugin path uses:
//
//   D2 — one delivery model: the widget's own `<script type="module">` runs
//        natively. There is NO `unsafe-eval`. Before that module runs, a trusted
//        inline bootstrap (also nonce'd) installs `window.ryu`/`window.openai`
//        SYNCHRONOUSLY with the initial globals, because real Apps-SDK components
//        read `window.openai.toolOutput` at module top-level.
//   D3 — the CSP keeps the GOVERNED-EGRESS LOCK but matches ChatGPT's rendering:
//        `default-src 'none'; script-src 'nonce-<n>'; style-src 'unsafe-inline';
//        img-src data: <proxy>; font-src data: <proxy>; media-src data: <proxy>;
//        connect-src 'none'`. `connect-src 'none'` is NEVER widened — all
//        widget->host RPC (incl. `callTool`) goes over the transferred MessagePort,
//        so active egress stays fully governed. A widget's DECLARED remote
//        `resource_domains` assets are the only widening, and even those do not
//        open the frame to the raw host: their URLs are REWRITTEN to a single Core
//        proxy origin (`/api/widgets/asset`) that fetches server-side, so the
//        Gateway sees and allowlists every passive-asset egress (see
//        `apps/core/src/server/widgets.rs`). Deny-by-default + widen-by-declaration,
//        the ChatGPT Apps-SDK model, but with Ryu's governed egress intact.
//
// The security boundary is still the null-origin `sandbox="allow-scripts"` iframe
// (ExtensionHost) plus the host-side capability gate (rpc.ts); this file adds the
// content-level defenses (nonce-only scripts, no eval, pinned CSP, proxied egress).
//
// FILE LAYOUT: the CSP lives in `widget-csp.ts` and the governed asset rewrite in
// `widget-assets.ts`; both are re-exported here so `@ryu/app-host/widget-bootstrap`
// stays the one public import path.

import { buildCompanionThemeLayoutCss } from "./companion-theme-style.ts";
import { HOST_API_VERSION } from "./rpc.ts";
import { widgetRpcResultSettleScript } from "./rpc-error-decode-script.ts";
import { livenessResponderScript } from "./sandbox-liveness-gate.ts";
import {
	resourceDomainHost,
	rewriteWidgetAssets,
	type WidgetAssetProxy,
} from "./widget-assets.ts";
import { buildWidgetCsp, sanitizeProxyOrigin } from "./widget-csp.ts";

export type { WidgetAssetProxy } from "./widget-assets.ts";
export {
	buildWidgetCsp,
	sanitizeProxyOrigin,
	type WidgetCsp,
} from "./widget-csp.ts";

/** The initial globals baked into the widget document synchronously (spec §1.3).
 *  Present before the widget's module script runs so top-level reads of
 *  `window.openai.toolOutput` see real data. */
export interface WidgetInitialGlobals {
	displayMode: "inline" | "fullscreen" | "pip";
	/** The host's app-wide "Friendly names" preference — `true` when the shell is
	 *  showing plain language rather than technical terms. Baked in synchronously
	 *  alongside `theme` so a widget that renders its own labels at module top-level
	 *  gets the right vocabulary on FIRST paint; a later push would show the widget
	 *  saying "Graph" for a frame inside an app that says "Connected search".
	 *  Optional so an older host that omits it defaults to the host's own default
	 *  (`true`) rather than to `undefined`-as-false, which would silently turn the
	 *  preference off for every widget on that host. */
	friendly?: boolean;
	locale: string;
	maxHeight: number | null;
	modelContext?: import("./model-context.ts").ModelContextState | null;
	safeArea: { bottom: number; left: number; right: number; top: number };
	theme: "light" | "dark";
	/** The complete host appearance snapshot, including custom palette values. */
	themeTokens?: Record<string, string>;
	toolInput: unknown;
	toolOutput: unknown;
	toolResponseMetadata: unknown;
	userAgent?: unknown;
	/** Apps-SDK parity globals (optional; the bridge defaults them when absent). */
	view?: unknown;
	widgetState: unknown;
}

/** JSON literal safe to embed inside a `<script>` body: escapes `<` so a value
 *  containing `</script>` cannot break out of the tag (defense in depth; the
 *  null-origin sandbox is the real boundary). */
function scriptLiteral(value: string | WidgetInitialGlobals): string {
	return JSON.stringify(value ?? null).replace(/</g, "\\u003c");
}

/** Decode a base64 (btoa/Latin-1) payload back to a UTF-8 string, so a widget
 *  document with non-ASCII content survives the host round-trip. */
function decodeBase64Utf8(base64: string): string {
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i += 1) {
		bytes[i] = binary.charCodeAt(i);
	}
	return new TextDecoder("utf-8").decode(bytes);
}

/** The trusted inline bootstrap source (no `</script>` may appear in it). Installs
 *  `window.ryu`/`window.openai` synchronously, bridges the six methods over the
 *  MessagePort, applies host `ryu-widget-set-globals` pushes, and announces ready
 *  with the host nonce. */
function bridgeSource(
	nonce: string,
	serverId: string,
	initial: WidgetInitialGlobals
): string {
	return `(function(){
  var NONCE = ${scriptLiteral(nonce)};
  var SERVER_ID = ${scriptLiteral(serverId)};
  var G = ${scriptLiteral(initial)};
  var port = null, nextId = 1, pending = {};

  function applyThemeTokens(tokens){
    if(!tokens || typeof tokens !== "object") return;
    var root = document.documentElement;
    Object.keys(tokens).forEach(function(name){
      var value = tokens[name];
      if(/^--[a-z0-9-]+$/.test(name) && typeof value === "string" && value.length > 0 && !/[{}<>;]/.test(value)){
        root.style.setProperty(name, value);
      }
    });
    var mode = tokens["--ryu-theme-mode"];
    if(mode === "dark" || mode === "light"){
      root.classList.toggle("dark", mode === "dark");
      root.classList.toggle("light", mode === "light");
      root.setAttribute("data-ryu-theme", mode);
    }
    var scheme = tokens["--ryu-color-scheme"];
    if(scheme === "dark" || scheme === "light") root.style.colorScheme = scheme;
    function setStateAttribute(token, attribute, activeValue) {
      var state = tokens[token];
      if (typeof state !== "string") return;
      if (state === activeValue) root.setAttribute(attribute, activeValue);
      else root.removeAttribute(attribute);
    }
    setStateAttribute("--ryu-pointer-cursor", "data-pointer-cursor", "true");
    setStateAttribute("--ryu-chrome-shadows", "data-chrome-shadows", "off");
    setStateAttribute("--ryu-inverted-backgrounds", "data-inverted-backgrounds", "on");
    setStateAttribute("--ryu-dialog-overlay-mode", "data-dialog-overlay-blur", "off");
    setStateAttribute("--ryu-popup-overlay-mode", "data-popup-overlay-blur", "on");
    setStateAttribute("--ryu-animations", "data-ryu-animations", "off");
    setStateAttribute("--ryu-page-bg-active", "data-ryu-page-bg-active", "on");
  }

  applyThemeTokens(G.themeTokens);

  function call(method, args){
    return new Promise(function(resolve, reject){
      if(!port){ reject(new Error("bridge not ready")); return; }
      var id = nextId++;
      pending[id] = { resolve: resolve, reject: reject };
      port.postMessage({ kind: "ryu-plugin-rpc", id: id, method: method, args: args || [] });
    });
  }

  function callStream(method, args, onChunk){
    var id = nextId++;
    var resolve, reject;
    var promise = new Promise(function(res, rej){ resolve = res; reject = rej; });
    pending[id] = { resolve: resolve, reject: reject, onChunk: onChunk };
    if(port) port.postMessage({ kind: "ryu-plugin-rpc", id: id, method: method, args: args || [] });
    else reject(new Error("bridge not ready"));
    function cancel(){
      if(!port) return;
      port.postMessage({ kind: "ryu-plugin-rpc", id: nextId++, method: "agent.cancel", args: [id] });
    }
    return { promise: promise, cancel: cancel };
  }

  var api = {
    serverId: SERVER_ID,
    toolInput: G.toolInput, toolOutput: G.toolOutput,
    toolResponseMetadata: G.toolResponseMetadata, widgetState: G.widgetState,
    theme: G.theme, locale: G.locale, displayMode: G.displayMode,
    themeTokens: G.themeTokens,
    maxHeight: G.maxHeight, safeArea: G.safeArea,
    i18n: {
      get: function(){ return call("i18n.get", []); },
      translate: function(a){ return call("i18n.translate", [a || {}]); },
      subscribe: function(opts){
        opts = opts || {};
        var h = callStream("i18n.subscribe", [{}], function(d){
          try { if(opts.onChange) opts.onChange(JSON.parse(d)); } catch(e){}
        });
        h.promise.catch(function(){});
        return { dispose: h.cancel };
      }
    },
    // Absent means "host did not say", which is NOT the same as off — default to the
    // host's own default (on) so an older host does not silently disable it here.
    friendly: (G.friendly !== false),
    // window.openai parity globals (Apps-SDK). Present (never undefined) so a widget
    // that reads them at module top-level does not crash; host-pushable via setGlobals.
    view: (G.view != null ? G.view : { displayMode: G.displayMode, maxHeight: G.maxHeight }),
    userAgent: (G.userAgent != null ? G.userAgent : { app: "ryu", locale: G.locale }),
    modelContext: G.modelContext || null,
    updateModelContext: function(input){ return call("ui.updateModelContext", [input]); },
    setWidgetState: function(s){ api.widgetState = s; return call("widget.setState", [s]); },
    callTool: function(name, args){ return call("tool.call", [name, args]); },
    sendFollowUpMessage: function(a){ return call("ui.sendMessage", [a]); },
    requestDisplayMode: function(a){ return call("ui.requestDisplayMode", [a]); },
    // Its OWN method (not aliased to requestDisplayMode, which narrows to a bare
    // mode and would drop {template}). The host maps modal->fullscreen but the
    // requested template reaches the host service intact.
    requestModal: function(opts){ return call("ui.requestModal", [{ template: opts && opts.template }]); },
    requestClose: function(){ return call("ui.requestClose", []); },
    notifyIntrinsicHeight: function(px){ call("ui.notifyHeight", [px]).catch(function(){}); },
    openExternal: function(a){ return call("ui.openExternal", [a]); },
    // Host-rendered ephemeral notifications (grant ui:toast). Kept under ui
    // so widgets and full-page companions share one stable namespace.
    ui: {
      toast: {
        show: function(a){ return call("ui.toast.show", [a || {}]); },
        update: function(a){ return call("ui.toast.update", [a || {}]); },
        dismiss: function(a){ return call("ui.toast.dismiss", [a || {}]); }
      }
    },
    // File methods: governed stubs. They reach the bridge (a KNOWN method) and get a
    // clean "not supported in Ryu v1" rejection, never the unknown-method deny that
    // reads like a bug. Wire minimally later without a frame change.
    uploadFile: function(a){ return call("ui.uploadFile", [a]); },
    selectFiles: function(a){ return call("ui.selectFiles", [a]); },
    getFileDownloadUrl: function(a){ return call("ui.getFileDownloadUrl", [a]); },
    setOpenInAppUrl: function(a){ return call("ui.setOpenInAppUrl", [a]); },
    // Assistant bridge: tell the global Ask Ryu panel what this surface is showing
    // (publishContext), optionally lend it this surface's own instructions while
    // the page is open (registerSurface), and open it (open). Gated on the
    // assistant:context grant — ungranted calls reject like any other.
    assistant: {
      publishContext: function(items){ return call("assistant.publishContext", [{ items: items }]); },
      clearContext: function(){ return call("assistant.clearContext", []); },
      registerSurface: function(s){ return call("assistant.registerSurface", [s]); },
      clearSurface: function(){ return call("assistant.clearSurface", []); },
      open: function(a){ return call("assistant.open", [a || {}]); }
    }
  };
  window.ryu = api; window.openai = api;
  window.addEventListener("keydown", function(event){
    if(event.key === "Escape" && api.displayMode !== "inline") {
      event.preventDefault();
      api.requestDisplayMode({ mode: "inline" }).catch(function(){});
    }
  });
  // Detection contract (shared with installRyuBridge): mark THIS bootstrap as the
  // authoritative bridge so the frame-side installRyuBridge() adopts it as a no-op
  // instead of clobbering window.ryu with a port-less runtime.
  window.__ryuHostBridge = true;

  function applyGlobals(partial){
    if(!partial) return;
    applyThemeTokens(partial.themeTokens);
    for(var k in partial){
      if(Object.prototype.hasOwnProperty.call(partial, k)){ api[k] = partial[k]; }
    }
  }
  function setGlobals(partial){
    applyGlobals(partial);
    try {
      window.dispatchEvent(new CustomEvent("ryu:set_globals", { detail: { globals: partial } }));
      window.dispatchEvent(new CustomEvent("openai:set_globals", { detail: { globals: partial } }));
    } catch(e){}
  }

  function onPortMessage(ev){
    var msg = ev.data;
    if(!msg) return;
    ${livenessResponderScript()}
    if(msg.kind === "ryu-plugin-rpc-chunk"){
      var chunkPending = pending[msg.id];
      if(chunkPending && typeof chunkPending.onChunk === "function") chunkPending.onChunk(msg.delta);
      return;
    }
    if(msg.kind === "ryu-plugin-rpc-result"){
      var p = pending[msg.id]; if(!p) return; delete pending[msg.id];
${widgetRpcResultSettleScript()}
      return;
    }
    if(msg.kind === "ryu-widget-set-globals"){ setGlobals(msg.globals); }
  }

  window.addEventListener("message", function(ev){
    var msg = ev.data;
    if(ev.source === window.parent && msg && msg.kind === "ryu-plugin-theme" && msg.nonce === NONCE){
      applyThemeTokens(msg.tokens);
      return;
    }
    if(!msg || msg.kind !== "ryu-plugin-host-port" || msg.nonce !== NONCE) return;
    var p = ev.ports && ev.ports[0];
    if(!p || port) return;
    port = p; port.onmessage = onPortMessage;
    call("widget.getGlobals", []).then(setGlobals).catch(function(){});
  });

  window.parent.postMessage({ kind: "ryu-plugin-ready", nonce: NONCE, hostApiVersion: ${scriptLiteral(HOST_API_VERSION)} }, "*");
})();`;
}

/**
 * Turn a widget's self-contained HTML (base64) into the srcdoc the host mounts.
 *
 * Uses `DOMParser` (a real browser API in the Tauri webview) rather than string
 * surgery so a literal `<script` inside the bundled JS never gets a stray nonce:
 *   1. strip any CSP the widget shipped (ours is authoritative),
 *   2. nonce EVERY `<script>` (the bundle's module + our bootstrap) — under the
 *      D3 CSP a non-nonced script is refused, so a CDN-referencing widget fails
 *      closed,
 *   3. prepend the hard-pinned CSP meta and the synchronous bridge to `<head>`,
 *      before the module script.
 *
 * @param nonce         Host-generated per-mount nonce (never widget/user input).
 * @param htmlBase64    The widget's single-file HTML document, base64-encoded.
 * @param serverId      The origin MCP server (exposed to the frame as read-only).
 * @param initialGlobals The globals to install synchronously (spec §1.3).
 * @param assetProxy    Optional Core asset-proxy wiring. When present AND the widget
 *                      declared `resourceDomains`, matching remote asset URLs are
 *                      rewritten to `/api/widgets/asset` and the passive-asset CSP is
 *                      widened to the proxy origin (governed egress). Omit it (or an
 *                      empty allowlist) and the CSP is the original `data:`-only lock.
 */
export function widgetBootstrapSrcdoc(
	nonce: string,
	htmlBase64: string,
	serverId: string,
	initialGlobals: WidgetInitialGlobals,
	assetProxy?: WidgetAssetProxy,
	/** True when the containing Ryu root already applies `--ryu-ui-scale`. */
	scaleInParent = false
): string {
	const html = decodeBase64Utf8(htmlBase64);
	const doc = new DOMParser().parseFromString(html, "text/html");

	// (0) Resolve the governed asset-proxy plan: a proxy origin + the widget's
	// declared remote hosts (normalized via the shared public-https sanitizer). Only
	// when BOTH are present do we widen the CSP + rewrite URLs; else the CSP stays the
	// `data:`-only egress lock and no URL is touched (fail-closed, no behavior change).
	const proxyOrigin = assetProxy
		? sanitizeProxyOrigin(assetProxy.proxyOrigin)
		: null;
	const allowHosts = new Set(
		(assetProxy?.resourceDomains ?? [])
			.map(resourceDomainHost)
			.filter((h): h is string => h !== null)
	);
	const proxyPlan =
		proxyOrigin && assetProxy && allowHosts.size > 0
			? { origin: proxyOrigin, allowHosts, proxy: assetProxy }
			: null;

	// (1) The widget's own CSP (if any) never governs — ours is authoritative (D3).
	for (const meta of Array.from(
		doc.querySelectorAll('meta[http-equiv="Content-Security-Policy" i]')
	)) {
		meta.remove();
	}

	// (2) Nonce every script element (module bundle + any others). Under the D3
	// CSP a script without this nonce is refused execution.
	for (const script of Array.from(doc.querySelectorAll("script"))) {
		script.setAttribute("nonce", nonce);
	}

	// (2b) Rewrite declared remote asset URLs through the Core proxy. The CSP is the
	// real boundary (a non-rewritten remote host is simply blocked by img-src); this
	// rewrite is what makes an ALLOWLISTED asset actually render, via governed egress.
	if (proxyPlan) {
		rewriteWidgetAssets(
			doc,
			proxyPlan.origin,
			proxyPlan.allowHosts,
			proxyPlan.proxy
		);
	}

	const head = doc.head ?? doc.documentElement;
	if (initialGlobals.themeTokens) {
		const themeLayout = doc.createElement("style");
		themeLayout.textContent = buildCompanionThemeLayoutCss(scaleInParent);
		head.insertBefore(themeLayout, head.firstChild);
	}

	// (3) The synchronous bridge, then the CSP meta, inserted at the TOP of <head>
	// so both precede the widget's module script (which sits at the end of <body>).
	const bridge = doc.createElement("script");
	bridge.setAttribute("nonce", nonce);
	bridge.textContent = bridgeSource(nonce, serverId, initialGlobals);
	head.insertBefore(bridge, head.firstChild);

	const cspMeta = doc.createElement("meta");
	cspMeta.setAttribute("http-equiv", "Content-Security-Policy");
	cspMeta.setAttribute(
		"content",
		buildWidgetCsp(nonce, proxyPlan?.origin ?? null)
	);
	head.insertBefore(cspMeta, head.firstChild);

	return `<!doctype html>\n${doc.documentElement.outerHTML}`;
}
