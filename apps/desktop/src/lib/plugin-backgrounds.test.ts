import { describe, expect, test } from "bun:test";
import { PATTERNCRAFT_WALLPAPERS } from "@ryu/ui/components/backdrop/patterncraft-wallpapers.generated.ts";
import type { PluginBackground } from "./api/plugin-contribution-boundary.ts";
import {
	backdropByAvailableId,
	getMarketplaceBackdrops,
	isPluginBackgroundId,
	loadPluginBackgrounds,
} from "./plugin-backgrounds.ts";

const background: PluginBackground = {
	attribution: "PatternCraft",
	attributionUrl: "https://example.com/patterncraft/aurora",
	backdropId: "aurora-flow",
	description: "Slow northern-lights colours.",
	id: "@example/wallpapers:aurora",
	label: "Aurora",
	params: { colors: ["#22c55e", "#8b5cf6"], speed: 0.7 },
	plugin: "@example/wallpapers",
};

describe("marketplace backdrop resolution", () => {
	test("maps a contribution to a known host renderer and resolves its params", () => {
		const [resolved] = getMarketplaceBackdrops([background]);
		const hostPreset = backdropByAvailableId("aurora-flow");
		if (!(resolved && hostPreset)) {
			throw new Error("Expected the registered Aurora backdrop to resolve.");
		}
		expect(resolved.id).toBe(background.id);
		expect(resolved.render).toEqual(hostPreset.render);
		expect(resolved?.origin).toBe("marketplace");
		expect(resolved?.initialParams.speed).toBe(0.7);
		expect(resolved?.attributionUrl).toBe(background.attributionUrl);
	});

	test("does not resolve renderer ids the host does not know", () => {
		expect(
			getMarketplaceBackdrops([
				{ ...background, backdropId: "plugin-provided-code" },
			])
		).toEqual([]);
	});

	test("ships Remocn backgrounds as functional Marketplace defaults", () => {
		const defaults = getMarketplaceBackdrops(loadPluginBackgrounds());
		const meshGradient = defaults.find(
			(background) =>
				background.id === "com.ryu.marketplace-defaults:mesh-gradient"
		);
		const dynamicGrid = defaults.find(
			(background) =>
				background.id === "com.ryu.marketplace-defaults:dynamic-grid"
		);

		expect(meshGradient?.origin).toBe("marketplace");
		expect(meshGradient?.render).toEqual(
			backdropByAvailableId("shader-mesh-gradient")?.render
		);
		expect(meshGradient?.attribution).toBe("Remocn");
		expect(dynamicGrid?.origin).toBe("marketplace");
		expect(dynamicGrid?.render).toEqual(
			backdropByAvailableId("shader-dot-grid")?.render
		);
		expect(dynamicGrid?.attribution).toBe("Remocn");
	});

	test("ships the complete PatternCraft catalog through the host CSS adapter", () => {
		const defaults = getMarketplaceBackdrops(loadPluginBackgrounds());
		const patternCraft = defaults.filter(
			(background) => background.attribution === "PatternCraft"
		);
		expect(patternCraft).toHaveLength(PATTERNCRAFT_WALLPAPERS.length);
		expect(patternCraft).toHaveLength(258);
		expect(new Set(patternCraft.map((background) => background.id)).size).toBe(
			PATTERNCRAFT_WALLPAPERS.length
		);
		for (const [index, source] of PATTERNCRAFT_WALLPAPERS.entries()) {
			const installed = patternCraft[index];
			expect(installed?.label).toBe(source.label);
			expect(installed?.category).toBeDefined();
			expect(installed?.render).toEqual({ kind: "css", style: source.style });
			expect(installed?.origin).toBe("marketplace");
			expect(installed?.attributionUrl).toBe("https://patterncraft.fun/");
		}
	});

	test("resolves PatternCraft adapter contributions only for bundled pattern ids", () => {
		const contribution: PluginBackground = {
			...background,
			backdropId: "patterncraft-css",
			id: "@example/wallpapers:top-gradient-radial",
			params: { patternId: "top-gradient-radial" },
		};
		const [resolved] = getMarketplaceBackdrops([contribution]);
		expect(resolved?.id).toBe(contribution.id);
		expect(resolved?.render.kind).toBe("css");
		expect(
			getMarketplaceBackdrops([
				{ ...contribution, params: { patternId: "untrusted-css" } },
			])
		).toEqual([]);
	});

	test("recognizes only stable namespaced contribution ids", () => {
		expect(isPluginBackgroundId("@example/wallpapers:aurora")).toBe(true);
		expect(isPluginBackgroundId("@example/other:aurora")).toBe(true);
		expect(isPluginBackgroundId("gone")).toBe(false);
		expect(isPluginBackgroundId("@example/wallpapers:../bad")).toBe(false);
	});
});
