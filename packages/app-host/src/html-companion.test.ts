// DOM-free tests for the Path B (`ui_format:"html"`) companion srcdoc builder
// `htmlCompanionSrcdoc`. It wraps a self-contained app HTML (a
// vite-plugin-singlefile build) by injecting, as the first children of <head>, a
// relaxed-but-locked CSP and the synchronous `window.ryu` bridge bootstrap — so the
// app mounts directly as `srcdoc` (no `new Function` eval) yet still reaches the
// host over the same capability-gated port protocol. These assert the injection
// shape, the egress lock, and the ordering guarantee without a webview.

import { describe, expect, it } from "bun:test";
import { htmlCompanionSrcdoc } from "./third-party-plugin.ts";

const NONCE = "host-nonce-abc";
const PLUGIN_ID = "com.ryu.whiteboard";
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

	it("injects the bridge bootstrap and mount context into the frame", () => {
		expect(out).toContain("window.ryu = ryu");
		expect(out).toContain("ryu-plugin-ready");
		expect(out).toContain('"spaceId"');
		expect(out).toContain('"docId"');
		expect(out).toContain(NONCE);
	});

	it("keeps the egress lock and only widens asset sources", () => {
		expect(out).toContain("connect-src 'none'");
		expect(out).toContain("font-src data:");
		expect(out).toContain("img-src data: blob:");
		// No remote code / network beyond assets.
		expect(out).not.toContain("connect-src *");
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

	it("escapes </script> and separators in the mount context (no tag breakout)", () => {
		const res = htmlCompanionSrcdoc(NONCE, APP_HTML, PLUGIN_ID, {
			evil: "</script><script>alert(1)</script>",
		});
		expect(res).not.toContain("</script><script>alert(1)");
		expect(res).toContain("\\u003c");
	});
});
