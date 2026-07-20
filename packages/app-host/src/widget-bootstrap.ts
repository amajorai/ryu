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
//        the ChatGPT Apps-SDK model, but with Ryu's governed-egress moat intact.
//
// The security boundary is still the null-origin `sandbox="allow-scripts"` iframe
// (ExtensionHost) plus the host-side capability gate (rpc.ts); this file adds the
// content-level defenses (nonce-only scripts, no eval, pinned CSP, proxied egress).

import { HOST_API_VERSION } from "./rpc.ts";
import { sanitizeCspOrigin } from "./third-party-plugin.ts";

/** A widget's optional CSP hints (spec §1.1 `WidgetCsp`). Defined locally so this
 *  module is self-contained. `resource_domains` is the widget's declared remote
 *  passive-asset hosts; the mount rewrites matching URLs through the Core proxy
 *  (governed egress). `connect_domains` remains IGNORED — active fetch never opens
 *  (`connect-src 'none'`); a widget that needs data calls a tool via the bridge. */
export interface WidgetCsp {
	connect_domains?: string[];
	resource_domains?: string[];
}

/** The Core asset-proxy wiring the host injects so a widget's DECLARED remote
 *  assets render while every egress stays governed. When present (and the widget
 *  declared `resourceDomains`), the mount widens the passive-asset CSP to the
 *  proxy origin and rewrites matching asset URLs to `/api/widgets/asset`. */
export interface WidgetAssetProxy {
	/** Minted widget instance id — the proxy's capability + provenance handle. */
	instanceId: string;
	/** The Core node origin (e.g. `http://127.0.0.1:7980`), loopback http. */
	proxyOrigin: string;
	/** The widget's declared remote passive-asset hosts (from `csp.resource_domains`). */
	resourceDomains: string[];
	/** Widget resource uri; scopes the server-side `resource_domains` allowlist. */
	templateUri: string;
}

/** Validate the Core PROXY origin to a bare `scheme://host[:port]`, accepting
 *  loopback **http** (which {@link sanitizeCspOrigin} rejects, being public-https
 *  only). Still rejects CSP-delimiter chars so the (host-controlled, trusted) node
 *  URL can never inject extra directives. Returns null for anything unparseable. */
