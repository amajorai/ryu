import { describe, expect, it } from "bun:test";
import { groupAvatarPositions } from "./sidebar-group-avatar.ts";

const OVERFLOW_CELL = "right-0 bottom-0";

describe("groupAvatarPositions", () => {
	it("centres a lone member when nobody is hidden", () => {
		expect(groupAvatarPositions(1, 0)).toEqual([
			"left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2",
		]);
	});

	it("places two members side by side when nobody is hidden", () => {
		expect(groupAvatarPositions(2, 0)).toEqual([
			"left-0 top-1/2 -translate-y-1/2",
			"right-0 top-1/2 -translate-y-1/2",
		]);
	});

	it("uses corners when one of five members resolved so +N does not overlap", () => {
		const positions = groupAvatarPositions(1, 4);
		expect(positions[0]).toBe("left-0 top-0");
		expect(positions.slice(0, 1)).not.toContain(OVERFLOW_CELL);
	});

	it("uses corners when two members are shown beside an overflow cell", () => {
		const positions = groupAvatarPositions(2, 1);
		expect(positions.slice(0, 2)).toEqual(["left-0 top-0", "right-0 top-0"]);
	});

	it("keeps the bottom-right corner free for +N with three shown", () => {
		const positions = groupAvatarPositions(3, 2);
		expect(positions.slice(0, 3)).toEqual([
			"left-0 top-0",
			"right-0 top-0",
			"bottom-0 left-0",
		]);
	});
});
