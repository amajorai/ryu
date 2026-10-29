import { describe, expect, test } from "bun:test";
import { promptLayerChanges } from "./prompt-layer-changes.ts";

const saved = {
	persona: { display_name: "Scout", output_style_id: null, tone: "warm" },
	skills: ["a", "b"],
	systemPrompt: "Be useful.",
};

const draft = {
	displayName: "Scout",
	outputStyleId: null,
	skills: ["b", "a"],
	systemPrompt: "Be useful.  ",
	tone: "warm",
};

describe("promptLayerChanges", () => {
	test("an unchanged prompt needs no confirmation", () => {
		expect(promptLayerChanges(saved, draft)).toEqual([]);
	});

	test("names every changed prompt layer", () => {
		expect(
			promptLayerChanges(saved, {
				...draft,
				outputStyleId: "concise",
				skills: ["a"],
				systemPrompt: "Be brief.",
				tone: null,
			})
		).toEqual([
			"The personality profile",
			"Skills",
			"The name and tone",
			"The instructions",
		]);
	});
});
