// Unit tests for the CSP/origin sanitizers and the theme-token style builder.
//
// These are load-bearing SECURITY seams: their output is interpolated into a
// widget/companion Content-Security-Policy or a `<style>` block, so a sanitizer
// that lets a CSP-delimiter char or a wildcard host through is a directive-
// injection / egress-widening bug. The tests spend their assertions on the
// rejection and injection paths, not the happy path, and pin the DELIBERATE
// divergence between the two origin sanitizers (the loopback-http seam).
//
// DOM-free: none of these three functions touches `document`/`DOMParser`.

import { describe, expect, it } from "bun:test";
import { buildThemeTokenStyle, sanitizeCspOrigin } from "./third-party-plugin.ts";
import { sanitizeProxyOrigin } from "./widget-bootstrap.ts";

// ── sanitizeCspOrigin: public-https allowlist sanitizer ─────────────────────────

describe("sanitizeCspOrigin (widget/companion resource_domains allowlist)", () => {
	it("accepts a bare public host and assumes https", () => {
		expect(sanitizeCspOrigin("cdn.example.com")).toBe("https://cdn.example.com");
	});

	it("accepts an explicit https origin and preserves a port", () => {
		expect(sanitizeCspOrigin("https://cdn.example.com")).toBe("https://cdn.example.com");
		expect(sanitizeCspOrigin("https://cdn.example.com:8443")).toBe("https://cdn.example.com:8443");
	});

	it("drops the path/query, keeping only scheme://host[:port]", () => {
		expect(sanitizeCspOrigin("https://cdn.example.com/assets?x=1")).toBe("https://cdn.example.com");
	});

	it("rejects any entry carrying CSP-delimiter chars (no directive injection)", () => {
		expect(sanitizeCspOrigin("cdn.example.com; script-src *")).toBeNull();
		expect(sanitizeCspOrigin("cdn.example.com evil.com")).toBeNull(); // space
		expect(sanitizeCspOrigin("cdn.example.com'")).toBeNull();
		expect(sanitizeCspOrigin('cdn.example.com"')).toBeNull();
	});

	it("rejects non-https schemes (http, ws, data, javascript)", () => {
		expect(sanitizeCspOrigin("http://cdn.example.com")).toBeNull();
		expect(sanitizeCspOrigin("ws://cdn.example.com")).toBeNull();
		expect(sanitizeCspOrigin("data:text/html,x")).toBeNull();
	});

	it("rejects a wildcard host so an allowlist entry cannot broaden to a subtree", () => {
		expect(sanitizeCspOrigin("*.example.com")).toBeNull();
		expect(sanitizeCspOrigin("https://*.example.com")).toBeNull();
	});

	it("rejects a bare single-label host (internal name / bare TLD)", () => {
		expect(sanitizeCspOrigin("localhost")).toBeNull();
		expect(sanitizeCspOrigin("https://localhost")).toBeNull();
		expect(sanitizeCspOrigin("com")).toBeNull();
	});

	it("rejects non-string / empty input", () => {
		expect(sanitizeCspOrigin("")).toBeNull();
		expect(sanitizeCspOrigin("   ")).toBeNull();
		expect(sanitizeCspOrigin(undefined as unknown as string)).toBeNull();
	});
});

// ── sanitizeProxyOrigin: the Core proxy-origin sanitizer (loopback-tolerant) ─────

describe("sanitizeProxyOrigin (Core /api/widgets/asset proxy origin)", () => {
	it("accepts loopback http (which sanitizeCspOrigin rejects) — the DELIBERATE divergence", () => {
		// This is the security seam: the proxy origin is the host-controlled Core node
		// URL (loopback http), so it MUST be accepted here even though a widget-declared
		// resource_domain of the same shape is rejected by sanitizeCspOrigin.
		expect(sanitizeProxyOrigin("http://127.0.0.1:7980")).toBe("http://127.0.0.1:7980");
		expect(sanitizeCspOrigin("http://127.0.0.1:7980")).toBeNull(); // pinned both ways
	});

	it("accepts https too and normalizes to bare scheme://host[:port]", () => {
		expect(sanitizeProxyOrigin("https://node.example.com/api")).toBe("https://node.example.com");
	});

	it("rejects CSP-delimiter chars so the node URL cannot inject a directive", () => {
		expect(sanitizeProxyOrigin("http://127.0.0.1:7980; script-src *")).toBeNull();
		expect(sanitizeProxyOrigin("http://127.0.0.1:7980 x")).toBeNull();
		expect(sanitizeProxyOrigin("http://127.0.0.1'")).toBeNull();
	});

	it("rejects non-http(s) schemes and unparseable input", () => {
		expect(sanitizeProxyOrigin("ftp://127.0.0.1")).toBeNull();
		expect(sanitizeProxyOrigin("data:text/html,x")).toBeNull();
		expect(sanitizeProxyOrigin("not a url")).toBeNull();
		// A delimiter-free but unparseable value reaches the URL parse and is caught.
		expect(sanitizeProxyOrigin(":::")).toBeNull();
		expect(sanitizeProxyOrigin(undefined as unknown as string)).toBeNull();
	});
});

// ── buildThemeTokenStyle: token-name + token-value injection guards ──────────────

describe("buildThemeTokenStyle (theme-token → :root style bridge)", () => {
	it("returns empty string when no tokens are supplied", () => {
		expect(buildThemeTokenStyle()).toBe("");
		expect(buildThemeTokenStyle({})).toBe("");
	});

	it("emits only well-formed --kebab tokens inside html:root{…}", () => {
		const style = buildThemeTokenStyle({
			"--color-bg": "#18181b",
			"--radius": "0.625rem",
		});
		expect(style).toBe("<style>html:root{--color-bg: #18181b;--radius: 0.625rem;}</style>");
	});

	it("drops a token whose NAME is not exactly --<kebab> (no stray selector injection)", () => {
		const style = buildThemeTokenStyle({
			"color-bg": "#000", // missing leading --
			"--Color-BG": "#000", // uppercase → fails the [a-z0-9-] regex
			"--evil{}": "#000", // structural chars in name
			"--ok": "#111",
		});
		expect(style).toBe("<style>html:root{--ok: #111;}</style>");
	});

	it("drops a token whose VALUE contains a CSS-structural char ({ } ; < >)", () => {
		expect(
			buildThemeTokenStyle({ "--x": "red; } body{display:none" })
		).toBe(""); // only unsafe token → nothing emitted, no <style> at all
		expect(buildThemeTokenStyle({ "--x": "</style><script>" })).toBe("");
		expect(buildThemeTokenStyle({ "--x": "a{b}" })).toBe("");
	});

	it("drops a non-string or empty value", () => {
		expect(
			buildThemeTokenStyle({ "--x": 5 as unknown as string, "--y": "" })
		).toBe("");
	});

	it("trims a value's surrounding whitespace", () => {
		expect(buildThemeTokenStyle({ "--x": "  #fff  " })).toBe(
			"<style>html:root{--x: #fff;}</style>"
		);
	});
});
