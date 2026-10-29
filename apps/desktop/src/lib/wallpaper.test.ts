import { describe, expect, test } from "bun:test";
import {
	ALL_WALLPAPER_SETS,
	clearUnavailableBackdrop,
	DEFAULT_WALLPAPER_PREFERENCE,
	OS_WALLPAPERS,
	parseWallpaperPreference,
	randomWallpaper,
	resolveWallpaper,
	wallpaperFullSizeUrl,
	wallpapersInSet,
	wallpaperThumbnailUrl,
} from "./wallpaper.ts";

const [first, second] = OS_WALLPAPERS;

describe("parseWallpaperPreference", () => {
	test("falls back to random for missing or malformed values", () => {
		expect(parseWallpaperPreference(null)).toEqual(
			DEFAULT_WALLPAPER_PREFERENCE
		);
		expect(parseWallpaperPreference("{not json")).toEqual(
			DEFAULT_WALLPAPER_PREFERENCE
		);
		expect(parseWallpaperPreference("42")).toEqual(
			DEFAULT_WALLPAPER_PREFERENCE
		);
	});

	test("keeps a known preset and drops an unknown one", () => {
		const known = parseWallpaperPreference(
			JSON.stringify({ mode: "preset", presetId: "golden-gate-day" })
		);
		expect(known.mode).toBe("preset");
		expect(known.presetId).toBe("golden-gate-day");

		const unknown = parseWallpaperPreference(
			JSON.stringify({ mode: "preset", presetId: "gone" })
		);
		expect(unknown.mode).toBe("random");
	});

	test("requires an image url for image mode and resets unknown sets", () => {
		expect(
			parseWallpaperPreference(JSON.stringify({ mode: "image", image: {} }))
				.mode
		).toBe("random");
		const parsed = parseWallpaperPreference(
			JSON.stringify({
				image: { url: "https://example.com/a.jpg" },
				mode: "image",
				set: "Nope",
			})
		);
		expect(parsed.mode).toBe("image");
		expect(parsed.image?.label).toBe("Your wallpaper");
		expect(parsed.set).toBe(ALL_WALLPAPER_SETS);
	});
});

describe("resolveWallpaper", () => {
	test("random mode uses the session pick", () => {
		expect(resolveWallpaper(DEFAULT_WALLPAPER_PREFERENCE, second)).toBe(second);
	});

	test("preset and image modes override the session pick", () => {
		expect(
			resolveWallpaper(
				{ ...DEFAULT_WALLPAPER_PREFERENCE, mode: "preset", presetId: first.id },
				second
			)
		).toBe(first);
		const custom = resolveWallpaper(
			{
				...DEFAULT_WALLPAPER_PREFERENCE,
				image: {
					attribution: "Ada · Unsplash",
					label: "Bridge",
					sourceUrl: null,
					url: "https://images.unsplash.com/photo-x",
				},
				mode: "image",
			},
			second
		);
		expect(custom.id).toBe("custom");
		expect(custom.attribution).toBe("Ada · Unsplash");
	});
});

describe("gallery helpers", () => {
	test("includes the Golden Gate set", () => {
		expect(wallpapersInSet("Golden Gate").length).toBeGreaterThan(0);
		expect(wallpapersInSet("missing")).toBe(OS_WALLPAPERS);
	});

	test("randomWallpaper avoids the current wallpaper", () => {
		const pick = randomWallpaper([first, second], first.id, () => 0);
		expect(pick).toBe(second);
	});

	test("rewrites only Unsplash urls for thumbnails and full size", () => {
		expect(wallpaperThumbnailUrl(first.url)).toContain("w=480");
		expect(
			wallpaperFullSizeUrl("https://images.unsplash.com/photo-x?w=1080")
		).toContain("w=2400");
		expect(wallpaperThumbnailUrl("https://example.com/a.jpg")).toBe(
			"https://example.com/a.jpg"
		);
		expect(wallpaperThumbnailUrl("data:image/jpeg;base64,xx")).toBe(
			"data:image/jpeg;base64,xx"
		);
	});
});

describe("backdrop wallpapers", () => {
	test("keeps a known backdrop and re-validates its params", () => {
		const parsed = parseWallpaperPreference(
			JSON.stringify({
				backdrop: { id: "warp-starfield", params: { count: 99_999, evil: 1 } },
				mode: "backdrop",
			})
		);
		expect(parsed.mode).toBe("backdrop");
		expect(parsed.backdrop?.params.count).toBe(1500);
		expect(parsed.backdrop?.params.evil).toBeUndefined();
		const wallpaper = resolveWallpaper(parsed, second);
		expect(wallpaper.backdrop?.id).toBe("warp-starfield");
	});

	test("drops an unknown backdrop back to random", () => {
		const parsed = parseWallpaperPreference(
			JSON.stringify({ backdrop: { id: "gone" }, mode: "backdrop" })
		);
		expect(parsed.mode).toBe("random");
		expect(parsed.backdrop).toBeNull();
	});

	test("resolves marketplace backdrops from the offline cache and falls back when absent", () => {
		const contribution = {
			attribution: "PatternCraft",
			attributionUrl: "https://example.com/patterncraft/aurora",
			backdropId: "aurora-flow",
			id: "@example/wallpapers:aurora",
			label: "Aurora",
			params: { speed: 0.7 },
			plugin: "@example/wallpapers",
		};
		const raw = JSON.stringify({
			backdrop: { id: contribution.id, params: { speed: 0.8 } },
			mode: "backdrop",
		});
		const parsed = parseWallpaperPreference(raw, [contribution]);
		const resolved = resolveWallpaper(parsed, second, [contribution]);

		expect(parsed.backdrop?.id).toBe(contribution.id);
		expect(resolved.id).toBe(`backdrop:${contribution.id}`);
		expect(resolved.attribution).toBe("PatternCraft");
		expect(resolved.attributionUrl).toBe(contribution.attributionUrl);

		const unavailable = parseWallpaperPreference(raw, []);
		expect(unavailable.mode).toBe("backdrop");
		expect(resolveWallpaper(unavailable, second, [])).toBe(second);
	});

	test("clears a selected marketplace backdrop after successful removal", () => {
		const selected = {
			...DEFAULT_WALLPAPER_PREFERENCE,
			backdrop: { id: "@example/wallpapers:aurora", params: {} },
			mode: "backdrop" as const,
		};
		const contribution = {
			attribution: "PatternCraft",
			attributionUrl: "https://example.com/patterncraft/aurora",
			backdropId: "aurora-flow",
			id: "@example/wallpapers:aurora",
			label: "Aurora",
			params: {},
			plugin: "@example/wallpapers",
		};

		expect(clearUnavailableBackdrop(selected, [contribution])).toBe(selected);
		expect(clearUnavailableBackdrop(selected, [])).toEqual({
			...selected,
			backdrop: null,
			mode: "random",
		});
	});
});
