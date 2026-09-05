import { describe, expect, test } from "bun:test";
import {
	DEFAULT_TAB_UNLOAD_MINUTES,
	inactiveTabIds,
	initialTabActivity,
} from "./tab-memory-policy.ts";

const NOW = 10 * 60_000;

describe("tab memory policy", () => {
	test("defaults to a bounded ten-minute window", () => {
		expect(DEFAULT_TAB_UNLOAD_MINUTES).toBe(10);
	});

	test("timestamps restored tabs so they become eligible after the window", () => {
		expect(
			initialTabActivity([{ id: "active" }, { id: "restored" }], NOW)
		).toEqual({ active: NOW, restored: NOW });
	});

	test("reaps only quiet background tabs", () => {
		const tabs = [
			{ id: "active" },
			{ id: "old" },
			{ busy: true, id: "running" },
			{ id: "pinned", pinned: true },
			{ id: "visible-split", splitId: "split" },
			{ id: "focused-split", splitId: "split" },
			{ id: "already-unloaded", unloaded: true },
		];

		expect(
			inactiveTabIds(
				tabs,
				"focused-split",
				{
					active: NOW,
					old: 0,
					running: 0,
					pinned: 0,
					"visible-split": 0,
					"focused-split": 0,
					"already-unloaded": 0,
				},
				NOW,
				5
			)
		).toEqual(["old"]);
	});

	test("zero and invalid windows never unload anything", () => {
		const tabs = [{ id: "old" }];
		const activity = { old: 0 };
		expect(inactiveTabIds(tabs, "", activity, NOW, 0)).toEqual([]);
		expect(inactiveTabIds(tabs, "", activity, NOW, Number.NaN)).toEqual([]);
	});
});
