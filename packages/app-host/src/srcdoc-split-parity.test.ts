// Byte-parity guard for the sandbox document builders.
//
// `third-party-plugin.ts` and `widget-bootstrap.ts` generate the srcdoc and
// bootstrap JavaScript every sandboxed Companion app and widget runs (CSP, theme,
// locale, liveness, the RPC bridge). They were split into sibling modules purely
// to stay under the repository's file-size limits. Each case below hashes one
// generator's output for a representative input; the expected digests were
// computed from the unsplit code, so any byte that moves in the generated
// documents fails here. When a generator is changed ON PURPOSE, recompute the
// affected digests (run this file with `SRCDOC_PARITY_DUMP=<path>` to write the
// actual digests and outputs as JSON) and say why in the change.
//
// `widgetBootstrapSrcdoc` needs `DOMParser`, a webview API Bun does not provide.
// A small recording fake stands in for it: it serializes exactly what the builder
// inserts (CSP meta, bridge script, layout style) and every attribute it rewrites,
// so the trusted bootstrap source and the asset-proxy rewrite are both covered.

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import {
	buildCompanionThemeLayoutCss,
	buildHtmlCompanionCsp,
	buildThemeTokenStyle,
	companionScriptLiteralSchema,
	htmlCompanionSrcdoc,
	RPC_ARGS_SCRIPT,
	sanitizeCspOrigin,
	thirdPartyPluginSrcdoc,
} from "./third-party-plugin.ts";
import {
	buildWidgetCsp,
	sanitizeProxyOrigin,
	type WidgetInitialGlobals,
	widgetBootstrapSrcdoc,
} from "./widget-bootstrap.ts";

