// The widget CSP and the Core asset-proxy origin validator.

import { describe, expect, it } from "bun:test";
import { buildWidgetCsp, sanitizeProxyOrigin } from "./widget-csp.ts";

describe("buildWidgetCsp", () => {
	it("pins nonce-only scripts and a data:-only passive lock by default", () => {
		const csp = buildWidgetCsp("abc");
		expect(csp).toContain("script-src 'nonce-abc'");
		expect(csp).toContain("img-src data:;");
		expect(csp).toContain("connect-src 'none'");
	});

	it("widens passive assets to exactly the sanitized proxy origin", () => {
		const csp = buildWidgetCsp("abc", "http://127.0.0.1:7980/api");
		expect(csp).toContain("img-src data: http://127.0.0.1:7980;");
		expect(csp).toContain("font-src data: http://127.0.0.1:7980;");
		expect(csp).toContain("connect-src 'none'");
	});
});

describe("sanitizeProxyOrigin", () => {
	it("accepts loopback http and https origins", () => {
		expect(sanitizeProxyOrigin("http://127.0.0.1:7980/x")).toBe(
			"http://127.0.0.1:7980"
		);
		expect(sanitizeProxyOrigin("https://node.example.com")).toBe(
			"https://node.example.com"
		);
	});

	it("rejects other schemes, delimiters and non-strings", () => {
		expect(sanitizeProxyOrigin("ftp://x")).toBeNull();
		expect(sanitizeProxyOrigin("http://a b")).toBeNull();
		expect(sanitizeProxyOrigin(7)).toBeNull();
	});
});
