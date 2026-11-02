import { describe, expect, test } from "bun:test";
import { moveSelection } from "./DesktopStartupChooser.parts.tsx";
import { tileDelta } from "./startup-tile-keys.ts";

describe("DesktopStartupChooser arrow keys", () => {
	const tiles = ["work", "personal", "add"];

	test("left-to-right: ArrowRight selects the next tile", () => {
		expect(moveSelection(tiles, "work", tileDelta("ArrowRight"))).toBe(
			"personal"
		);
		expect(tileDelta("ArrowLeft")).toBe(-1);
	});

	test("right-to-left: ArrowLeft selects the next tile", () => {
		expect(moveSelection(tiles, "work", tileDelta("ArrowLeft", "rtl"))).toBe(
			"personal"
		);
		expect(moveSelection(tiles, "work", tileDelta("ArrowRight", "rtl"))).toBe(
			"add"
		);
		expect(tileDelta("Enter", "rtl")).toBe(0);
	});
});