function sha256(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

const NONCE = "nonce-1234";
// The hash source of the script text "abc" (script-src lists hashes, not the nonce).
const SCRIPT_HASH = "'sha256-ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0='";
const PLUGIN_ID = "@ryu/parity";
const MOUNT_CONTEXT = { spaceId: "space-1", docId: "doc-</script>-1" };
const THEME_TOKENS: Record<string, string> = {
	"--background": "oklch(0.2 0 0)",
	"--foreground": "#fff",
	"--primary": "oklch(0.6 0.1 250 / 90%)",
	"--ryu-theme-mode": "dark",
	"--ryu-color-scheme": "dark",
	"--bg": "explicit-alias",
	"--bad-value": "red; } body { x",
	BadName: "1px",
};
const LOCALE = { locale: "ar", direction: "rtl" } as const;
const APP_HTML =
	'<!DOCTYPE html><html lang="en"><head><meta charset="utf-8" /><title>App</title></head><body><div id="root"></div><script type="module">console.log("app")</script></body></html>';
const PLUGIN_CODE_B64 = Buffer.from(
	"export function activate(ctx) { return ctx; } // é ",
	"utf8"
).toString("base64");

/** A recording stand-in for the few DOM APIs `widgetBootstrapSrcdoc` touches. */
class FakeElement {
	readonly attrs = new Map<string, string>();
	readonly tag: string;
	textContent: string | null;
	removed = false;

	constructor(tag: string, attrs: Record<string, string> = {}, text = "") {
		this.tag = tag;
		this.textContent = text || null;
		for (const [name, value] of Object.entries(attrs)) {
			this.attrs.set(name, value);
		}
	}

	getAttribute(name: string): string | null {
		return this.attrs.get(name) ?? null;
	}

	setAttribute(name: string, value: string): void {
		this.attrs.set(name, value);
	}

	remove(): void {
		this.removed = true;
	}

	serialize(): string {
		const attrs = [...this.attrs.entries()]
			.map(([name, value]) => ` ${name}="${value}"`)
			.join("");
		return `<${this.tag}${attrs}>${this.textContent ?? ""}</${this.tag}>`;
	}
}

class FakeDocument {
	readonly headChildren: FakeElement[] = [];
	readonly body: FakeElement[];
	readonly head = {
		firstChild: null as FakeElement | null,
		insertBefore: (node: FakeElement, before: FakeElement | null) => {
			const index = before ? this.headChildren.indexOf(before) : -1;
			if (index === -1) {
				this.headChildren.push(node);
			} else {
				this.headChildren.splice(index, 0, node);
			}
			this.head.firstChild = this.headChildren[0] ?? null;
		},
	};
	readonly documentElement = {
		get outerHTML(): string {
			return "";
		},
	};

	constructor(source: string) {
		this.body = [
			new FakeElement("meta", {
				"http-equiv": "Content-Security-Policy",
				content: "default-src *",
			}),
			new FakeElement("script", { type: "module" }, source),
			new FakeElement("img", {
				src: "https://cdn.example.com/a.png",
				srcset:
					"https://cdn.example.com/a.png 1x, https://other.example.org/b.png 2x",
			}),
			new FakeElement("video", { poster: "https://cdn.example.com/p.jpg" }),
			new FakeElement("div", {
				style: "background:url('https://cdn.example.com/bg.png')",
			}),
			new FakeElement(
				"style",
				{},
				'.x{background:url("https://cdn.example.com/s.png")}.y{background:url(https://evil.example.net/z.png)}'
			),
		];

		Object.defineProperty(this.documentElement, "outerHTML", {
			get: () =>
				`<html><head>${this.headChildren.map((el) => el.serialize()).join("")}</head><body>${this.body
					.filter((el) => !el.removed)
					.map((el) => el.serialize())
					.join("")}</body></html>`,
		});
	}

	createElement(tag: string): FakeElement {
		return new FakeElement(tag);
	}

	querySelectorAll(selector: string): FakeElement[] {
		const all = this.body.filter((el) => !el.removed);
		switch (selector) {
			case 'meta[http-equiv="Content-Security-Policy" i]':
				return all.filter((el) => el.tag === "meta");
			case "script":
				return all.filter((el) => el.tag === "script");
			case "[src],[poster]":
				return all.filter(
					(el) => el.attrs.has("src") || el.attrs.has("poster")
				);
			case "[srcset]":
				return all.filter((el) => el.attrs.has("srcset"));
			case "[style]":
				return all.filter((el) => el.attrs.has("style"));
			case "style":
				return all.filter((el) => el.tag === "style");
			default:
				throw new Error(`unexpected selector ${selector}`);
		}
	}
}

class FakeDomParser {
	parseFromString(html: string): FakeDocument {
		return new FakeDocument(html);
	}
}

const WIDGET_GLOBALS: WidgetInitialGlobals = {
	displayMode: "inline",
	locale: "en-US",
	maxHeight: 480,
	safeArea: { bottom: 0, left: 0, right: 0, top: 0 },
	theme: "dark",
	toolInput: { q: "</script>" },
	toolOutput: { items: [1, 2, 3] },
	toolResponseMetadata: null,
	widgetState: null,
};

function cases(): Record<string, string> {
	const out: Record<string, string> = {};
	out["plugin.minimal"] = thirdPartyPluginSrcdoc(
		NONCE,
		PLUGIN_CODE_B64,
		PLUGIN_ID
	);
	out["plugin.full"] = thirdPartyPluginSrcdoc(
		NONCE,
		PLUGIN_CODE_B64,
		PLUGIN_ID,
		MOUNT_CONTEXT,
		THEME_TOKENS,
		false,
		{ closeOnEscape: true, locale: LOCALE }
	);
	out["plugin.scaled-no-csp"] = thirdPartyPluginSrcdoc(
		"other nonce",
		PLUGIN_CODE_B64,
		"@ryu/</script>",
		null,
		THEME_TOKENS,
		true,
		{ enforceDefaultCsp: false, closeOnEscape: false }
	);
	out["html.minimal"] = htmlCompanionSrcdoc(NONCE, APP_HTML, PLUGIN_ID);
	out["html.full"] = htmlCompanionSrcdoc(
		NONCE,
		APP_HTML,
		PLUGIN_ID,
		MOUNT_CONTEXT,
		{
			connectDomains: ["api.example.com", "https://x.example.org:8443/path"],
			resourceDomains: ["cdn.example.com", "*.evil.com", "http://plain.com"],
		},
		THEME_TOKENS,
		true,
		{ closeOnEscape: true, locale: { locale: "pt-BR" } }
	);
	out["html.no-csp"] = htmlCompanionSrcdoc(
		NONCE,
		`  ${APP_HTML}`,
		PLUGIN_ID,
		undefined,
		undefined,
		undefined,
		false,
		{ enforceDefaultCsp: false }
	);
	out["html.trusted-csp-opt-out"] = htmlCompanionSrcdoc(
		NONCE,
		APP_HTML,
		PLUGIN_ID,
		undefined,
		{ connectDomains: [] },
		undefined,
		false,
		{ enforceDefaultCsp: false }
	);
	out["layout.scaled"] = buildCompanionThemeLayoutCss(true);
	out["layout.unscaled"] = buildCompanionThemeLayoutCss(false);
	out["csp.default"] = buildHtmlCompanionCsp();
	out["csp.allowlist"] = buildHtmlCompanionCsp({
		connectDomains: ["api.example.com", "bad host", "localhost", "ws://x.com"],
		resourceDomains: ["img.example.com", "https://cdn.example.com:444"],
	});
	out["theme.tokens"] = buildThemeTokenStyle(THEME_TOKENS);
	out["theme.empty"] = buildThemeTokenStyle({});
	out["theme.none"] = buildThemeTokenStyle();
	out["origin.samples"] = JSON.stringify(
		[
			"example.com",
			"https://example.com:8443/x",
			"http://example.com",
			"*.example.com",
			"localhost",
			"a;b.com",
			"  sub.example.com  ",
			"",
			42,
			null,
		].map((entry) => sanitizeCspOrigin(entry))
	);
	out["literal.samples"] = JSON.stringify(
		[undefined, null, "</script>&  ", { a: [1, "<b>"] }].map((value) =>
			companionScriptLiteralSchema.parse(value)
		)
	);
	out["rpc-args.script"] = RPC_ARGS_SCRIPT;
	out["widget.csp"] = buildWidgetCsp([SCRIPT_HASH]);
	out["widget.csp.proxy"] = buildWidgetCsp(
		[SCRIPT_HASH],
		"http://127.0.0.1:7980/ignored"
	);
	out["widget.proxy-origins"] = JSON.stringify(
		[
			"http://127.0.0.1:7980",
			"https://node.example.com/path",
			"ftp://x",
			"http://a b",
			7,
		].map((entry) => sanitizeProxyOrigin(entry))
	);
	const html = Buffer.from(
		'<script type="module">window.openai.toolOutput é</script>',
		"utf8"
	).toString("base64");
	out["widget.srcdoc.plain"] = widgetBootstrapSrcdoc(
		NONCE,
		html,
		"server-1",
		WIDGET_GLOBALS
	);
	out["widget.srcdoc.proxied"] = widgetBootstrapSrcdoc(
		NONCE,
		html,
		"server-</script>",
		{
			...WIDGET_GLOBALS,
			displayMode: "fullscreen",
			friendly: false,
			themeTokens: THEME_TOKENS,
			view: { displayMode: "fullscreen" },
		},
		{
			instanceId: "inst-1",
			proxyOrigin: "http://127.0.0.1:7980",
			resourceDomains: ["cdn.example.com"],
			templateUri: "ui://widget/x.html",
		},
		true
	);
	return out;
}

// Digests of the unsplit builders' output (sha256, hex). The plugin, html and
// widget documents were recomputed on purpose for the app.request error relay:
// their embedded RPC error decoder now copies `status` and `reason`, and
// rejects an empty string error instead of resolving it. The four widget
// digests (both policies, both documents) were recomputed on purpose again
// for script admission by hash: `script-src` lists sha256 hashes in place of
// the nonce, no script element carries a nonce attribute, and the document
// carries a second policy meta (`script-src-elem 'unsafe-inline'`).
const EXPECTED: Record<string, string> = {
	"plugin.minimal":
		"d5b173c5a78f0cb58236116861612516d3c722ff81c2819ae7af0d6ed87dc5ac",
	"plugin.full":
		"47f8ed0583e4d021218755d6dfa24cf69acf4d2d3ba5274b94561beaf06b96e7",
	"plugin.scaled-no-csp":
		"6430bf4824500981169ef7123dcf85ff32d69e7c1c0db6d62ab9b79f7c29ca60",
	"html.minimal":
		"a2c4e7e440acf65bec6f2e29facde6a5e4783e2da890eb764bd2b625928fb26e",
	"html.full":
		"99918ca9bc917924453c2c761a3fb28a28141e27fd0ad6feb3cf9afe4d142d02",
	"html.no-csp":
		"535554bddfd542120edc8148e07361202e5957a942b498ceb2e7f4382ce14c12",
	"html.trusted-csp-opt-out":
		"a2c4e7e440acf65bec6f2e29facde6a5e4783e2da890eb764bd2b625928fb26e",
	"layout.scaled":
		"90ed413d2b957b5fcb776beed5c016f85b13d81546ebe787232d4c54705e6ed1",
	"layout.unscaled":
		"29bf72e8352a64c750c1de58f71a4070814a22a8b0c456d2fe692103801d2866",
	"csp.default":
		"c7316bb937181e9a250e0ca5e0d001649ca9d34fd020e11a452bdab31d76397e",
	"csp.allowlist":
		"9eac895ec854ee34cc35b69c3b78ed46433b4cb5c9fa24a5b514e50a0341bddd",
	"theme.tokens":
		"023e36708433f03c2f47e555bdf1edd249dd98e2dcc53e8380fea054e10017cb",
	"theme.empty":
		"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
	"theme.none":
		"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
	"origin.samples":
		"27d40a2cc97f925d0655198918c8e2cb5d8b2357dd938d12a49c6bf6a77c8693",
	"literal.samples":
		"6a8d4a56988400a5c361919c0846eeedd94cd3b9acaf071e6d9014c6ce01efa9",
	"rpc-args.script":
		"d5d7fe354816139d400fddad95e78c3bd598a8eb838cfb5f193cf927d3ec1b41",
	"widget.csp":
		"466f9f181561519ea7fc161463eab85e6c8e874a1c07ed21aec90a6accd7f9b1",
	"widget.csp.proxy":
		"4c887376a1d6337b6c6c4bc2bfa9602bae319dfdb7268348d122c9d8dce4382d",
	"widget.proxy-origins":
		"fb91e2c5029e67ff3dba2657870339c8dd6fff595912ab8940ac01ce399602eb",
	"widget.srcdoc.plain":
		"8c3b15db2e80785b363f4e163d5cf6c1202e0710f8e28ce7c4a5f28be56d7eeb",
	"widget.srcdoc.proxied":
		"f4f86be636ed9d2d1a5844be93aafcd99ce829290ce426a7356c292cf8173543",
};

describe("srcdoc split parity", () => {
	const globals = globalThis as { DOMParser?: unknown };
	const previousDomParser = globals.DOMParser;

	beforeAll(() => {
		globals.DOMParser = FakeDomParser;
	});

	afterAll(() => {
		globals.DOMParser = previousDomParser;
	});

	it("generates byte-identical documents and fragments", async () => {
		const outputs = cases();
		const actual = Object.fromEntries(
			Object.entries(outputs).map(([name, value]) => [name, sha256(value)])
		);
		if (process.env.SRCDOC_PARITY_DUMP) {
			await Bun.write(
				process.env.SRCDOC_PARITY_DUMP,
				JSON.stringify({ actual, outputs }, null, "\t")
			);
		}
		expect(actual).toEqual(EXPECTED);
	});
});
