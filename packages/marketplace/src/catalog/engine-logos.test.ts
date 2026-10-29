import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import sources from "./engine-logos/sources.json" with { type: "json" };
import { ENGINE_LOGO_IDS, engineLogoProps } from "./engine-logos.ts";

describe("bundled engine logos", () => {
	test("FreeToken has bare artwork for both app themes", () => {
		const logo = engineLogoProps("freetoken");
		expect(logo.iconAppearance).toBe("bare");
		expect(logo.iconUrlDark).not.toBe(logo.iconUrl);
		if (!logo.iconUrlDark) {
			throw new Error("Missing FreeToken dark artwork");
		}
		expect(readFileSync(new URL(logo.iconUrlDark)).length).toBeGreaterThan(100);
	});

	test("llama-swap provides distinct bundled light and dark artwork", () => {
		const logo = engineLogoProps("llama-swap");
		expect(logo.iconAppearance).toBe("bare");
		expect(logo.iconUrlDark).toBeTruthy();
		expect(logo.iconUrlDark).not.toBe(logo.iconUrl);
		if (!logo.iconUrlDark) {
			throw new Error("Missing dark logo");
		}
		expect(readFileSync(new URL(logo.iconUrlDark)).length).toBeGreaterThan(100);
	});

	test("every logo resolves to its bundled source image", () => {
		for (const id of ENGINE_LOGO_IDS) {
			const props = engineLogoProps(id);
			expect(props.iconUrl).toBeTruthy();
			if (!props.iconUrl) {
				throw new Error(`Missing logo for ${id}`);
			}
			const bytes = readFileSync(new URL(props.iconUrl));
			expect(bytes.length).toBeGreaterThan(100);
			expect(Object.hasOwn(sources, id)).toBe(true);
			expect(props.iconPadding).toBe("sm");
			expect(
				props.iconAppearance === "bare" || props.iconAppearance === "monochrome"
			).toBe(true);
			if (props.iconUrl?.endsWith(".svg")) {
				const svg = bytes.toString();
				expect(svg).toContain("<svg");
				expect(svg).not.toMatch(/<script|<foreignObject|onload=/i);
			}
		}
	});
	test("related engines use family artwork and stable per-engine identities", () => {
		expect(engineLogoProps("mlx-vlm").iconUrl).toBe(
			engineLogoProps("mlx").iconUrl
		);
		expect(engineLogoProps("docker-model-runner").iconUrl).toBe(
			engineLogoProps("docker").iconUrl
		);
		expect(engineLogoProps("apfel").iconUrl).toBe(
			engineLogoProps("apple").iconUrl
		);
		expect(engineLogoProps("mlx-vlm").seedId).toBe("engine:mlx-vlm");
	});
	test("engines without artwork retain the shared fallback", () => {
		for (const id of [
			"audiocpp",
			"outetts",
			"wasmtime",
			"future-engine",
			"constructor",
			"__proto__",
		]) {
			expect(engineLogoProps(id).iconUrl).toBeUndefined();
			expect(engineLogoProps(id).iconAppearance).toBeUndefined();
			expect(engineLogoProps(id).seedId).toBe(`engine:${id}`);
		}
	});
});
