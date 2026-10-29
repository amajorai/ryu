import { describe, expect, test } from "bun:test";
import { safeHttpUrl, safeNavigationUrl } from "./safe-url.ts";

describe("safeHttpUrl", () => {
	test("normalizes web URLs", () => {
		expect(safeHttpUrl(" HTTPS://Example.com/path ")).toBe(
			"https://example.com/path"
		);
	});

	test("rejects non-web schemes and malformed values", () => {
		expect(safeHttpUrl("javascript:alert(1)")).toBeNull();
		expect(safeHttpUrl("data:text/html,<script>x</script>")).toBeNull();
		expect(safeHttpUrl("//attacker.example/path")).toBeNull();
		expect(safeHttpUrl("not a URL")).toBeNull();
	});
});

describe("safeNavigationUrl", () => {
	test("allows local paths and fragments", () => {
		expect(safeNavigationUrl("/settings/profile")).toBe("/settings/profile");
		expect(safeNavigationUrl("#section-1")).toBe("#section-1");
	});

	test("rejects protocol-relative and script-like destinations", () => {
		expect(safeNavigationUrl("//attacker.example/path")).toBeNull();
		expect(safeNavigationUrl("javascript:alert(1)")).toBeNull();
		expect(safeNavigationUrl("/safe\\\\..\\\\evil")).toBeNull();
	});
});

test("raw navigation boundaries reject non-string inputs without coercion", () => {
	for (const value of [
		null,
		undefined,
		0,
		false,
		{},
		[],
		new URL("https://example.com"),
	]) {
		expect(safeHttpUrl(value)).toBeNull();
		expect(safeNavigationUrl(value)).toBeNull();
	}
});
