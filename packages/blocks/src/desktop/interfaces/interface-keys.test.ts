import { describe, expect, test } from "bun:test";
import { isAskKey } from "./interface-keys.ts";

const world = new EventTarget();
const press = (key: string, extra: Record<string, boolean> = {}) => ({
	altKey: false,
	ctrlKey: false,
	currentTarget: world,
	key,
	metaKey: false,
	target: world,
	...extra,
});

describe("isAskKey", () => {
	test("E, Enter and Space answer an asker, whatever the case", () => {
		for (const key of ["e", "E", "Enter", " "]) {
			expect(isAskKey(press(key))).toBe(true);
		}
		expect(isAskKey(press("w"))).toBe(false);
	});

	test("a held Ctrl, Cmd or Alt leaves the key to its shortcut", () => {
		expect(isAskKey(press("e", { ctrlKey: true }))).toBe(false);
		expect(isAskKey(press("e", { metaKey: true }))).toBe(false);
		expect(isAskKey(press("e", { altKey: true }))).toBe(false);
	});
});
