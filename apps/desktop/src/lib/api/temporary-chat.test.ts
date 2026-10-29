import { afterEach, describe, expect, test } from "bun:test";
import { createFetchFixture } from "../../test-fixtures/native-fetch-fixture.ts";
import { saveTemporaryChat } from "./temporary-chat.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("temporary chat API", () => {
	test("keeps display metadata and user file parts when a temporary chat is saved", async () => {
		let requestBody: unknown;
		globalThis.fetch = createFetchFixture(
			originalFetch,
			async (_input, init) => {
				requestBody = JSON.parse(String(init?.body));
				return Response.json(
					{ conversation: { id: "temporary-files" } },
					{ status: 201 }
				);
			}
		);
		const message = {
			content: "Provider context and original request",
			metadata: { ryuUserText: "Original request" },
			parts: [
				{ type: "text", text: "Provider context and original request" },
				{
					type: "file",
					filename: "note.txt",
					mediaType: "text/plain",
					url: "data:text/plain;base64,SGVsbG8=",
				},
			],
			role: "user" as const,
		};
		await saveTemporaryChat(
			{ url: "http://127.0.0.1:7980", token: "fixture-token" },
			"temporary-files",
			{ messages: [message] }
		);
		expect(requestBody).toEqual({ messages: [message] });
	});

	test("sends the complete in-tab transcript to Core's save boundary", async () => {
		let requestBody: unknown;
		let requestUrl = "";
		globalThis.fetch = createFetchFixture(
			originalFetch,
			async (input, init) => {
				requestUrl = String(input);
				requestBody = JSON.parse(String(init?.body));
				return new Response(
					JSON.stringify({ conversation: { id: "temporary-1" } }),
					{ headers: { "Content-Type": "application/json" }, status: 201 }
				);
			}
		);

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
