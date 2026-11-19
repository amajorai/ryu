import { describe, expect, test } from "bun:test";
import type { LiteralMessage } from "@ryu/i18n/react";
import {
	agentRefusalSentence,
	agentSuggestionsFailureMessage,
} from "./OnboardingPage.copy.ts";

const tl: LiteralMessage = (source, values) =>
	`[${source}]${values ? JSON.stringify(values) : ""}`;

describe("agent suggestion refusals", () => {
	test("a refusal is one sentence with the mode title translated", () => {
		expect(
			agentRefusalSentence(tl, "Scout", "Its own identity", "No sandbox.")
		).toBe(
			'[{name} can\'t start as "{mode}": {reason}]{"name":"Scout","mode":"[Its own identity]","reason":"No sandbox."}'
		);
	});

	test("a missing Core reason uses the catalogued generic sentence", () => {
		expect(agentRefusalSentence(tl, "Scout", "Both", null)).toContain(
			'"reason":"[Ryu won\'t start this agent.]"'
		);
	});

	test("failed names are joined as a list in the reader's language", () => {
		const message = agentSuggestionsFailureMessage(tl, {
			blockedByLimit: false,
			createdCount: 1,
			createFailedNames: [],
			failedNames: ["Scout", "Scribe"],
			refused: [],
		});
		expect(message).toContain('"names":"Scout and Scribe"');
	});
});
