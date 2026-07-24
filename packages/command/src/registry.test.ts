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

	test("keeps a single group intact and ordered", () => {
		const groups = groupActions([
			action({ id: "a", group: "Nav" }),
			action({ id: "b", group: "Nav" }),
			action({ id: "c", group: "Nav" }),
		]);
		expect(groups).toHaveLength(1);
		expect(groups.at(0)?.heading).toBe("Nav");
		expect(groups.at(0)?.actions.map((a) => a.id)).toEqual(["a", "b", "c"]);
	});

	test("interleaves many groups by first appearance", () => {
		const groups = groupActions([
			action({ id: "1", group: "C" }),
			action({ id: "2", group: "A" }),
			action({ id: "3", group: "B" }),
			action({ id: "4", group: "A" }),
			action({ id: "5", group: "C" }),
		]);
		expect(groups.map((g) => g.heading)).toEqual(["C", "A", "B"]);
		expect(groups.at(1)?.actions.map((a) => a.id)).toEqual(["2", "4"]);
	});

	test("does not deduplicate actions with the same id", () => {
		const groups = groupActions([
			action({ id: "dup", group: "Nav" }),
			action({ id: "dup", group: "Nav" }),
		]);
		expect(groups.at(0)?.actions).toHaveLength(2);
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

	test("falls back when value is an empty string (falsy)", () => {
		expect(
			actionSearchValue(
				action({ id: "x", group: "Nav", title: "Chat", value: "" })
			)
		).toBe("Nav Chat");
	});

	test("includes keywords in the fallback when present", () => {
		expect(
			actionSearchValue(
				action({
					id: "x",
					group: "Settings",
					title: "Theme",
					keywords: "dark light appearance",
				})
			)
		).toBe("Settings Theme dark light appearance");
	});

	test("drops an empty-string keyword from the fallback", () => {
		expect(
			actionSearchValue(
				action({ id: "x", group: "Nav", title: "Chat", keywords: "" })
			)
		).toBe("Nav Chat");
	});
});
