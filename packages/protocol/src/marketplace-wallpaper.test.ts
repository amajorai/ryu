import { describe, expect, test } from "bun:test";
import { parseMarketplaceWallpaperSelection } from "./marketplace-wallpaper.ts";

describe("parseMarketplaceWallpaperSelection", () => {
	test("accepts a bounded portable shader selection", () => {
		expect(
			parseMarketplaceWallpaperSelection({
				backdropId: "shader-mesh-gradient",
				id: "@ryu/wallpapers:mesh-gradient",
				params: { colors: ["#121212", "#ffffff"], speed: 0.4 },
			})
		).toEqual({
			backdropId: "shader-mesh-gradient",
			id: "@ryu/wallpapers:mesh-gradient",
			params: { colors: ["#121212", "#ffffff"], speed: 0.4 },
		});
	});

	test("rejects unsafe ids, object keys, non-JSON values, and oversized data", () => {
		const prototypeKeyPayload: unknown = JSON.parse(
			'{"__proto__":{"polluted":true}}'
		);
		for (const params of [
			prototypeKeyPayload,
			{ constructor: "unsafe" },
			{ speed: Number.NaN },
			{ values: Array.from({ length: 129 }, (_, index) => index) },
			{ value: "x".repeat(16_385) },
		]) {
			expect(
				parseMarketplaceWallpaperSelection({
					backdropId: "shader-mesh-gradient",
					id: "@ryu/wallpapers:mesh-gradient",
					params,
				})
			).toBeUndefined();
		}
		expect(
			parseMarketplaceWallpaperSelection({
				backdropId: "shader-mesh-gradient",
				id: "../../unsafe",
				params: {},
			})
		).toBeUndefined();
	});

	test("projects own entries from legacy objects without inherited parameters", () => {
		const params = Object.assign(new Date(0), { speed: 0.5 });
		Object.setPrototypeOf(params, { inherited: "hidden" });
		expect(
			parseMarketplaceWallpaperSelection({
				backdropId: "shader-mesh-gradient",
				id: "@ryu/wallpapers:mesh-gradient",
				params,
			})?.params
		).toEqual({ speed: 0.5 });
	});

	test("bounds nested containers while retaining primitive leaves at the depth limit", () => {
		const selection = {
			backdropId: "shader-mesh-gradient",
			id: "@ryu/wallpapers:mesh-gradient",
		};
		expect(
			parseMarketplaceWallpaperSelection({
				...selection,
				params: { a: { b: { c: { d: { e: 1 } } } } },
			})?.params
		).toEqual({ a: { b: { c: { d: { e: 1 } } } } });
		expect(
			parseMarketplaceWallpaperSelection({
				...selection,
				params: { a: { b: { c: { d: { e: {} } } } } },
			})
		).toBeUndefined();
	});

	test("retains the independent entry, array, and complete payload size bounds", () => {
		const selection = {
			backdropId: "shader-mesh-gradient",
			id: "@ryu/wallpapers:mesh-gradient",
		};
		const entries = Object.fromEntries(
			Array.from({ length: 64 }, (_, index) => [`key${index}`, index])
		);
		expect(
			parseMarketplaceWallpaperSelection({ ...selection, params: entries })
				?.params
		).toEqual(entries);
		expect(
			parseMarketplaceWallpaperSelection({
				...selection,
				params: { ...entries, extra: 1 },
			})
		).toBeUndefined();
		expect(
			parseMarketplaceWallpaperSelection({
				...selection,
				params: { values: Array.from({ length: 128 }, (_, index) => index) },
			})?.params.values
		).toHaveLength(128);
		expect(
			parseMarketplaceWallpaperSelection({
				...selection,
				params: Object.fromEntries(
					Array.from({ length: 5 }, (_, index) => [
						`key${index}`,
						"x".repeat(4096),
					])
				),
			})
		).toBeUndefined();
	});
});

test("refuses oversized containers before descending into any child", () => {
	const values = new Array(6700);
	Object.defineProperty(values, "0", {
		get() {
			throw new Error("array child visited");
		},
	});
	const fields = Object.fromEntries(
		Array.from({ length: 65 }, (_, i) => [`field${i}`, null])
	);
	Object.defineProperty(fields, "field0", {
		enumerable: true,
		get() {
			throw new Error("object child visited");
		},
	});
	for (const params of [{ a: values }, fields]) {
		expect(
			parseMarketplaceWallpaperSelection({
				id: "@ryu/wallpapers:mesh-gradient",
				backdropId: "shader-mesh-gradient",
				params,
			})
		).toBeUndefined();
	}
});
