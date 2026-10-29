import { describe, expect, test } from "bun:test";
import {
	ACTION_PILL_WIDTH,
	DETAIL_CONTENT_VPAD,
	DETAIL_MAX_H,
	DETAIL_SIZES,
	islandMaterialContours,
	LOGO_CIRCLE,
	pillHeight,
	pillOverflows,
	SPLIT_GAP,
	SUGGESTION_STACK_GAP,
} from "./island-config.ts";

test("native material follows the logo and detail without filling their gap", () => {
	expect(islandMaterialContours(true, null, "collapsed")).toEqual([
		{ x: 0, y: 0, ...LOGO_CIRCLE },
	]);
	expect(islandMaterialContours(true, DETAIL_SIZES.idle, "idle")).toEqual([
		{ x: 0, y: 0, ...LOGO_CIRCLE },
		{ x: LOGO_CIRCLE.width + SPLIT_GAP, y: 0, ...DETAIL_SIZES.idle },
	]);
	expect(
		islandMaterialContours(false, DETAIL_SIZES.expanded, "expanded")
	).toEqual([{ x: 0, y: 0, ...DETAIL_SIZES.expanded }]);
});

test("suggestion actions remain separate native material pills", () => {
	const contours = islandMaterialContours(
		true,
		DETAIL_SIZES.suggestion,
		"suggestion"
	);
	expect(contours).toHaveLength(5);
	expect(contours[2]?.x).toBe(LOGO_CIRCLE.width + SPLIT_GAP);
	expect(contours[2]?.y).toBe(
		DETAIL_SIZES.suggestion.height + SUGGESTION_STACK_GAP
	);
	expect((contours[3]?.x ?? 0) - (contours[2]?.x ?? 0)).toBe(
		ACTION_PILL_WIDTH + SPLIT_GAP
	);
});

describe("pillHeight", () => {
	test("keeps the base height until the content needs more", () => {
		const base = DETAIL_SIZES.context.height;
		expect(pillHeight(base, 0)).toBe(base);
		expect(pillHeight(base, base - DETAIL_CONTENT_VPAD)).toBe(base);
	});

	test("grows past the base once the content outgrows a single row", () => {
		const base = DETAIL_SIZES.context.height;
		// Two wrapped rows of the pill's ~20px text.
		expect(pillHeight(base, 40)).toBe(40 + DETAIL_CONTENT_VPAD);
	});

	test("caps at the max so tall content scrolls instead of growing", () => {
		expect(pillHeight(DETAIL_SIZES.suggestion.height, 1000)).toBe(DETAIL_MAX_H);
	});

	test("holds the base while nothing is mounted (unmeasured)", () => {
		// A state swap unmounts the observed node and reports 0; the shape must not
		// collapse to the padding in the gap before the next surface measures.
		expect(pillHeight(DETAIL_SIZES.suggestion.height, 0)).toBe(
			DETAIL_SIZES.suggestion.height
		);
	});
});

describe("pillOverflows", () => {
	test("is false when unmeasured or when the content fits", () => {
		expect(pillOverflows(0)).toBe(false);
		expect(pillOverflows(DETAIL_MAX_H - DETAIL_CONTENT_VPAD)).toBe(false);
	});

	test("is true only past the cap", () => {
		expect(pillOverflows(DETAIL_MAX_H - DETAIL_CONTENT_VPAD + 1)).toBe(true);
	});
});
