// DOM-free tests for the Path B (`ui_format:"html"`) companion srcdoc builder
// `htmlCompanionSrcdoc`. It wraps a self-contained app HTML (a
// vite-plugin-singlefile build) by injecting, as the first children of <head>, a
// relaxed-but-locked CSP and the synchronous `window.ryu` bridge bootstrap — so the
// app mounts directly as `srcdoc` (no `new Function` eval) yet still reaches the
// host over the same capability-gated port protocol. These assert the injection
// shape, the egress lock, and the ordering guarantee without a webview.

import { describe, expect, it } from "bun:test";
import { runInThisContext } from "node:vm";
import {
	htmlCompanionSrcdoc,
	RPC_ARGS_SCRIPT,
	thirdPartyPluginSrcdoc,
} from "./third-party-plugin.ts";

const NONCE = "host-nonce-abc";
const PLUGIN_ID = "@ryu/whiteboard";
const APP_HTML =
	'<!doctype html><html lang="en"><head><meta charset="utf-8" /><title>Whiteboard</title></head><body><div id="ryu-plugin-root"></div><script type="module">console.log("app")</script></body></html>';

describe("htmlCompanionSrcdoc", () => {
	const out = htmlCompanionSrcdoc(NONCE, APP_HTML, PLUGIN_ID, {
		spaceId: "space-1",
		docId: "doc-1",
	});

	it("preserves the app's own body/root and app script", () => {
		expect(out).toContain('<div id="ryu-plugin-root"></div>');
		expect(out).toContain('console.log("app")');
	});

	it("installs wheel scrolling before the app module", () => {
		const wheelAdapterAt = out.indexOf("ryuInstallHorizontalWheelScrolling");
		const appScriptAt = out.indexOf('console.log("app")');

		expect(wheelAdapterAt).toBeGreaterThanOrEqual(0);
		expect(wheelAdapterAt).toBeLessThan(appScriptAt);
	});

	it("injects the bridge bootstrap and mount context into the frame", () => {
		expect(out).toContain("window.ryu = ryu");
		expect(out).toContain('call("i18n.get"');
		expect(out).toContain('call("i18n.translate"');
		expect(out).toContain('callStream("i18n.subscribe"');
		expect(out).toContain("tokenTable");
		expect(out).toContain("ryu-plugin-ready");
		expect(out).toContain("ryu-plugin-theme");
		expect(out).toContain("applyThemeTokens");
		expect(out).toContain('"spaceId"');
		expect(out).toContain('"docId"');
		expect(out).toContain(NONCE);
	});

	it("marshals RPC arguments with JSON member semantics in both companion bootstraps", () => {
		const pathA = thirdPartyPluginSrcdoc(NONCE, "", PLUGIN_ID);
		for (const srcdoc of [out, pathA]) {
			expect(srcdoc).toContain("function rpcArgs(value)");
			expect(srcdoc).not.toContain("args: args || []");
			expect(srcdoc.match(/args: rpcArgs\(args \|\| \[\]\)/g)).toHaveLength(2);
		}
		const rpcArgs: (value: unknown) => unknown = runInThisContext(
			`(function () {${RPC_ARGS_SCRIPT}\nreturn rpcArgs; })()`
		);
		const blob = new Blob(["frame bytes"]);
		const prototypeKey = JSON.parse('{"__proto__":{"kept":true}}');
		const marshalled = rpcArgs([
			{
				body: { account_id: undefined, nested: [{ skip: undefined, x: 1 }] },
				method: "POST",
				path: "/inbox/refresh",
			},
			blob,
			prototypeKey,
		]);
		expect(JSON.stringify(marshalled)).toBe(
			'[{"body":{"nested":[{"x":1}]},"method":"POST","path":"/inbox/refresh"},{},{"__proto__":{"kept":true}}]'
		);
		const [request, file, prototypeEntry] = marshalled as [
			{ body: Record<string, unknown> },
			Blob,
			Record<string, unknown>,
		];
		expect(Object.hasOwn(request.body, "account_id")).toBe(false);
		expect(file).toBe(blob);
		expect(Object.getPrototypeOf(prototypeEntry)).toBe(Object.prototype);
		expect(Object.hasOwn(prototypeEntry, "__proto__")).toBe(true);
	});

	it("mediates trusted _blank links through the host in both companion bootstraps", () => {
		const pathA = thirdPartyPluginSrcdoc(NONCE, "", PLUGIN_ID);
		for (const srcdoc of [out, pathA]) {
			expect(srcdoc).toContain('document.addEventListener("click"');
			expect(srcdoc).toContain("!event.isTrusted");
			expect(srcdoc).toContain(
				'call("ui.openExternal", [{ href: destination.href }])'
			);
			expect(srcdoc).toContain('destination.protocol !== "https:"');
			expect(srcdoc).toContain('destination.protocol !== "http:"');
		}
	});

	it("forwards Approvals icon and archive actions through the governed bridge", () => {
		for (const method of ["appIcons", "archive", "unarchive"]) {
			expect(out).toContain(
				`${method}: function (a) { return call("notifications.${method}", [a || {}]); }`
			);
		}
	});

	it("adds compatibility aliases to the initial theme snapshot", () => {
		const themed = htmlCompanionSrcdoc(
			NONCE,
			APP_HTML,
			PLUGIN_ID,
			undefined,
			undefined,
			{
				"--background": "#101114",
				"--foreground": "#f5f5f5",
				"--card": "#181a20",
			}
		);
		expect(themed).toContain("--bg: #101114;");
		expect(themed).toContain("--fg: #f5f5f5;");
		expect(themed).toContain("--panel: #181a20;");
	});

	it("seeds the explicit mode and appearance state before the app script", () => {
		const themed = htmlCompanionSrcdoc(
			NONCE,
			APP_HTML,
			PLUGIN_ID,
			undefined,
			undefined,
			{
				"--ryu-theme-mode": "dark",
				"--ryu-color-scheme": "dark",
				"--ryu-ui-scale": "1.25",
				"--ryu-dialog-overlay-mode": "off",
			}
		);
		expect(themed).toContain('"--ryu-theme-mode":"dark"');
		expect(themed).toContain("--ryu-ui-scale: 1.25;");
		expect(themed).toContain(
			"html body{zoom:var(--ryu-ui-scale, 1) !important;}"
		);
		expect(
			themed.indexOf("applyThemeTokens(INITIAL_THEME_TOKENS)")
		).toBeLessThan(themed.indexOf('console.log("app")'));
	});

	it("does not inject a node target, token, or realtime URL into the frame", () => {
		expect(out).not.toContain("/api/realtime/ws");
		expect(out).not.toContain("node-secret");
		expect(out).not.toContain("Authorization");
	});

	it("keeps the egress lock and only widens asset sources", () => {
		expect(out).toContain("connect-src 'none'");
		expect(out).toContain("font-src data:");
		expect(out).toContain("img-src data: blob:");
		// No remote code / network beyond assets.
		expect(out).not.toContain("connect-src *");
	});

	it("omits the default policy only when Core disables it for a custom app", () => {
		const unlockedHtml = htmlCompanionSrcdoc(
			NONCE,
			APP_HTML,
			PLUGIN_ID,
			undefined,
			undefined,
			undefined,
			false,
			{ enforceDefaultCsp: false }
		);
		const declaredPolicyHtml = htmlCompanionSrcdoc(
			NONCE,
			APP_HTML,
			PLUGIN_ID,
			undefined,
			{ connectDomains: ["https://api.example.com"], resourceDomains: [] },
			undefined,
			false,
			{ enforceDefaultCsp: false }
		);
		const unlockedEsm = thirdPartyPluginSrcdoc(
			NONCE,
			"Y29uc29sZS5sb2coJ2hpJyk=",
			PLUGIN_ID,
			undefined,
			undefined,
			false,
			{ enforceDefaultCsp: false }
		);

		expect(unlockedHtml).not.toContain("Content-Security-Policy");
		expect(declaredPolicyHtml).toContain("Content-Security-Policy");
		expect(declaredPolicyHtml).toContain("connect-src https://api.example.com");
		expect(unlockedEsm).not.toContain("Content-Security-Policy");
	});

	it("injects the CSP + bridge BEFORE the app's deferred module script", () => {
		const cspAt = out.indexOf("Content-Security-Policy");
		const bootstrapAt = out.indexOf("ryu-plugin-ready");
		const appScriptAt = out.indexOf('console.log("app")');
		expect(cspAt).toBeGreaterThanOrEqual(0);
		expect(bootstrapAt).toBeGreaterThan(cspAt);
		// The whole injected fragment must precede the app's own script so the app's
		// first effect sees window.ryu (queued into the outbox until the port lands).
		expect(appScriptAt).toBeGreaterThan(bootstrapAt);
	});

	it("falls back to prepending when the app HTML has no <head>", () => {
		const noHead = '<div id="ryu-plugin-root"></div>';
		const res = htmlCompanionSrcdoc(NONCE, noHead, PLUGIN_ID);
		expect(res).toContain("Content-Security-Policy");
		expect(res.indexOf("Content-Security-Policy")).toBeLessThan(
			res.indexOf('id="ryu-plugin-root"')
		);
	});

	it("locks the document before a hostile pre-head script", () => {
		const marker = "HOSTILE_PRE_HEAD_SCRIPT";
		const hostile = `<!doctype html><script>${marker};fetch("https://example.com/leak")</script><html><head></head><body></body></html>`;
		const res = htmlCompanionSrcdoc(NONCE, hostile, PLUGIN_ID);
		const hostileAt = res.indexOf(marker);

		expect(res.indexOf("Content-Security-Policy")).toBeLessThan(hostileAt);
		expect(res.indexOf("ryu-plugin-ready")).toBeLessThan(hostileAt);
	});

	it("escapes </script> and separators in the mount context (no tag breakout)", () => {
		const res = htmlCompanionSrcdoc(NONCE, APP_HTML, PLUGIN_ID, {
			evil: "</script><script>alert(1)</script>",
		});
		expect(res).not.toContain("</script><script>alert(1)");
		expect(res).toContain("\\u003c");
	});
});
