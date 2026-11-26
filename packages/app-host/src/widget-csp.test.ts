// The widget CSP and the Core asset-proxy origin validator.

import { describe, expect, it } from "bun:test";
import {
	buildWidgetCsp,
	sanitizeProxyOrigin,
	WIDGET_SCRIPT_ELEMENT_CSP,
} from "./widget-csp.ts";

// The sha256 hash sources of the texts "" and "abc" (published vectors).
const HASH_EMPTY = "'sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU='";
const HASH_ABC = "'sha256-ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0='";

function scriptSrc(csp: string): string {
	return csp.split("; ").find((d) => d.startsWith("script-src ")) ?? "";
}

describe("buildWidgetCsp", () => {
	it("pins hash-only scripts and a data:-only passive lock by default", () => {
		const csp = buildWidgetCsp([HASH_ABC, HASH_EMPTY]);
		expect(scriptSrc(csp)).toBe(`script-src ${HASH_ABC} ${HASH_EMPTY}`);
		expect(csp).not.toContain("nonce-");
		expect(csp).toContain("img-src data:;");
		expect(csp).toContain("connect-src 'none'");
	});

	it("admits no script at all when no hash is listed", () => {
		expect(scriptSrc(buildWidgetCsp([]))).toBe("script-src 'none'");
	});

	it("drops every value that is not one sha256 source expression", () => {
		const csp = buildWidgetCsp([
			"'nonce-abc'",
			"'unsafe-inline'",
			"https://x.test",
			"file:",
			"*",
			`${HASH_ABC}; script-src *`,
			`${HASH_ABC} https:`,
			"'sha256-short='",
			HASH_ABC,
		]);
		expect(scriptSrc(csp)).toBe(`script-src ${HASH_ABC}`);
		expect(csp).toBe(buildWidgetCsp([HASH_ABC]));
		expect(scriptSrc(buildWidgetCsp(["'nonce-abc'", "*"]))).toBe(
			"script-src 'none'"
		);
	});

	it("widens passive assets to exactly the sanitized proxy origin", () => {
		const csp = buildWidgetCsp([HASH_ABC], "http://127.0.0.1:7980/api");
		expect(csp).toContain("img-src data: http://127.0.0.1:7980;");
		expect(csp).toContain("font-src data: http://127.0.0.1:7980;");
		expect(csp).toContain("connect-src 'none'");
		expect(scriptSrc(csp)).toBe(`script-src ${HASH_ABC}`);
	});
});

describe("WIDGET_SCRIPT_ELEMENT_CSP", () => {
	it("is one directive that admits inline script elements and names no address, hash or nonce", () => {
		expect(WIDGET_SCRIPT_ELEMENT_CSP).toBe("script-src-elem 'unsafe-inline'");
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
