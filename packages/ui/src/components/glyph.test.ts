import { describe, expect, test } from "bun:test";
import { asGlyphValue, DEFAULT_DICEBEAR_STYLE, dicebearUrl } from "./glyph.ts";
import { iconToUrl } from "./icon.tsx";

describe("dicebearUrl", () => {
	test("uses an allowlisted style and encodes the seed as a query value", () => {
		const url = new URL(dicebearUrl("notionists", "a/b?c", { size: 40 }));
		expect(url.hostname).toBe("api.dicebear.com");
		expect(url.pathname.endsWith("/notionists/svg")).toBe(true);
		expect(url.searchParams.get("seed")).toBe("a/b?c");
		expect(url.searchParams.get("size")).toBe("40");
	});

	test("falls back for a style that tries to escape the fixed endpoint", () => {
		const url = new URL(dicebearUrl("../../evil.example/track", "seed"));
		expect(url.hostname).toBe("api.dicebear.com");
		expect(url.pathname.endsWith(`/${DEFAULT_DICEBEAR_STYLE}/svg`)).toBe(true);
	});

	test("caps an untrusted seed before building the image URL", () => {
		const url = new URL(dicebearUrl("notionists", "x".repeat(1000)));
		expect(url.searchParams.get("seed")?.length).toBe(256);
	});
});

describe("iconToUrl", () => {
	test("keeps icon IDs on the fixed Iconify host and path", () => {
		const url = new URL(iconToUrl("lucide:heart") ?? "");
		expect(url.origin).toBe("https://api.iconify.design");
		expect(url.pathname).toBe("/lucide/heart.svg");
	});

	test("rejects path traversal and executable data URLs", () => {
		expect(iconToUrl("../../evil.example/track")).toBeNull();
		expect(iconToUrl("data:text/html,<script>alert(1)</script>")).toBeNull();
		expect(iconToUrl("data:image/svg+xml,<svg></svg>")).toBeNull();
	});
});

describe("asGlyphValue", () => {
	test("drops malformed optional color and dither data at the boundary", () => {
		expect(
			asGlyphValue({
				color: "url(https://attacker.example/track)",
				dither: { direction: "sideways", from: "__proto__", to: "constructor" },
				id: "lucide:heart",
				kind: "icon",
			})
		).toEqual({ id: "lucide:heart", kind: "icon" });
	});

	test("rejects glyph variants with malformed required fields", () => {
		expect(asGlyphValue({ kind: "avatar", dataUrl: null })).toBeUndefined();
		expect(asGlyphValue({ kind: "emoji", emoji: 7 })).toBeUndefined();
		expect(
			asGlyphValue({ kind: "dicebear", style: "x", seed: null })
		).toBeUndefined();
	});
});
