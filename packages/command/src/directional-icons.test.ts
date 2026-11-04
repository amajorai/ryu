import { describe, expect, test } from "bun:test";
import {
	ArrowLeftRightIcon,
	ArrowRight01Icon,
	ArrowTurnBackwardIcon,
	ArrowTurnForwardIcon,
	ArrowUpRight01Icon,
	ChevronLeftIcon,
	MailReply01Icon,
	MailReplyAll01Icon,
	Redo02Icon,
	ReplyIcon,
	Search01Icon,
	Undo02Icon,
} from "@hugeicons/core-free-icons";
import { isDirectionalIcon } from "./directional-icons.ts";

describe("isDirectionalIcon", () => {
	test("matches horizontal arrows and chevrons", () => {
		expect(isDirectionalIcon(ArrowRight01Icon)).toBe(true);
		expect(isDirectionalIcon(ChevronLeftIcon)).toBe(true);
	});

	test("matches reply, undo/redo and turn glyphs", () => {
		for (const icon of [
			MailReply01Icon,
			MailReplyAll01Icon,
			ReplyIcon,
			Undo02Icon,
			Redo02Icon,
			ArrowTurnBackwardIcon,
			ArrowTurnForwardIcon,
		]) {
			expect(isDirectionalIcon(icon)).toBe(true);
		}
	});

	test("leaves symmetric, diagonal and non-arrow glyphs alone", () => {
		expect(isDirectionalIcon(ArrowLeftRightIcon)).toBe(false);
		expect(isDirectionalIcon(ArrowUpRight01Icon)).toBe(false);
		expect(isDirectionalIcon(Search01Icon)).toBe(false);
	});
});
