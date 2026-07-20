import { describe, expect, test } from "bun:test";
import { actionSearchValue, groupActions } from "./registry.ts";
import type { CommandAction } from "./types.ts";

function action(
	partial: Partial<CommandAction> & { id: string }
): CommandAction {
	return {
		group: "Group",
		title: partial.id,
		onSelect: () => {
			// no-op for tests
		},
		...partial,
	};
}

describe("groupActions", () => {
	test("preserves first-seen group order and within-group order", () => {
		const groups = groupActions([
			action({ id: "a", group: "Nav" }),
			action({ id: "b", group: "Actions" }),
			action({ id: "c", group: "Nav" }),
		]);
		expect(groups.map((g) => g.heading)).toEqual(["Nav", "Actions"]);
		expect(groups.at(0)?.actions.map((a) => a.id)).toEqual(["a", "c"]);
		expect(groups.at(1)?.actions.map((a) => a.id)).toEqual(["b"]);
	});

	test("returns no groups for an empty action list", () => {
		expect(groupActions([])).toEqual([]);
	});
});

describe("actionSearchValue", () => {
	test("uses the explicit value when set", () => {
		expect(
			actionSearchValue(action({ id: "x", value: "sign out log out" }))
		).toBe("sign out log out");
	});

	test("falls back to group + title + keywords", () => {
		expect(
			actionSearchValue(
				action({ id: "x", group: "Nav", title: "Chat", keywords: "talk" })
			)
		).toBe("Nav Chat talk");
	});

	test("omits missing keywords cleanly", () => {
		expect(
			actionSearchValue(action({ id: "x", group: "Nav", title: "Chat" }))
		).toBe("Nav Chat");
	});
});
