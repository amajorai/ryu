import { describe, expect, test } from "bun:test";
import { groupScanItems, IMPORT_ITEM_KINDS, kindLabel } from "./import.ts";

describe("import item kinds", () => {
	test("labels every backend item kind for the setup picker", () => {
		expect(IMPORT_ITEM_KINDS.map(kindLabel)).toEqual([
			"Instructions",
			"Skills",
			"MCP servers",
			"Plugins",
			"Memories",
			"Agents",
			"Slash commands",
			"Chats and projects",
		]);
	});

	test("preserves order while grouping agents and slash commands", () => {
		expect(
			groupScanItems([
				{
					alreadyExists: false,
					id: "agent/a",
					kind: "agent",
					title: "A",
				},
				{
					alreadyExists: false,
					id: "command/run",
					kind: "slash_command",
					title: "/run",
				},
				{
					alreadyExists: false,
					id: "agent/b",
					kind: "agent",
					title: "B",
				},
			])
		).toEqual([
			{
				kind: "agent",
				label: "Agents",
				items: [
					{
						alreadyExists: false,
						id: "agent/a",
						kind: "agent",
						title: "A",
					},
					{
						alreadyExists: false,
						id: "agent/b",
						kind: "agent",
						title: "B",
					},
				],
			},
			{
				kind: "slash_command",
				label: "Slash commands",
				items: [
					{
						alreadyExists: false,
						id: "command/run",
						kind: "slash_command",
						title: "/run",
					},
				],
			},
		]);
	});
});
