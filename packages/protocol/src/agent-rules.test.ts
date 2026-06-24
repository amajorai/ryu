import { describe, expect, it } from "bun:test";
import { composeRules, parseRules } from "./agent-rules.ts";

describe("composeRules / parseRules", () => {
	it("returns just the instructions when there are no rules", () => {
		expect(composeRules("Be helpful.", [])).toBe("Be helpful.");
		expect(composeRules("Be helpful.", ["  ", ""])).toBe("Be helpful.");
	});

	it("folds rules into a delimited block under the instructions", () => {
		const composed = composeRules("Be helpful.", ["No emojis", "Cite sources"]);
		expect(composed).toContain("Be helpful.");
		expect(composed).toContain("<!--ryu:rules-->");
		expect(composed).toContain("- No emojis");
		expect(composed).toContain("- Cite sources");
	});

	it("emits only the block when instructions are empty", () => {
		expect(composeRules("", ["Only rule"])).toBe(
			"## Rules\n<!--ryu:rules-->\n- Only rule\n<!--/ryu:rules-->"
		);
	});

	it("round-trips instructions + rules losslessly", () => {
		const instructions = "You are a careful assistant.";
		const rules = ["No emojis", "Cite sources", "Be concise"];
		const parsed = parseRules(composeRules(instructions, rules));
		expect(parsed).toEqual({ instructions, rules });
	});

	it("treats a prompt with no block as all instructions", () => {
		expect(parseRules("Just a plain prompt.")).toEqual({
			instructions: "Just a plain prompt.",
			rules: [],
		});
	});

	it("trims a user-written ## Rules heading left above the block", () => {
		const parsed = parseRules(
			"Intro.\n\n## Rules\n<!--ryu:rules-->\n- A\n- B\n<!--/ryu:rules-->"
		);
		expect(parsed).toEqual({ instructions: "Intro.", rules: ["A", "B"] });
	});
});
