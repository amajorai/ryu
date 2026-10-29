import { describe, expect, it } from "bun:test";
import { sidebarModeSchema } from "../../hooks/useSidebarMode.ts";
import {
	parseSidebarPageSizes,
	parseSidebarSorts,
} from "./sidebar-state-contracts.ts";

describe("saved sidebar state boundaries", () => {
	it("keeps valid legacy page values without changing pagination policy", () => {
		expect(
			parseSidebarPageSizes({
				chats: 0,
				agents: -1,
				spaces: 1.5,
				unknown: 8,
				workflows: "8",
				"plugin:future-app:rows": 20,
			})
		).toEqual({
			chats: 0,
			agents: -1,
			spaces: 1.5,
			"plugin:future-app:rows": 20,
		});
	});
	it("drops malformed rows independently and tolerates malformed containers", () => {
		expect(parseSidebarPageSizes({ chats: 10, agents: null })).toEqual({
			chats: 10,
		});
		for (const input of [null, [], false, "malformed"]) {
			expect(parseSidebarPageSizes(input)).toEqual({});
			expect(parseSidebarSorts(input)).toEqual({});
		}
	});
	it("keeps valid sorts for absent apps without accepting arbitrary sort vocabularies", () => {
		expect(
			parseSidebarSorts({
				chats: "name-asc",
				spaces: "updated",
				agents: "future-sort",
				"plugin:absent:rows": "created",
				unknown: "default",
			})
		).toEqual({
			chats: "name-asc",
			spaces: "updated",
			"plugin:absent:rows": "created",
		});
	});
	it("retains saved mode keys while the contributions feed is unavailable", () => {
		for (const mode of [
			"sections",
			"tabbed",
			"agent",
			"computers",
			"plugin:absent:mode",
			"plugin:",
		] as const) {
			expect(sidebarModeSchema.parse(mode)).toBe(mode);
		}
		for (const invalid of ["bot", "", "tabbed:future", null]) {
			expect(sidebarModeSchema.safeParse(invalid).success).toBe(false);
		}
	});
});
