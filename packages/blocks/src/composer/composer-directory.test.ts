import { describe, expect, it } from "bun:test";
import { createComposerDirectory } from "./composer-directory.ts";

describe("createComposerDirectory", () => {
	it("projects settings into the shared menu and mention contracts", () => {
		const changes: string[] = [];
		const directory = createComposerDirectory([
			{
				ariaLabel: "Select agent",
				items: [{ description: "General assistant", id: "ryu", name: "Ryu" }],
				key: "agent",
				label: "Agent",
				onChange: (id) => changes.push(id),
				value: "ryu",
			},
		]);

		expect(directory.groups).toEqual([
			{
				id: "settings:agent",
				items: [
					{
						description: "General assistant",
						id: "settings:agent:ryu",
						keywords: ["agent", "Agent", "Ryu"],
						label: "Ryu",
					},
				],
				label: "Agent",
			},
		]);
		expect(directory.mentionItems).toEqual([
			{ id: "settings:agent:ryu", kind: "agent", label: "Ryu" },
		]);

		const selection = directory.groups[0]?.items[0];
		if (!selection) throw new Error("Projected agent selection is missing");
		directory.onSelect(selection);
		expect(changes).toEqual(["ryu"]);
	});

	it("omits empty sections", () => {
		const directory = createComposerDirectory([
			{
				ariaLabel: "Select model",
				items: [],
				key: "model",
				label: "Model",
				onChange: () => undefined,
				value: undefined,
			},
		]);

		expect(directory.groups).toEqual([]);
		expect(directory.mentionItems).toEqual([]);
	});
});
