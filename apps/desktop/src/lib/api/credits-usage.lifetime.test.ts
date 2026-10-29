import { expect, mock, test } from "bun:test";

mock.module("@/lib/auth-client.ts", () => ({
	BACKEND_URL: "http://fixture.invalid",
	TOKEN_KEY: "test-session",
	getActiveToken: () =>
		globalThis.localStorage?.getItem("test-session") ?? null,
}));
const { fetchUsage } = await import("./credits.ts");

test("statement cancellation closes a held response without changing filter encoding", async () => {
	let closed = false;
	let headersReceived = false;
	let path = "";
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			path = new URL(request.url).pathname + new URL(request.url).search;
			return new Response(
				new ReadableStream({
					start(controller) {
						controller.enqueue(new TextEncoder().encode("{"));
					},
					cancel() {
						closed = true;
					},
				})
			);
		},
	});
	const realFetch = globalThis.fetch;
	globalThis.fetch = Object.assign(
		async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = new URL(String(input));
			const response = await realFetch(
				new URL(url.pathname + url.search, server.url),
				init
			);
			headersReceived = true;
			return response;
		},
		{ preconnect: realFetch.preconnect }
	);
	try {
		const controller = new AbortController();
		const result = fetchUsage(
			{ provider: "A & B", before: "cursor", limit: 50, model: null },
			controller.signal
		).then(
			() => "complete",
			() => "aborted"
		);
		const deadline = Date.now() + 1000;
		while (!headersReceived && Date.now() < deadline) {
			await Bun.sleep(5);
		}
		expect(headersReceived).toBe(true);
		expect(path).toBe(
			"/api/credits/usage?provider=A+%26+B&before=cursor&limit=50"
		);
		controller.abort();
		const closeDeadline = Date.now() + 1000;
		while (!closed && Date.now() < closeDeadline) {
			await Bun.sleep(5);
		}
		expect(closed).toBe(true);
		expect(await result).toBe("aborted");
	} finally {
		globalThis.fetch = realFetch;
		await server.stop(true);
	}
});
