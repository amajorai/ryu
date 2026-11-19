// Governed passive-asset rewriting for widget documents (DOM-free helpers).

import { describe, expect, it } from "bun:test";
import {
	proxiedAssetUrl,
	resourceDomainHost,
	rewriteCssUrls,
	rewriteSrcset,
	type WidgetAssetProxy,
} from "./widget-assets.ts";

const ORIGIN = "http://127.0.0.1:7980";
const ALLOW = new Set(["cdn.example.com"]);
const PROXY: WidgetAssetProxy = {
	instanceId: "inst",
	proxyOrigin: ORIGIN,
	resourceDomains: ["cdn.example.com"],
	templateUri: "ui://w",
};
const PROXIED_A =
	"http://127.0.0.1:7980/api/widgets/asset?instance=inst&url=https%3A%2F%2Fcdn.example.com%2Fa.png&template=ui%3A%2F%2Fw";

describe("resourceDomainHost", () => {
	it("normalizes a declared host and rejects unsafe entries", () => {
		expect(resourceDomainHost("CDN.Example.com")).toBe("cdn.example.com");
		expect(resourceDomainHost("*.example.com")).toBeNull();
		expect(resourceDomainHost("http://cdn.example.com")).toBeNull();
	});
});

describe("proxiedAssetUrl", () => {
	it("proxies only absolute allowlisted http(s) URLs", () => {
		expect(
			proxiedAssetUrl("https://cdn.example.com/a.png", ORIGIN, ALLOW, PROXY)
		).toBe(PROXIED_A);
		expect(
			proxiedAssetUrl("https://other.example.com/a.png", ORIGIN, ALLOW, PROXY)
		).toBeNull();
		expect(proxiedAssetUrl("/relative.png", ORIGIN, ALLOW, PROXY)).toBeNull();
		expect(
			proxiedAssetUrl("data:image/png;base64,AA", ORIGIN, ALLOW, PROXY)
		).toBeNull();
	});
});

describe("rewriteSrcset and rewriteCssUrls", () => {
	it("rewrite matching URLs and keep descriptors and other hosts", () => {
		expect(
			rewriteSrcset(
				"https://cdn.example.com/a.png 1x, https://x.example.org/b.png 2x",
				ORIGIN,
				ALLOW,
				PROXY
			)
		).toBe(`${PROXIED_A} 1x, https://x.example.org/b.png 2x`);
		expect(
			rewriteCssUrls(
				"a{background:url('https://cdn.example.com/a.png')}b{background:url(https://x.org/c.png)}",
				ORIGIN,
				ALLOW,
				PROXY
			)
		).toBe(
			`a{background:url('${PROXIED_A}')}b{background:url(https://x.org/c.png)}`
		);
	});
});
