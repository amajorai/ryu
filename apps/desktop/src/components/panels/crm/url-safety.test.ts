import { describe, expect, it } from "bun:test";
import {
	safeHref,
	safeMailtoHref,
} from "@/src/components/panels/crm/url-safety.ts";

// Control characters are built rather than written literally, so the vectors
// survive a copy/paste or a formatter run that would otherwise eat them.
const TAB = String.fromCharCode(9);
const NUL = String.fromCharCode(0);
const NEWLINE = String.fromCharCode(10);

describe("safeHref", () => {
	it("rejects every spelling of a script-executing scheme", () => {
		// The whole reason this is an allowlist: each of these is a real bypass of
		// a naive `startsWith("javascript:")` check, and the URL parser normalizes
		// them all back to the same protocol.
		for (const vector of [
			"javascript:alert(1)",
			"JaVaScript:alert(1)",
			"JAVASCRIPT:alert(1)",
			" javascript:alert(1)",
			"javascript:alert(1) ",
			`java${TAB}script:alert(1)`,
			`java${NEWLINE}script:alert(1)`,
			`${NUL}javascript:alert(1)`,
			"vbscript:msgbox(1)",
		]) {
			expect(safeHref(vector)).toBeNull();
		}
	});

	it("rejects schemes that carry content or reach the filesystem", () => {
		expect(safeHref("data:text/html,<script>alert(1)</script>")).toBeNull();
		expect(safeHref("file:///etc/passwd")).toBeNull();
		expect(safeHref("blob:https://example.com/abc")).toBeNull();
	});

	it("rejects nothing-at-all rather than producing an empty href", () => {
		expect(safeHref("")).toBeNull();
		expect(safeHref("   ")).toBeNull();
	});

	it("passes ordinary links through unchanged", () => {
		expect(safeHref("https://acme.com/pricing")).toBe(
			"https://acme.com/pricing"
		);
		expect(safeHref("http://acme.com")).toBe("http://acme.com");
		expect(safeHref("mailto:dana@acme.com")).toBe("mailto:dana@acme.com");
		expect(safeHref("tel:+15551234567")).toBe("tel:+15551234567");
	});

	it("upgrades a bare domain, which is what people actually type", () => {
		// Without this, `href="acme.com/pricing"` is a RELATIVE link against the
		// app's own origin and silently goes nowhere.
		expect(safeHref("acme.com/pricing")).toBe("https://acme.com/pricing");
		expect(safeHref("  acme.com  ")).toBe("https://acme.com");
	});

	it("never upgrades its way into an accepted scheme", () => {
		// The `https://` prefix is applied ONLY when the value did not parse as
		// absolute, so a rejected scheme can never be laundered into an accepted
		// one by the fallback path.
		expect(safeHref("javascript:alert(1)")).toBeNull();
		expect(safeHref("data:text/html,x")).toBeNull();
	});
});

describe("safeMailtoHref", () => {
	it("accepts a plain address", () => {
		expect(safeMailtoHref("sales+ryu@example.com")).toBe(
			"mailto:sales+ryu@example.com"
		);
	});

	it("rejects header injection and non-address content", () => {
		expect(
			safeMailtoHref("sales@example.com?bcc=attacker@example.com")
		).toBeNull();
		expect(
			safeMailtoHref("sales@example.com\r\nBcc:attacker@example.com")
		).toBeNull();
		expect(safeMailtoHref("javascript:alert(1)")).toBeNull();
	});
});
