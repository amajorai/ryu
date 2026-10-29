import { describe, expect, test } from "bun:test";
import type { UIMessage } from "ai";
import { createMessageDecorator } from "./chat-message-decoration.ts";

function reply(id: string, text: string): UIMessage {
	return { id, role: "assistant", parts: [{ type: "text", text }] };
}

function options(): Parameters<
	ReturnType<typeof createMessageDecorator<UIMessage>>
>[1] {
	return {
		sentAt: new Map<string, number>(),
		labels: {},
		council: false,
		fallbackLabel: null,
	};
}

describe("streaming message decoration", () => {
	test("retains settled objects, dates and parts across 100 streamed chunks", () => {
		const decorate = createMessageDecorator<UIMessage>();
		const settings = options();
		const history = Array.from({ length: 500 }, (_, i) =>
			reply(`m${i}`, `Reply ${i}`)
		);
		const baseline = decorate(history, settings);
		let changedHistory = 0;
		for (let chunk = 0; chunk < 100; chunk += 1) {
			const next = decorate(
				[...history, reply("live", `Chunk ${chunk}`)],
				settings
			);
			for (let i = 0; i < history.length; i += 1) {
				if (next[i] !== baseline[i]) {
					changedHistory += 1;
				}
			}
			expect(next.at(-1)?.parts).toEqual([
				{ type: "text", text: `Chunk ${chunk}` },
			]);
		}
		expect(changedHistory).toBe(0);
		expect(baseline[0].parts).toBe(history[0].parts);
		expect(decorate(history, settings)[0].createdAt).toBe(
			baseline[0].createdAt
		);
	});

	test("updates server timestamps and edited source messages without stale data", () => {
		const decorate = createMessageDecorator<UIMessage>();
		const settings = options();
		const original = reply("a", "Original");
		const initial = decorate([original], settings)[0];
		settings.sentAt.set("a", 1234);
		const stamped = decorate([original], settings)[0];
		expect(stamped).not.toBe(initial);
		expect(stamped.createdAt.getTime()).toBe(1234);
		const edited = reply("a", "Edited");
		expect(decorate([edited], settings)[0].parts).toBe(edited.parts);
	});

	test("relabels council messages after paging, label changes and council removal", () => {
		const decorate = createMessageDecorator<UIMessage>();
		const settings = options();
		settings.council = true;
		settings.labels = { "0": "Alpha", "1": "Beta" };
		settings.fallbackLabel = "Fallback";
		const original = reply("a", "Answer");
		const first = decorate([original], settings)[0];
		expect(first.parts).toEqual([
			{ type: "text", text: "**Alpha**\n\nAnswer" },
		]);
		expect(decorate([original], settings)[0]).toBe(first);
		const paged = decorate([reply("older", "Older"), original], settings)[1];
		expect(paged.parts).toEqual([{ type: "text", text: "**Beta**\n\nAnswer" }]);
		settings.labels = {};
		expect(decorate([original], settings)[0].parts).toEqual([
			{ type: "text", text: "**Fallback**\n\nAnswer" },
		]);
		settings.council = false;
		expect(decorate([original], settings)[0].parts).toBe(original.parts);
	});

	test("keeps existing labels, non-text parts, metadata and blocked flags", () => {
		const original = {
			...reply("a", "**Alpha**\n\nAnswer"),
			_blocked: true,
			metadata: { source: "test" },
		};
		original.parts.push({ type: "step-start" });
		const decorate = createMessageDecorator<typeof original>();
		const result = decorate([original], {
			...options(),
			council: true,
			labels: { "0": "Alpha" },
		})[0];
		expect(result.parts).toEqual(original.parts);
		expect(result.parts[1]).toBe(original.parts[1]);
		expect(result.metadata).toBe(original.metadata);
		expect(result._blocked).toBe(true);
	});
});
