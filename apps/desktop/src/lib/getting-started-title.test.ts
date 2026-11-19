import { expect, test } from "bun:test";
import { GETTING_STARTED_QUESTS, questTitle } from "./getting-started.ts";

test("every quest title reads through the translator by its own literal", () => {
	const asked: string[] = [];
	const tl = (source: string) => {
		asked.push(source);
		return `[${source}]`;
	};
	for (const quest of GETTING_STARTED_QUESTS) {
		expect(questTitle(tl, quest)).toBe(`[${quest.content}]`);
	}
	expect(asked).toContain("Send your first message");
	expect(asked).toContain("Customize your Ryu");
	expect(asked).toHaveLength(GETTING_STARTED_QUESTS.length);
});

test("a quest with an unknown id still translates its English title", () => {
	expect(
		questTitle((source) => source.toUpperCase(), {
			content: "Try voice",
			id: "voice",
		})
	).toBe("TRY VOICE");
});
