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
	it("defaults to translucent for null/empty/malformed input", () => {
		expect(DEFAULT_APPEARANCE).toEqual({ background: "translucent" });
		expect(parseAppearance(null)).toEqual({ background: "translucent" });
		expect(parseAppearance("")).toEqual({ background: "translucent" });
		expect(parseAppearance("{bad")).toEqual({ background: "translucent" });
	});

	it("reads acrylic and mica", () => {
		expect(parseAppearance(JSON.stringify({ background: "acrylic" }))).toEqual({
			background: "acrylic",
		});
		expect(parseAppearance(JSON.stringify({ background: "mica" }))).toEqual({
			background: "mica",
		});
	});

	it("coerces an unknown background to translucent", () => {
		expect(parseAppearance(JSON.stringify({ background: "hologram" }))).toEqual(
			{ background: "translucent" }
		);
		expect(parseAppearance(JSON.stringify({}))).toEqual({
			background: "translucent",
		});
	});
});
