import { describe, expect, mock, test } from "bun:test";
import {
	type AssistantTurn,
	runAssistantTurn,
	usableBrowserAnswer,
} from "./assistant-turn.ts";

function turn(overrides: Partial<AssistantTurn>): AssistantTurn {
	return {
		mode: "browser",
		modelReady: true,
		node: null,
		onText: () => undefined,
		question: "How do I install Ryu?",
		references: [],
		runtime: {
			generate: async () => ({
				text: "Download the desktop app.",
				toolCalls: [],
			}),
			prepare: async () => undefined,
		},
		signal: new AbortController().signal,
		userContent: "How do I install Ryu?",
		...overrides,
	};
}

describe("runAssistantTurn", () => {
	test("node mode needs a connected node", async () => {
		await expect(runAssistantTurn(turn({ mode: "node" }))).rejects.toThrow(
			"Connect a local Ryu node before sending a question."
		);
	});

	test("browser mode prepares a cold model and grounds an unusable answer", async () => {
		const prepare = mock(async () => undefined);
		const result = await runAssistantTurn(
			turn({
				modelReady: false,
				runtime: {
					generate: async () => ({ text: "system: a user: b", toolCalls: [] }),
					prepare,
				},
			})
		);

		expect(prepare).toHaveBeenCalledTimes(1);
		expect(result.notice).toBe(
			"Answered locally with public-document grounding."
		);
		expect(result.answer).not.toBe("system: a user: b");
	});

	test("browser mode keeps a usable local answer", async () => {
		const prepare = mock(async () => undefined);
		const result = await runAssistantTurn(
			turn({
				runtime: {
					generate: async () => ({
						text: "  Download the desktop app.  ",
						toolCalls: [],
					}),
					prepare,
				},
			})
		);

		expect(prepare).not.toHaveBeenCalled();
		expect(result).toEqual({
			answer: "Download the desktop app.",
			notice: "Answered locally · no prompt was sent to Ryu servers.",
		});
	});
});

describe("usableBrowserAnswer", () => {
	const cases: [string, string, boolean][] = [
		["", "question", false],
		["   ", "question", false],
		["x".repeat(6001), "question", false],
		["system: one user: two", "question", false],
		["Public context: leaked", "question", false],
		["Question", "question", false],
		["Install it from the downloads page.", "question", true],
		["user: only one label", "question", true],
	];
	for (const [answer, question, expected] of cases) {
		test(`${JSON.stringify(answer.slice(0, 24))} -> ${expected}`, () => {
			expect(usableBrowserAnswer(answer, question)).toBe(expected);
		});
	}
});
