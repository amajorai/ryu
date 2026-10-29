import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { UIMessage } from "ai";
import type { Value } from "platejs";
import { applyEditorAiContext } from "./editor-ai-context.ts";

beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());

const children: Value = [
	{ type: "p", children: [{ text: "Teh quick brown fox." }] },
	{ type: "p", children: [{ text: "Second paragraph here." }] },
];

function userMessage(text: string): UIMessage {
	return { id: "u1", parts: [{ type: "text", text }], role: "user" };
}

function textOf(message: UIMessage | undefined): string {
	return (message?.parts ?? [])
		.map((part) => (part.type === "text" ? part.text : ""))
		.join("\n");
}

describe("applyEditorAiContext", () => {
	test("returns the messages unchanged without a ctx snapshot", () => {
		const messages = [userMessage("Improve the writing")];
		expect(applyEditorAiContext(messages, undefined)).toBe(messages);
	});

	test("an edit command sends the selected text to the model", () => {
		const messages = [userMessage("Fix spelling")];
		const result = applyEditorAiContext(messages, {
			children,
			selection: {
				anchor: { offset: 0, path: [0, 0] },
				focus: { offset: 20, path: [0, 0] },
			},
			toolName: "edit",
		});
		const text = textOf(result[0]);
		expect(text).toContain("<Selection>");
		expect(text).toContain("Teh quick brown fox.");
		expect(text).not.toContain("Second paragraph here.");
		expect(text).toContain("Fix spelling");
		// The caller's chat history is not mutated.
		expect(textOf(messages[0])).toBe("Fix spelling");
	});

	test("substitutes {editor} with the document Markdown once", () => {
		const result = applyEditorAiContext([userMessage("Explain {editor}")], {
			children,
			selection: null,
			toolName: "generate",
		});
		const text = textOf(result[0]);
		expect(text).not.toContain("{editor}");
		expect(text).not.toContain("<Document>");
		expect(text).toContain("Second paragraph here.");
	});

	test("a cursor generate command gets the document and current block", () => {
		const result = applyEditorAiContext(
			[userMessage("Continue writing AFTER <Block> ONLY ONE SENTENCE.")],
			{
				children,
				selection: {
					anchor: { offset: 5, path: [1, 0] },
					focus: { offset: 5, path: [1, 0] },
				},
				toolName: "generate",
			}
		);
		const text = textOf(result[0]);
		expect(text).toContain("<Document>");
		expect(text).toMatch(/<Block>\nSecond paragraph here\.\n<\/Block>/);
	});
});
