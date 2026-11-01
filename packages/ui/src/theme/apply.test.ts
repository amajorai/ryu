// DOM tests for applyVariant / clearVariant: the 26 core theme vars keep their
// existing behaviour, and "extra" tokens a variant writes (--chart-1, --radius,
// --font-sans, ...) are undone on the next switch without clobbering values
// the user set before or after the variant was applied.

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { ThemeVariant } from "./presets.ts";

const registeredDom = globalThis.document === undefined;
if (registeredDom) {
	GlobalRegistrator.register();
}
afterAll(async () => {
	if (registeredDom) {
		await GlobalRegistrator.unregister();
	}
});

const { applyRadius, applyVariant, clearVariant } = await import("./apply.ts");

afterEach(() => {
	clearVariant();
	document.documentElement.removeAttribute("style");
});

function variant(id: string, tokens: Record<string, string>): ThemeVariant {
	return {
		id,
		label: id,
		mode: "dark",
		preview: { bg: "#000", surface: "#111", primary: "#f00", text: "#fff" },
		tokens,
	};
}

function inline(key: string): string {
	return document.documentElement.style.getPropertyValue(key);
}

describe("applyVariant core theme vars", () => {
	test("writes core vars, clears ones the next variant omits, skips popover", () => {
		applyVariant(
			variant("a", {
				"--background": "#101010",
				"--ring": "#ff0000",
				"--popover": "#222222",
				"--muted": "#333333",
			})
		);
		expect(inline("--background")).toBe("#101010");
		expect(inline("--ring")).toBe("#ff0000");
		expect(inline("--popover")).toBe("");
		expect(inline("--muted-base")).toBe("#333333");
		expect(inline("--muted")).toBe("var(--muted-base)");

		applyVariant(variant("b", { "--background": "#fafafa" }));
		expect(inline("--background")).toBe("#fafafa");
		expect(inline("--ring")).toBe("");
		expect(inline("--muted-base")).toBe("");
	});

	test("clearVariant removes every core var it wrote", () => {
		applyVariant(
			variant("a", { "--background": "#101010", "--muted": "#333" })
		);
		clearVariant();
		expect(inline("--background")).toBe("");
		expect(inline("--muted-base")).toBe("");
	});
});

describe("applyVariant extra tokens", () => {
	test("an extra key is removed when switching to a variant without it", () => {
		applyVariant(
			variant("interface", { "--background": "#000", "--chart-1": "#abcdef" })
		);
		expect(inline("--chart-1")).toBe("#abcdef");

		applyVariant(variant("user", { "--background": "#fff" }));
		expect(inline("--chart-1")).toBe("");
	});

	test("clearVariant removes extra keys too", () => {
		applyVariant(variant("interface", { "--success": "#00ff00" }));
		clearVariant();
		expect(inline("--success")).toBe("");
	});

	test("the inline value from before the variant is restored", () => {
		applyRadius(0.5);
		applyVariant(variant("interface", { "--radius": "0rem" }));
		expect(inline("--radius")).toBe("0rem");

		applyVariant(variant("user", { "--background": "#fff" }));
		expect(inline("--radius")).toBe("0.5rem");
	});

	test("a change made after the apply is preserved", () => {
		applyVariant(variant("interface", { "--radius": "0rem" }));
		applyRadius(1);

		applyVariant(variant("user", { "--background": "#fff" }));
		expect(inline("--radius")).toBe("1rem");
		clearVariant();
		expect(inline("--radius")).toBe("1rem");
	});

	test("chained variants writing the same key restore the original value", () => {
		document.documentElement.style.setProperty("--font-sans", "Inter");
		applyVariant(variant("one", { "--font-sans": "Pixel" }));
		applyVariant(variant("two", { "--font-sans": "Mono" }));
		expect(inline("--font-sans")).toBe("Mono");

		clearVariant();
		expect(inline("--font-sans")).toBe("Inter");
	});
});
