import { expect, test } from "bun:test";
import type { UIMessageChunk } from "ai";
import type { CoreStreamPartEvent } from "../../shared/ipc.ts";
import {
	commandStreamPartSchema,
	validateCoreUiChunkStream,
} from "./core-stream-boundary.ts";

function source(parts: CoreStreamPartEvent["part"][]) {
	return new ReadableStream<CoreStreamPartEvent["part"]>({
		start(controller) {
			for (const part of parts) {
				controller.enqueue(part);
			}
			controller.close();
		},
	});
}

test("SDK validation preserves text, tools, reasoning and custom data in order", async () => {
	const parts: CoreStreamPartEvent["part"][] = [
		{ type: "text-start", id: "text" },
		{ type: "text-delta", id: "text", delta: "hello" },
		{ type: "reasoning-start", id: "reasoning" },
		{ type: "reasoning-delta", id: "reasoning", delta: "thinking" },
		{
			type: "tool-input-available",
			toolCallId: "call",
			toolName: "search",
			input: { query: "hello" },
		},
		{ type: "data-widget", data: { count: 3 } },
	];
	const output: UIMessageChunk[] = [];
	const reader = validateCoreUiChunkStream(source(parts)).getReader();
	while (true) {
		const next = await reader.read();
		if (next.done) {
			break;
		}
		output.push(next.value);
	}
	expect(JSON.stringify(output)).toBe(JSON.stringify(parts));
});

test("malformed IPC chunks fail the stream instead of entering SDK state", async () => {
	const reader = validateCoreUiChunkStream(
		source([{ type: "text-delta", delta: "missing-id" }])
	).getReader();
	await expect(reader.read()).rejects.toBeInstanceOf(Error);
});

test("command projection accepts only complete text and error payloads", () => {
	expect(
		commandStreamPartSchema.parse({
			type: "text-delta",
			delta: "hello",
			id: "text",
		})
	).toEqual({ type: "text-delta", delta: "hello" });
	expect(
		commandStreamPartSchema.parse({ type: "error", errorText: "failed" })
	).toEqual({ type: "error", errorText: "failed" });
	expect(
		commandStreamPartSchema.safeParse({ type: "error", errorText: 42 }).success
	).toBe(false);
	expect(
		commandStreamPartSchema.safeParse({
			type: "tool-input-available",
			toolName: "search",
		}).success
	).toBe(false);
});
