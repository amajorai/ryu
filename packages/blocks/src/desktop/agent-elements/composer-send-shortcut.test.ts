import { expect, test } from "bun:test";
import {
	isImeComposingKeyEvent,
	resolveComposerKeyAction,
} from "./composer-send-shortcut.ts";

function enter(
	overrides: Partial<{
		key: string;
		shiftKey: boolean;
		metaKey: boolean;
		ctrlKey: boolean;
	}> = {}
) {
	return {
		key: "Enter",
		shiftKey: false,
		metaKey: false,
		ctrlKey: false,
		...overrides,
	};
}

test("resolves enter mode shortcuts", () => {
	expect(resolveComposerKeyAction("enter", enter())).toEqual({ kind: "send" });
	expect(resolveComposerKeyAction("enter", enter({ shiftKey: true }))).toEqual({
		kind: "newline",
	});
	expect(resolveComposerKeyAction("enter", enter({ ctrlKey: true }))).toEqual({
		kind: "send",
		followUpMode: "opposite",
	});
	expect(resolveComposerKeyAction("enter", { ...enter(), key: "Tab" })).toEqual(
		{
			kind: "ignore",
		}
	);
});

test("resolves shift-enter mode shortcuts", () => {
	expect(resolveComposerKeyAction("shift-enter", enter())).toEqual({
		kind: "newline",
	});
	expect(
		resolveComposerKeyAction("shift-enter", enter({ shiftKey: true }))
	).toEqual({
		kind: "send",
	});
	expect(
		resolveComposerKeyAction("shift-enter", enter({ metaKey: true }))
	).toEqual({
		kind: "send",
		followUpMode: "opposite",
	});
});

test("resolves command-enter mode shortcuts", () => {
	expect(resolveComposerKeyAction("command-enter", enter())).toEqual({
		kind: "newline",
	});
	expect(
		resolveComposerKeyAction("command-enter", enter({ ctrlKey: true }))
	).toEqual({
		kind: "send",
	});
	expect(
		resolveComposerKeyAction("command-enter", enter({ metaKey: true }))
	).toEqual({
		kind: "send",
	});
	expect(
		resolveComposerKeyAction(
			"command-enter",
			enter({ shiftKey: true, metaKey: true })
		)
	).toEqual({
		kind: "newline",
	});
	expect(
		resolveComposerKeyAction("command-enter", enter({ ctrlKey: true }))
	).toEqual({
		kind: "send",
	});
});

test("treats IME composition keydowns as composing", () => {
	expect(isImeComposingKeyEvent({ isComposing: true, keyCode: 13 })).toBe(true);
	// WebKit reports the commit Enter with keyCode 229 and isComposing false.
	expect(isImeComposingKeyEvent({ isComposing: false, keyCode: 229 })).toBe(
		true
	);
	expect(isImeComposingKeyEvent({ isComposing: false, keyCode: 13 })).toBe(
		false
	);
});
