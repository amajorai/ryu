// Theme CSS for sandboxed Companion documents: the scale/font layout rule and the
// sanitized theme-token style bridge with its legacy aliases.

import { describe, expect, it } from "bun:test";
import {
	buildCompanionThemeLayoutCss,
	buildThemeTokenStyle,
	COMPANION_THEME_ALIASES,
} from "./companion-theme-style.ts";

describe("buildCompanionThemeLayoutCss", () => {
	it("applies the host scale only when the parent does not", () => {
		expect(buildCompanionThemeLayoutCss(false)).toStartWith(
			"html body{zoom:var(--ryu-ui-scale, 1) !important;}"
		);
		expect(buildCompanionThemeLayoutCss(true)).toStartWith(
			"html body{zoom:1 !important;}"
		);
	});
});

describe("COMPANION_THEME_ALIASES", () => {
	it("maps every alias to a canonical custom property", () => {
		for (const [alias, source] of Object.entries(COMPANION_THEME_ALIASES)) {
			expect(alias).toMatch(/^--[a-z0-9-]+$/);
			expect(source).toMatch(/^--[a-z0-9-]+$/);
		}
	});
});

describe("buildThemeTokenStyle", () => {
	it("emits safe tokens plus derived aliases the input did not set", () => {
		const style = buildThemeTokenStyle({
			"--background": " #000 ",
			"--bg": "explicit",
			"--foreground": "#fff",
			"--broken": "red; } body {",
			NotAToken: "1px",
		});
		expect(style).toStartWith("<style>html:root{");
		expect(style).toContain("--background: #000;");
		expect(style).toContain("--bg: explicit;");
		expect(style).not.toContain("--bg: #000;");
		expect(style).toContain("--fg: #fff;");
		expect(style).not.toContain("--broken");
		expect(style).not.toContain("NotAToken");
	});

	it("returns an empty string when nothing is safe to inject", () => {
		expect(buildThemeTokenStyle()).toBe("");
		expect(buildThemeTokenStyle({ "--x": "a<b" })).toBe("");
	});
});
