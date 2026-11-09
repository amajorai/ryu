import { afterEach, describe, expect, it } from "bun:test";
import { getMemoryGitTrace } from "./memory-git-trace.ts";

const target = { token: null, url: "http://node.test" };
const nativeFetch = globalThis.fetch;

function jsonResponse<TFixture>(body: TFixture): Response {
	return new Response(JSON.stringify(body), {
		headers: { "content-type": "application/json" },
		status: 200,
	});
}

describe("memory Git trace client", () => {
	afterEach(() => {
		globalThis.fetch = nativeFetch;
	});

	it("requests the bounded trace and maps its commits", async () => {
		const urls: string[] = [];
		globalThis.fetch = Object.assign(
			(input: Parameters<typeof fetch>[0]) => {
				urls.push(String(input));
				return Promise.resolve(
					jsonResponse({
						commits: [
							{
								author: "Ada",
								files: ["memory/tea.md"],
								hash: "abc123",
								subject: "Remember tea",
								timestamp: "2026-01-01T00:00:00Z",
							},
						],
						configured: true,
						path: "memory",
					})
				);
			},
			{ preconnect: nativeFetch.preconnect }
		);

		const trace = await getMemoryGitTrace(target, "memory", 5);
		expect(urls).toEqual([
			"http://node.test/api/memory/git/trace?path=memory&limit=5",
		]);
		expect(trace).toEqual({
			commits: [
				{
					author: "Ada",
					files: ["memory/tea.md"],
					hash: "abc123",
					subject: "Remember tea",
					timestamp: "2026-01-01T00:00:00Z",
				},
			],
			configured: true,
			path: "memory",
		});
	});

	it("reports an unconfigured source with the requested path", async () => {
		globalThis.fetch = Object.assign(() => Promise.resolve(jsonResponse({})), {
			preconnect: nativeFetch.preconnect,
		});

		await expect(getMemoryGitTrace(target)).resolves.toEqual({
			commits: [],
			configured: false,
			path: "memory",
		});
	});
});
