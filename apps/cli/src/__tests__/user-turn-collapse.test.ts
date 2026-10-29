import { expect, test } from "bun:test";
import {
	collapseUserTurnText,
	USER_TURN_COLLAPSED_LINES,
} from "../core/transcriptPresentation.ts";

test("collapseUserTurnText keeps short prompts whole and hides lines past the limit", () => {
	expect(collapseUserTurnText("one\ntwo")).toEqual({
		hiddenLines: 0,
		text: "one\ntwo",
	});
	const six = Array.from(
		{ length: USER_TURN_COLLAPSED_LINES },
		(_, index) => `line ${index + 1}`
	).join("\n");
	expect(collapseUserTurnText(six).hiddenLines).toBe(0);
	const ten = Array.from({ length: 10 }, (_, index) => `line ${index + 1}`);
	expect(collapseUserTurnText(ten.join("\n"))).toEqual({
		hiddenLines: 4,
		text: ten.slice(0, 6).join("\n"),
	});
	expect(collapseUserTurnText("a\nb\nc", 2)).toEqual({
		hiddenLines: 1,
		text: "a\nb",
	});
});
