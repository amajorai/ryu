import { describe, expect, test } from "bun:test";
import { parseInstalledWallpaperIds } from "./wallpaper-library.ts";

describe("installed wallpaper storage", () => {
	test("keeps unique namespaced wallpaper ids from the versioned record", () => {
		const raw = JSON.stringify({
			ids: [
				"com.ryu.patterncraft:top-gradient-radial",
				"@example/wallpapers:aurora",
				"com.ryu.patterncraft:top-gradient-radial",
				"../../unsafe",
			],
			version: 1,
		});
		expect(parseInstalledWallpaperIds(raw)).toEqual([
			"com.ryu.patterncraft:top-gradient-radial",
			"@example/wallpapers:aurora",
		]);
	});

	test("ignores malformed, unversioned, and oversized records", () => {
		expect(parseInstalledWallpaperIds("not-json")).toEqual([]);
		expect(
			parseInstalledWallpaperIds(
				JSON.stringify({ ids: ["com.ryu.patterncraft:aurora"], version: 2 })
			)
		).toEqual([]);
		expect(parseInstalledWallpaperIds("x".repeat(262_145))).toEqual([]);
	});

	test("counts raw slots before filtering and deduplicating the bounded list", () => {
		const id = "com.ryu.patterncraft:aurora";
		const afterLimit = "com.ryu.patterncraft:dusk";
		expect(
			parseInstalledWallpaperIds(
				JSON.stringify({
					ids: [
						null,
						7,
						{},
						...Array.from({ length: 1021 }, () => id),
						afterLimit,
					],
					version: 1,
				})
			)
		).toEqual([id]);
	});

	test("ignores legacy non-string slots and overflow without losing valid ids", () => {
		expect(
			parseInstalledWallpaperIds(
				'{"version":1,"ids":[1e400,null,{"__proto__":{"future":true}},["com.ryu.patterncraft:ignored"],"com.ryu.patterncraft:aurora"]}'
			)
		).toEqual(["com.ryu.patterncraft:aurora"]);
	});
});
