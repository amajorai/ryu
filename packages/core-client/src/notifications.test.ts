import { afterEach, describe, expect, test } from "bun:test";
import { listMentionTargetUsers } from "./notifications.ts";

const originalFetch = globalThis.fetch;
const target = {
	token: "node-token",
	url: "http://127.0.0.1:7980",
};

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("listMentionTargetUsers", () => {
	test("normalizes the organization roster for a picker", async () => {
		globalThis.fetch = (() =>
			Promise.resolve(
				Response.json({
					users: [
						{
							email: "ada@example.test",
							image: "https://cdn.example.test/ada.webp",
							name: "Ada Lovelace",
							role: "member",
							userId: "user-ada",
						},
					],
				})
			)) as unknown as typeof fetch;

		expect(await listMentionTargetUsers(target)).toEqual([
			{
				email: "ada@example.test",
				id: "user-ada",
				image: "https://cdn.example.test/ada.webp",
				name: "Ada Lovelace",
				role: "member",
			},
		]);
	});

	test("fails closed when the organization roster is unavailable", async () => {
		globalThis.fetch = (() =>
			Promise.resolve(
				new Response(JSON.stringify({ error: "unavailable" }), { status: 503 })
			)) as unknown as typeof fetch;

		expect(await listMentionTargetUsers(target)).toEqual([]);
	});
});
