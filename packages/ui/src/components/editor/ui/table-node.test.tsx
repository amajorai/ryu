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
	test("the kit's import path still exports every table element", async () => {
		const tableNode = await import("./table-node.tsx");

		expect(tableNode.TableElement).toBeDefined();
		expect(typeof tableNode.TableRowElement).toBe("function");
		expect(typeof tableNode.TableCellElement).toBe("function");
		expect(typeof tableNode.TableCellHeaderElement).toBe("function");
	});

	test("keyboard resizing steps along the handle's axis", async () => {
		const { getKeyboardResizeDelta } = await import(
			"./table-node-resize-context.ts"
		);

		expect(getKeyboardResizeDelta(key("ArrowRight"), "right")).toBe(8);
		expect(getKeyboardResizeDelta(key("ArrowLeft", true), "left")).toBe(-40);
		expect(getKeyboardResizeDelta(key("ArrowDown"), "bottom")).toBe(8);
		expect(getKeyboardResizeDelta(key("ArrowUp"), "right")).toBeNull();
	});

	test("insert column before/after arrows mirror in RTL", async () => {
		const source = await Bun.file(
			new URL("./table-node-toolbar.tsx", import.meta.url)
		).text();
		const directionalArrows = source.match(
			/<Arrow(?:Left|Right)\s+className=\{DIRECTIONAL_ICON_CLASS\}/g
		);

		expect(directionalArrows).toHaveLength(2);
	});
});
