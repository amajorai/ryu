import { describe, expect, test } from "bun:test";
import { describeConversationActivity } from "./conversation-activity.ts";

function assistant(...parts: unknown[]) {
	return { role: "assistant", parts };
}

describe("describeConversationActivity", () => {
	test("is idle with no label once the turn has settled", () => {
		expect(
			describeConversationActivity({
				status: "ready",
				messages: [assistant({ type: "text", text: "Done." })],
			})
		).toEqual({ label: null, state: "idle" });
	});

	test("reads a submitted turn as thinking", () => {
		expect(
			describeConversationActivity({
				status: "submitted",
				messages: [{ role: "user", parts: [{ type: "text", text: "hi" }] }],
			})
		).toEqual({ label: "Thinking…", state: "thinking" });
	});

	test("reads streamed text as typing", () => {
		expect(
			describeConversationActivity({
				status: "streaming",
				messages: [assistant({ type: "text", text: "Here is" })],
			})
		).toEqual({ label: "Typing…", state: "responding" });
	});

	test("names a known in-flight tool", () => {
		expect(
			describeConversationActivity({
				status: "streaming",
				messages: [
					assistant({ type: "tool-WebSearch", state: "input-available" }),
				],
			}).label
		).toBe("Searching the web…");
	});

	test("names an in-flight dynamic MCP tool by its display name", () => {
		expect(
			describeConversationActivity({
				status: "streaming",
				messages: [
					assistant({
						type: "dynamic-tool",
						toolName: "calendar.list_events",
						state: "input-streaming",
					}),
				],
			}).label
		).toBe("Using List Events…");
	});

	test("matches snake_case aliases of known tools", () => {
		expect(
			describeConversationActivity({
				status: "streaming",
				messages: [
					assistant({
						type: "dynamic-tool",
						toolName: "web_search",
						state: "input-available",
					}),
				],
			}).label
		).toBe("Searching the web…");
	});

	test("falls back to working once the latest tool call has finished", () => {
		expect(
			describeConversationActivity({
				status: "streaming",
				messages: [assistant({ type: "tool-Read", state: "output-available" })],
			})
		).toEqual({ label: "Working…", state: "working" });
	});

	test("asks for the user while a question is pending", () => {
		expect(
			describeConversationActivity({
				status: "streaming",
				pendingQuestion: true,
				messages: [assistant()],
			})
		).toEqual({ label: "Waiting for you", state: "waiting" });
	});

	test("surfaces an error", () => {
		expect(
			describeConversationActivity({
				status: "error",
				messages: [assistant()],
			})
		).toEqual({ label: "Ran into a problem", state: "error" });
	});
});
