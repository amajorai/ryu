import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { KeyboardEvent } from "react";

beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());

function key(name: string, shiftKey = false) {
	// SAFETY: getKeyboardResizeDelta reads only `key` and `shiftKey`.
	return { key: name, shiftKey } as KeyboardEvent<HTMLDivElement>;
}

describe("table node modules", () => {
	test("keyboard resizing steps along the handle's axis", async () => {
		const { getKeyboardResizeDelta } = await import(
			"./table-node-resize-context.ts"
		);

		expect(getKeyboardResizeDelta(key("ArrowRight"), "right")).toBe(8);
		expect(getKeyboardResizeDelta(key("ArrowLeft", true), "left")).toBe(-40);
		expect(getKeyboardResizeDelta(key("ArrowDown"), "bottom")).toBe(8);
		expect(getKeyboardResizeDelta(key("ArrowUp"), "right")).toBeNull();
	});
});
