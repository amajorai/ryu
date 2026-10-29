import { afterEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import {
	listMessageReadReceipts,
	markMessageRead,
} from "./message-read-receipts.ts";

const target = { token: "node-token", url: "http://127.0.0.1:7980" };
const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("message read receipt API", () => {
	test("loads the camelCase receipt projection", async () => {
		globalThis.fetch = Object.assign(
			() =>
				Promise.resolve(
					Response.json({
						receipts: [
							{
								messageId: "m1",
								readAt: "2026-09-14T10:00:00.000Z",
								userId: "ada",
							},
							{ messageId: 42 },
						],
						users: [
							{
								avatar: "https://cdn.example.test/ada.webp",
								id: "ada",
								name: "Ada Lovelace",
							},
							{ id: 42, name: "ignored" },
						],
					})
				),
			{ preconnect: originalFetch.preconnect }
		);

		expect(await listMessageReadReceipts(target, "chat-1")).toEqual({
			receipts: [
				{
					messageId: "m1",
					readAt: "2026-09-14T10:00:00.000Z",
					userId: "ada",
				},
			],
			users: [
				{
					avatar: "https://cdn.example.test/ada.webp",
					id: "ada",
					name: "Ada Lovelace",
				},
			],
		});
	});

	test("posts a deduplicated visible-message batch", async () => {
		let requestBody: { messageIds: string[] } | undefined;
		let requestUrl = "";
		globalThis.fetch = Object.assign(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				requestUrl = String(input);
				requestBody = z
					.object({ messageIds: z.array(z.string()) })
					.parse(JSON.parse(String(init?.body)));
				return Response.json({
					receipts: [
						{
							messageId: "m1",
							readAt: "2026-09-14T10:00:00.000Z",
							userId: "bob",
						},
					],
				});
			},
			{ preconnect: originalFetch.preconnect }
		);

		expect(await markMessageRead(target, "chat-1", ["m1", "m1", "m2"])).toEqual(
			[
				{
					messageId: "m1",
					readAt: "2026-09-14T10:00:00.000Z",
					userId: "bob",
				},
			]
		);
		expect(requestUrl).toBe(
			"http://127.0.0.1:7980/api/conversations/chat-1/read"
		);
		expect(requestBody).toEqual({ messageIds: ["m1", "m2"] });
	});
});
