import { afterEach, describe, expect, test } from "bun:test";
import { saveTemporaryChat } from "./temporary-chat.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("temporary chat API", () => {
	test("sends the complete in-tab transcript to Core's save boundary", async () => {
		let requestBody: unknown;
		let requestUrl = "";
		globalThis.fetch = (async (input, init) => {
			requestUrl = String(input);
			requestBody = JSON.parse(String(init?.body));
			return new Response(
				JSON.stringify({ conversation: { id: "temporary-1" } }),
				{ headers: { "Content-Type": "application/json" }, status: 201 }
			);
		}) as typeof globalThis.fetch;

		await saveTemporaryChat(
			{ token: "node-token", url: "http://127.0.0.1:7980" },
			"temporary-1",
			{
				agentId: "agent-x",
				folderPath: "/tmp/project",
				messages: [
					{
						content: "Keep this private",
						parts: [{ text: "Keep this private", type: "text" }],
						role: "user",
					},
					{
						content: "Understood.",
						parts: [{ text: "Understood.", type: "text" }],
						role: "assistant",
					},
				],
			}
		);

		expect(requestUrl).toBe(
			"http://127.0.0.1:7980/api/conversations/temporary-1/save"
		);
		expect(requestBody).toEqual({
			agent_id: "agent-x",
			folder_path: "/tmp/project",
			messages: [
				{
					content: "Keep this private",
					parts: [{ text: "Keep this private", type: "text" }],
					role: "user",
				},
				{
					content: "Understood.",
					parts: [{ text: "Understood.", type: "text" }],
					role: "assistant",
				},
			],
		});
	});
});
