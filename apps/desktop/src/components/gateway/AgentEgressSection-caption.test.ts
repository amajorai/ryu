import { describe, expect, test } from "bun:test";
import { formatMessage } from "@ryu/i18n/lite";
import type { LiteralMessage } from "@ryu/i18n/react";
import { agentEgressCaptionSentences } from "./AgentEgressSection-caption.ts";

const translated: LiteralMessage = (source, values) =>
	`[t] ${formatMessage(source, values)}`;

const counts = {
	governedCount: 2,
	bestEffortCount: 1,
	directCount: 3,
	otherCount: 0,
	toolsOnCount: 4,
	toolsOffCount: 1,
	toolsOtherCount: 1,
};

describe("agentEgressCaptionSentences", () => {
	test("translates every caption sentence, including the trailing explanation", () => {
		const sentences = agentEgressCaptionSentences(counts, translated);
		expect(sentences).toHaveLength(4);
		for (const sentence of sentences) {
			expect(sentence.startsWith("[t] ")).toBe(true);
		}
		expect(sentences[0]).toBe(
			"[t] Tools: 4 have Ryu's tools · 1 do not · 1 not applicable."
		);
		expect(sentences[2]).toBe(
			"[t] Only calls that reach the gateway are filtered by the rules above, counted against your spending limits, or recorded in the activity log."
		);
		expect(sentences[3]).toBe(
			"[t] These are the only two layers shown here. Command approval above is node-wide, and plugin hooks are a separate layer again."
		);
	});
});
