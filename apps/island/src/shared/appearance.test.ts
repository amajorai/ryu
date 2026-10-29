import { describe, expect, it } from "bun:test";
import {
	DEFAULT_APPEARANCE,
	isMaterialAppearance,
	parseAppearance,
} from "./appearance.ts";

describe("isMaterialAppearance", () => {
	it("is true for the native-material backgrounds only", () => {
		expect(isMaterialAppearance("acrylic")).toBe(true);
		expect(isMaterialAppearance("mica")).toBe(true);
		expect(isMaterialAppearance("translucent")).toBe(false);
	});
});

describe("parseAppearance", () => {
	it("defaults to acrylic for null/empty/malformed input", () => {
		expect(DEFAULT_APPEARANCE).toEqual({ background: "acrylic" });
		expect(parseAppearance(null)).toEqual({ background: "acrylic" });
		expect(parseAppearance("")).toEqual({ background: "acrylic" });
		expect(parseAppearance("{bad")).toEqual({ background: "acrylic" });
	});

	it("reads every background the desktop writes: translucent, acrylic and mica", () => {
		// The exact strings Desktop Settings → Island → Background stores.
		expect(
			parseAppearance(JSON.stringify({ background: "translucent" }))
		).toEqual({ background: "translucent" });
		expect(parseAppearance(JSON.stringify({ background: "acrylic" }))).toEqual({
			background: "acrylic",
		});
		expect(parseAppearance(JSON.stringify({ background: "mica" }))).toEqual({
			background: "mica",
		});
	});

	it("coerces an unknown or malformed background to acrylic", () => {
		expect(parseAppearance(JSON.stringify({ background: "hologram" }))).toEqual(
			{ background: "acrylic" }
		);
		expect(
			parseAppearance(JSON.stringify({ background: "Translucent" }))
		).toEqual({ background: "acrylic" });
		expect(parseAppearance(JSON.stringify({ background: 1 }))).toEqual({
			background: "acrylic",
		});
		expect(parseAppearance(JSON.stringify({}))).toEqual({
			background: "acrylic",
		});
		expect(parseAppearance(JSON.stringify("translucent"))).toEqual({
			background: "acrylic",
		});
		expect(parseAppearance("null")).toEqual({ background: "acrylic" });
	});
});
