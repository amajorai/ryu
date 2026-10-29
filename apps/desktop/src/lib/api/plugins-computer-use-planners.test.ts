import { describe, expect, test } from "bun:test";
import { parsePluginComputerUsePlanners } from "./plugins.ts";

describe("plugin computer-use planner catalog boundary", () => {
	test("keeps valid enabled-plugin model choices and drops duplicate ids", () => {
		const parsed = parsePluginComputerUsePlanners([
			{
				id: "needle3.base",
				label: "Needle 3 · Base",
				model_id: "needle3",
				plugin: "@ryu/needle3",
			},
			{
				id: "needle3.base",
				label: "Duplicate",
				model_id: "other",
				plugin: "@ryu/needle3",
			},
		]);
		expect(parsed).toEqual([
			{
				id: "needle3.base",
				label: "Needle 3 · Base",
				model_id: "needle3",
				plugin: "@ryu/needle3",
			},
		]);
	});

	test("rejects unsafe ids, malformed model names, and control characters", () => {
		expect(
			parsePluginComputerUsePlanners([
				{
					id: "../x",
					label: "Bad",
					model_id: "needle3",
					plugin: "@ryu/needle3",
				},
				{
					id: "ok",
					label: "Bad\nlabel",
					model_id: "needle3",
					plugin: "@ryu/needle3",
				},
				{
					id: "ok",
					label: "Bad",
					model_id: "needle3\n",
					plugin: "@ryu/needle3",
				},
				{
					id: "ok",
					label: "Bad",
					model_id: "needle3",
					plugin: "@ryu/../needle3",
				},
			])
		).toEqual([]);
	});
});
