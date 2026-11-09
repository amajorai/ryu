import { afterEach, describe, expect, it } from "bun:test";
import { ApiError } from "./client.ts";
import { getWorkingMemoryHistory } from "./memory-working.ts";

const target = { token: null, url: "http://node.test" };
const nativeFetch = globalThis.fetch;

function stubFetch(response: () => Response, urls: string[] = []): void {
	globalThis.fetch = Object.assign(
		(input: Parameters<typeof fetch>[0]) => {
			urls.push(String(input));
			return Promise.resolve(response());
		},
		{ preconnect: nativeFetch.preconnect }
	);
}

describe("working memory history client", () => {
	afterEach(() => {
		globalThis.fetch = nativeFetch;
	});

	it("requests the bounded history and maps each version", async () => {
		const urls: string[] = [];
		stubFetch(
			() =>
				Response.json({
					id: "conv-1",
					scope: "thread",
					versions: [
						{
							content: "# Task\n- goal: ship",
							mode: "template",
							updated_at: 30,
							version: 2,
						},
						{
							content: "# Task\n- goal:",
							mode: "template",
							updated_at: 10,
							version: 1,
						},
					],
				}),
			urls
		);

		const versions = await getWorkingMemoryHistory(
			target,
			{ id: "conv-1", scope: "thread" },
			2
		);
		expect(urls).toEqual([
			"http://node.test/api/memory/working/history?scope=thread&id=conv-1&limit=2",
		]);
		expect(versions).toEqual([
			{
				content: "# Task\n- goal: ship",
				mode: "template",
				updatedAt: 30,
				version: 2,
			},
			{
				content: "# Task\n- goal:",
				mode: "template",
				updatedAt: 10,
				version: 1,
			},
		]);
	});

	it("keeps schema-mode data and surfaces a refusal as an ApiError", async () => {
		stubFetch(() =>
			Response.json({
				id: "user-1",
				scope: "resource",
				versions: [
					{ data: { plan: "pro" }, mode: "schema", updated_at: 5, version: 1 },
				],
			})
		);
		await expect(
			getWorkingMemoryHistory(target, { id: "user-1", scope: "resource" })
		).resolves.toEqual([
			{ data: { plan: "pro" }, mode: "schema", updatedAt: 5, version: 1 },
		]);

		stubFetch(() =>
			Response.json(
				{ error: "insufficient permissions: space:read" },
				{ status: 403 }
			)
		);
		await expect(
			getWorkingMemoryHistory(target, { id: "user-1", scope: "resource" })
		).rejects.toBeInstanceOf(ApiError);
	});
});
