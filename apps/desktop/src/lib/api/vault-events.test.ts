import { afterEach, expect, test } from "bun:test";
import type { ApiTarget } from "./client.ts";
import { openVaultChangeStream } from "./vault-events.ts";

const target: ApiTarget = {
	token: "node-token",
	url: "https://vault-events.fixture",
	userJwt: null,
};
const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

function serve(response: () => Response, seen: Request[]) {
	globalThis.fetch = Object.assign(
		(input: RequestInfo | URL, init?: RequestInit) => {
			seen.push(new Request(String(input), init));
			return Promise.resolve(response());
		},
		{ preconnect: originalFetch.preconnect }
	);
}

test("opens /api/vault/events with the node bearer and yields its frames", async () => {
	const seen: Request[] = [];
	const body = [
		": keep-alive",
		"",
		"event: vault",
		'data: {"action":"write","at":"2026-11-13T00:00:00Z","seq":7,"type":"kv-write","name":"API_KEY","environment":"dev"}',
		"",
		"event: lagged",
		'data: {"skipped":3}',
		"",
		"",
	].join("\n");
	serve(
		() =>
			new Response(body, {
				headers: { "content-type": "text/event-stream" },
			}),
		seen
	);
	const stream = await openVaultChangeStream(
		target,
		new AbortController().signal
	);
	const received = [];
	for await (const message of stream) {
		received.push(message);
	}
	expect(seen[0]?.url).toBe("https://vault-events.fixture/api/vault/events");
	expect(seen[0]?.headers.get("accept")).toBe("text/event-stream");
	expect(seen[0]?.headers.get("authorization")).toBe("Bearer node-token");
	expect(received).toEqual([
		{
			event: {
				action: "write",
				at: "2026-11-13T00:00:00Z",
				environment: "dev",
				name: "API_KEY",
				seq: 7,
				type: "kv-write",
			},
			kind: "event",
		},
		{ kind: "lagged", skipped: 3 },
	]);
});

test("a refused subscription throws with its status", async () => {
	serve(() => new Response("forbidden", { status: 403 }), []);
	await expect(
		openVaultChangeStream(target, new AbortController().signal)
	).rejects.toMatchObject({ status: 403 });
});