export function sanitizeProxyOrigin(origin: string): string | null {
	if (typeof origin !== "string" || /[\s;'"]/.test(origin)) {
		return null;
	}
	try {
		const u = new URL(origin.trim());
		if (u.protocol !== "http:" && u.protocol !== "https:") {
			return null;
		}
		return `${u.protocol}//${u.host}`;
	} catch {
		return null;
	}
}

/** Normalize a declared `resource_domains` entry to its bare lowercase host, reusing
 *  the shared public-https {@link sanitizeCspOrigin} then extracting the hostname.
 *  Returns null for anything not a safe exact public host (wildcards/http rejected). */
function resourceDomainHost(entry: string): string | null {
	const origin = sanitizeCspOrigin(entry);
	if (!origin) {
		return null;
	}
	try {
		return new URL(origin).hostname.toLowerCase();
	} catch {
		return null;
	}
}

/** Match `url(...)` targets inside CSS text (inline `style` + `<style>` bodies) so
 *  declared remote asset URLs there are rewritten too. Top-level (never in a loop). */
const CSS_URL_RE = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;

/** The initial globals baked into the widget document synchronously (spec §1.3).
 *  Present before the widget's module script runs so top-level reads of
 *  `window.openai.toolOutput` see real data. */
export interface WidgetInitialGlobals {
	displayMode: "inline" | "fullscreen" | "pip";
	locale: string;
	maxHeight: number | null;
	safeArea: { bottom: number; left: number; right: number; top: number };
	theme: "light" | "dark";
	toolInput: unknown;
	toolOutput: unknown;
	toolResponseMetadata: unknown;
	userAgent?: unknown;
	/** Apps-SDK parity globals (optional; the bridge defaults them when absent). */
	view?: unknown;
	widgetState: unknown;
}

/**
 * The widget CSP (decisions doc D3, governed-compat). The `nonce` gates every
 * script (bootstrap + widget module). `connect-src 'none'` is NEVER widened, so a
 * widget cannot fetch/beacon — all ACTIVE egress goes through `callTool` -> Gateway.
 *
 * `proxyOrigin` (the Core `/api/widgets/asset` origin) is the ONLY widening: when a
 * widget declared remote `resource_domains`, the mount passes it here and rewrites
 * matching asset URLs to that proxy, so `img-src`/`font-src`/`media-src` add exactly
 * that ONE Core origin (in addition to `data:`). The raw remote host is NEVER in the
 * CSP — a widget's passive assets can only load THROUGH the governed proxy, which
 * allowlists and audits every fetch server-side. Omit `proxyOrigin` (no declared
 * assets) and the CSP is the original `data:`-only egress lock, unchanged.
 */
export function buildWidgetCsp(
	nonce: string,
	proxyOrigin?: string | null
): string {
	const origin = proxyOrigin ? sanitizeProxyOrigin(proxyOrigin) : null;
	const passive = origin ? `data: ${origin}` : "data:";
	return [
		"default-src 'none'",
		`script-src 'nonce-${nonce}'`,
		"style-src 'unsafe-inline'",
		`img-src ${passive}`,
		`font-src ${passive}`,
		`media-src ${passive}`,
		"connect-src 'none'",
		"frame-src 'none'",
		"base-uri 'none'",
		"form-action 'none'",
	].join("; ");
}

/** JSON literal safe to embed inside a `<script>` body: escapes `<` so a value
 *  containing `</script>` cannot break out of the tag (defense in depth; the
 *  null-origin sandbox is the real boundary). */
function scriptLiteral(value: unknown): string {
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

  function call(method, args){
    return new Promise(function(resolve, reject){
      if(!port){ reject(new Error("bridge not ready")); return; }
      var id = nextId++;
      pending[id] = { resolve: resolve, reject: reject };
      port.postMessage({ kind: "ryu-plugin-rpc", id: id, method: method, args: args || [] });
    });
  }

  var api = {
    serverId: SERVER_ID,
    toolInput: G.toolInput, toolOutput: G.toolOutput,
    toolResponseMetadata: G.toolResponseMetadata, widgetState: G.widgetState,
    theme: G.theme, locale: G.locale, displayMode: G.displayMode,
    maxHeight: G.maxHeight, safeArea: G.safeArea,
    // window.openai parity globals (Apps-SDK). Present (never undefined) so a widget
    // that reads them at module top-level does not crash; host-pushable via setGlobals.
    view: (G.view != null ? G.view : { displayMode: G.displayMode, maxHeight: G.maxHeight }),
    userAgent: (G.userAgent != null ? G.userAgent : { app: "ryu", locale: G.locale }),
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
    // File methods: governed stubs. They reach the bridge (a KNOWN method) and get a
    // clean "not supported in Ryu v1" rejection, never the unknown-method deny that
    // reads like a bug. Wire minimally later without a frame change.
    uploadFile: function(a){ return call("ui.uploadFile", [a]); },
    selectFiles: function(a){ return call("ui.selectFiles", [a]); },
    getFileDownloadUrl: function(a){ return call("ui.getFileDownloadUrl", [a]); },
    setOpenInAppUrl: function(a){ return call("ui.setOpenInAppUrl", [a]); }
  };
  window.ryu = api; window.openai = api;
  // Detection contract (shared with installRyuBridge): mark THIS bootstrap as the
  // authoritative bridge so the frame-side installRyuBridge() adopts it as a no-op
  // instead of clobbering window.ryu with a port-less runtime.
  window.__ryuHostBridge = true;

  function applyGlobals(partial){
    if(!partial) return;
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
    if(msg.kind === "ryu-plugin-rpc-result"){
      var p = pending[msg.id]; if(!p) return; delete pending[msg.id];
      if(msg.error){
        var e;
        if(typeof msg.error === "string"){ e = new Error(msg.error); }
        else { e = new Error((msg.error && msg.error.message) || "error"); e.code = msg.error && msg.error.code; }
        p.reject(e);
      } else { p.resolve(msg.result); }
      return;
    }
    if(msg.kind === "ryu-widget-set-globals"){ setGlobals(msg.globals); }
  }

  window.addEventListener("message", function(ev){
    var msg = ev.data;
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
	assetProxy?: WidgetAssetProxy
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

/** Build the `/api/widgets/asset` URL for one declared remote asset, or null if the
 *  raw value is not an absolute http(s) URL whose host is in the widget's allowlist.
 *  A non-match is left untouched (and then simply blocked by the CSP — fail-closed). */
function proxiedAssetUrl(
	raw: string,
	origin: string,
	allowHosts: ReadonlySet<string>,
	proxy: WidgetAssetProxy
): string | null {
	let u: URL;
	try {
		u = new URL(raw);
	} catch {
		return null;
	}
	if (u.protocol !== "https:" && u.protocol !== "http:") {
		return null;
	}
	if (!allowHosts.has(u.hostname.toLowerCase())) {
		return null;
	}
	const q = new URLSearchParams({ instance: proxy.instanceId, url: u.href });
	if (proxy.templateUri) {
		q.set("template", proxy.templateUri);
	}
	return `${origin}/api/widgets/asset?${q.toString()}`;
}

/** Rewrite a `srcset` value, proxying each descriptor's URL that is allowlisted. */
function rewriteSrcset(
	value: string,
	origin: string,
	allowHosts: ReadonlySet<string>,
	proxy: WidgetAssetProxy
): string {
	return value
		.split(",")
		.map((part) => {
			const seg = part.trim();
			if (!seg) {
				return seg;
			}
			const space = seg.indexOf(" ");
			const url = space === -1 ? seg : seg.slice(0, space);
			const descriptor = space === -1 ? "" : seg.slice(space);
			const proxied = proxiedAssetUrl(url, origin, allowHosts, proxy);
			return `${proxied ?? url}${descriptor}`;
		})
		.join(", ");
}

/** Rewrite `url(...)` targets inside CSS text (inline style + `<style>` bodies). */
function rewriteCssUrls(
	css: string,
	origin: string,
	allowHosts: ReadonlySet<string>,
	proxy: WidgetAssetProxy
): string {
	return css.replace(CSS_URL_RE, (match, quote: string, url: string) => {
		const proxied = proxiedAssetUrl(url.trim(), origin, allowHosts, proxy);
		return proxied ? `url(${quote}${proxied}${quote})` : match;
	});
}

/** Point a widget's DECLARED remote passive assets at the Core proxy so they render
 *  under the governed CSP. Covers `src`/`poster` attributes, `srcset` descriptors,
 *  and `url(...)` in inline `style` attributes and `<style>` bodies — the forms a
 *  single-file widget bundle uses. Anything missed stays a raw remote URL and is
 *  blocked by the CSP (never a broken-open egress). */
function rewriteWidgetAssets(
	doc: Document,
	origin: string,
	allowHosts: ReadonlySet<string>,
	proxy: WidgetAssetProxy
): void {
	for (const el of Array.from(doc.querySelectorAll("[src],[poster]"))) {
		for (const attr of ["src", "poster"]) {
			const v = el.getAttribute(attr);
			if (!v) {
				continue;
			}
			const proxied = proxiedAssetUrl(v, origin, allowHosts, proxy);
			if (proxied) {
				el.setAttribute(attr, proxied);
			}
		}
	}
	for (const el of Array.from(doc.querySelectorAll("[srcset]"))) {
		const v = el.getAttribute("srcset");
		if (v) {
			el.setAttribute("srcset", rewriteSrcset(v, origin, allowHosts, proxy));
		}
	}
	for (const el of Array.from(doc.querySelectorAll("[style]"))) {
		const v = el.getAttribute("style");
		if (v?.includes("url(")) {
			el.setAttribute("style", rewriteCssUrls(v, origin, allowHosts, proxy));
		}
	}
	for (const styleEl of Array.from(doc.querySelectorAll("style"))) {
		const css = styleEl.textContent;
		if (css?.includes("url(")) {
			styleEl.textContent = rewriteCssUrls(css, origin, allowHosts, proxy);
		}
	}
}
