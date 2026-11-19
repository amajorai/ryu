// CSP helpers for the full-HTML Companion document.

import { describe, expect, it } from "bun:test";
import { buildHtmlCompanionCsp, sanitizeCspOrigin } from "./companion-csp.ts";

describe("sanitizeCspOrigin", () => {
	it("normalizes exact public https hosts", () => {
		expect(sanitizeCspOrigin("api.example.com")).toBe(
			"https://api.example.com"
		);
		expect(sanitizeCspOrigin("https://x.example.org:8443/p")).toBe(
			"https://x.example.org:8443"
		);
	});

	it("rejects wildcards, single labels, other schemes and delimiters", () => {
		for (const entry of [
			"*.example.com",
			"localhost",
			"http://example.com",
			"a;b.com",
			"",
			7,
		]) {
			expect(sanitizeCspOrigin(entry)).toBeNull();
		}
	});
});

describe("buildHtmlCompanionCsp", () => {
	it("keeps the egress lock by default", () => {
		const csp = buildHtmlCompanionCsp();
		expect(csp).toContain("connect-src 'none'; webrtc 'block'");
		expect(csp).toContain("img-src data: blob:");
		expect(csp).toStartWith("default-src 'none'");
	});

	it("appends only sanitized allowlist origins", () => {
		const csp = buildHtmlCompanionCsp({
			connectDomains: ["api.example.com", "bad host"],
			resourceDomains: ["cdn.example.com", "*.evil.com"],
		});
		expect(csp).toContain("connect-src https://api.example.com;");
		expect(csp).not.toContain("webrtc 'block'");
		expect(csp).toContain("img-src data: blob: https://cdn.example.com");
		expect(csp).toContain("media-src data: blob: https://cdn.example.com");
		expect(csp).not.toContain("evil");
	});
});
