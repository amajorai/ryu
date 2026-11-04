import { afterEach, expect, test } from "bun:test";
import { startProactiveOpening } from "./chat.ts";

const originalFetch = globalThis.fetch;
const target = { token: null, url: "http://127.0.0.1:7980" };

afterEach(() => {
	globalThis.fetch = originalFetch;
});

/** Replaces fetch with one that records each JSON body and answers `completed`. */
function recordBodies(): unknown[] {
	const bodies: unknown[] = [];
	globalThis.fetch = Object.assign(
		(_input: RequestInfo | URL, init?: RequestInit) => {
			bodies.push(JSON.parse(String(init?.body)));
			return Promise.resolve(
				Response.json({
					conversation_id: "c1",
					reply: "Hi",
					status: "completed",
				})
			);
		},
		{
			preconnect: (..._args: Parameters<typeof fetch.preconnect>) => undefined,
		}
	);
	return bodies;
}

test("sends the opening locale when the caller names one", async () => {
	const bodies = recordBodies();
	const reply = await startProactiveOpening(target, "c1", "ryu", "key-1", "ja");
	expect(reply.status).toBe("completed");
	expect(bodies).toEqual([
		{
			agent_id: "ryu",
			conversation_id: "c1",
			idempotency_key: "key-1",
			locale: "ja",
		},
	]);
});

test("leaves the locale to Core when none is given", async () => {
	const bodies = recordBodies();
	await startProactiveOpening(target, "c1");
	expect(bodies[0]).not.toHaveProperty("locale");
});
