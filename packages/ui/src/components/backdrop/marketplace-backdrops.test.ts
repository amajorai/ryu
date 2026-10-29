import { describe, expect, test } from "bun:test";
import {
	BUNDLED_MARKETPLACE_BACKGROUNDS,
	getBundledMarketplaceBackdrops,
	resolveMarketplaceWallpaperSelection,
	toMarketplaceWallpaperSelection,
} from "./marketplace-backdrops.ts";

describe("shared Marketplace wallpapers", () => {
	test("publishes every bundled PatternCraft and Remocn background", () => {
		const wallpapers = getBundledMarketplaceBackdrops();
		expect(wallpapers).toHaveLength(260);
		expect(
			wallpapers.filter((wallpaper) => wallpaper.attribution === "PatternCraft")
		).toHaveLength(258);
		expect(
			wallpapers.filter((wallpaper) => wallpaper.attribution === "Remocn")
		).toHaveLength(2);
		expect(
			BUNDLED_MARKETPLACE_BACKGROUNDS.map((wallpaper) => wallpaper.label)
		).toContain("Mesh Gradient");
		expect(
			BUNDLED_MARKETPLACE_BACKGROUNDS.map((wallpaper) => wallpaper.label)
		).toContain("Dynamic Grid");
		expect(
			BUNDLED_MARKETPLACE_BACKGROUNDS.find(
				(wallpaper) => wallpaper.label === "Mesh Gradient"
			)?.attributionUrl
		).toBe("https://remocn.dev/docs/shaders/getting-started/introduction");
	});

	test("round-trips both shader and PatternCraft CSS selections through host adapters", () => {
		for (const wallpaper of getBundledMarketplaceBackdrops().filter((item) =>
			["Mesh Gradient", "Beach"].includes(item.label)
		)) {
			const resolved = resolveMarketplaceWallpaperSelection(
				toMarketplaceWallpaperSelection(wallpaper)
			);
			expect(resolved?.id).toBe(wallpaper.id);
			expect(resolved?.render).toEqual(wallpaper.render);
		}
	});

	test("rejects unknown ids and renderer mismatches", () => {
		expect(
			resolveMarketplaceWallpaperSelection({
				backdropId: "shader-mesh-gradient",
				id: "../../unsafe",
				params: {},
			})
		).toBeUndefined();
		expect(
			resolveMarketplaceWallpaperSelection({
				backdropId: "unknown-renderer",
				id: "com.ryu.patterncraft:beach",
				params: {},
			})
		).toBeUndefined();
	});
});
