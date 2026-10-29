import { describe, expect, test } from "bun:test";
import selectionFixture from "../fixtures/primary-bot-selection.json" with {
	type: "json",
};
import { ApiError, type ApiTarget } from "./client.ts";
import {
	ensurePrimaryBotConversation,
	getPrimaryBot,
	type PrimaryBotSelection,
	setPrimaryBot,
} from "./primary-bot.ts";

// Rust Selection serialization asserts the same fixture for every host.
const selection = {
	...selectionFixture,
	source: "selected" as const,
} satisfies PrimaryBotSelection;

describe("primary conversational selection transport", () => {
	test("read and CAS write carry verified identity without caller-selected scope", async () => {
		const calls: Array<{ url: string; init?: RequestInit }> = [];
		const target: ApiTarget = {
			url: "https://node.example.test/",
			token: "node-test-token",
			userJwt: "alice-test-identity",
			fetch: async (url, init) => {
				calls.push({ url: String(url), init });
				return Response.json(selection);
			},
		};
		expect(selectionFixture).toEqual(selection);
		expect(await getPrimaryBot(target)).toEqual(selection);
		expect(
			await setPrimaryBot(target, { agentId: "scout", expectedRevision: 2 })
		).toEqual(selection);
		expect(calls.map((call) => call.url)).toEqual([
			"https://node.example.test/api/primary-bot",
			"https://node.example.test/api/primary-bot",
		]);
		const headers = new Headers(calls[1]?.init?.headers);
		expect(headers.get("Authorization")).toBe("Bearer node-test-token");
		expect(headers.get("x-ryu-user-jwt")).toBe("alice-test-identity");
		expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({
			agentId: "scout",
			expectedRevision: 2,
		});
	});

	test("clear is explicit and stale saves expose recovery without automatic replay", async () => {
		let calls = 0;
		const target: ApiTarget = {
			url: "https://node.example.test",
			token: null,
			fetch: async (_url, init) => {
				calls += 1;
				expect(JSON.parse(String(init?.body))).toEqual({
					agentId: null,
					expectedRevision: 3,
				});
				return Response.json(
					{
						code: "primary_bot_revision_conflict",
						error:
							"Primary bot changed elsewhere. Reload the current selection and retry with its revision.",
					},
					{ status: 409 }
				);
			},
		};
		try {
			await setPrimaryBot(target, { agentId: null, expectedRevision: 3 });
			throw new Error("stale mutation unexpectedly succeeded");
		} catch (error) {
			expect(error).toBeInstanceOf(ApiError);
			expect((error as ApiError).status).toBe(409);
			expect((error as Error).message).toContain(
				"Reload the current selection"
			);
		}
		expect(calls).toBe(1);
	});

	test("opening reuses main threads without mutating selection or sessions", async () => {
		const calls: Array<{ url: string; body: unknown }> = [];
		const target: ApiTarget = {
			url: "https://node.example.test",
			token: null,
			fetch: async (url, init) => {
				calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
				return Response.json({ conversation_id: "existing-main" });
			},
		};
		expect(await ensurePrimaryBotConversation(target, "scout")).toBe(
			"existing-main"
		);
		expect(calls).toEqual([
			{
				url: "https://node.example.test/api/hierarchy/main-threads",
				body: { owner_kind: "agent", owner_id: "scout", agent_id: "scout" },
			},
		]);
	});

	test("malformed main-thread acknowledgements cannot create a phantom direct chat", async () => {
		for (const response of [{}, { conversation_id: " " }]) {
			await expect(
				ensurePrimaryBotConversation(
					{
						url: "https://node.example.test",
						token: null,
						fetch: async () => Response.json(response),
					},
					"scout"
				)
			).rejects.toThrow("Core did not return a main conversation ID");
		}
	});
});
