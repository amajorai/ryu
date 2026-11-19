import { describe, expect, test } from "bun:test";
import { createCliTranslator } from "../i18n/translate.ts";
import { reasoningHeaderParts } from "./ReasoningRow.tsx";

const japanese = createCliTranslator("ja", {
	"Thinking:": "思考中:",
	Thinking: "思考中",
	"{marker} Thought:": "{marker} 思考:",
	"{marker} Thought": "{marker} 思考",
});

describe("reasoning header", () => {
	test("the lead renders in the locale while streaming and after", () => {
		const base = { text: "**Plan** the work", expanded: false };
		expect(
			reasoningHeaderParts({ ...base, streaming: true }, japanese).lead
		).toBe("思考中:");
		expect(
			reasoningHeaderParts({ ...base, streaming: false }, japanese).lead
		).toBe("+ 思考:");
		expect(
			reasoningHeaderParts(
				{ text: "", expanded: true, streaming: false },
				japanese
			).lead
		).toBe("- 思考");
	});
});
