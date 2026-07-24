// packages/protocol/src/sse-client.test.ts
//
// Tests for the shared fetch-based SSE reader. openSse splits frames on the
// blank-line separator ("\n\n"), matches "event:" / "data:" prefixes (trimmed),
// skips comment/keepalive lines and payload-less frames, silently drops a frame
// with malformed JSON, and throws on a non-2xx connect. The load-bearing case is
// a payload split across two enqueued reader chunks: the buffer must stitch it.

import { afterEach, describe, expect, test } from "bun:test";
import { openSse, readSse } from "./sse-client.ts";

const realFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = realFetch;
});

/** Build a streaming Response whose body enqueues `chunks` in order. */
function streamResponse(chunks: string[], init?: ResponseInit): Response {
	const encoder = new TextEncoder();
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) {
				controller.enqueue(encoder.encode(chunk));
			}
			controller.close();
		},
	});
	return new Response(stream, init);
}

/** Install a fetch that returns `resp` and records the call args. */
function mockFetch(resp: Response): { calls: [unknown, unknown][] } {
	const calls: [unknown, unknown][] = [];
	globalThis.fetch = ((input: unknown, options: unknown) => {
		calls.push([input, options]);
		return Promise.resolve(resp);
	}) as typeof fetch;
	return { calls };
}

async function collect<T>(url: string, opts?: Parameters<typeof openSse>[1]) {
	const out: { event: string; data: T }[] = [];
	for await (const msg of openSse<T>(url, opts)) {
		out.push(msg);
	}
	return out;
}

describe("openSse frame parsing", () => {
	test("yields one message per frame with default event name", async () => {
		mockFetch(streamResponse(['data: {"n":1}\n\n', 'data: {"n":2}\n\n']));
		const msgs = await collect<{ n: number }>("http://x/stream");
		expect(msgs).toEqual([
			{ event: "message", data: { n: 1 } },
			{ event: "message", data: { n: 2 } },
		]);
	});

	test("honors a named event: line", async () => {
		mockFetch(streamResponse(['event: redeem\ndata: {"ok":true}\n\n']));
		const msgs = await collect<{ ok: boolean }>("http://x/stream");
		expect(msgs).toEqual([{ event: "redeem", data: { ok: true } }]);
	});

	test("stitches a payload split across two reader chunks", async () => {
		// The JSON body and the frame separator arrive in separate chunks.
		mockFetch(streamResponse(['data: {"half', '":true}\n\n']));
		const msgs = await collect<{ half: boolean }>("http://x/stream");
		expect(msgs).toEqual([{ event: "message", data: { half: true } }]);
	});

	test("joins multi-line data: fields with a newline before JSON.parse", async () => {
		mockFetch(streamResponse(["data: [1,\ndata: 2]\n\n"]));
		const msgs = await collect<number[]>("http://x/stream");
		expect(msgs).toEqual([{ event: "message", data: [1, 2] }]);
	});

	test("skips keepalive comment lines and payload-less frames", async () => {
		mockFetch(
			streamResponse([": keepalive\n\n", "event: ping\n\n", "data: 7\n\n"])
		);
		const msgs = await collect<number>("http://x/stream");
		expect(msgs).toEqual([{ event: "message", data: 7 }]);
	});

	test("silently drops a frame with malformed JSON and self-heals", async () => {
		mockFetch(streamResponse(["data: {bad\n\n", 'data: {"good":1}\n\n']));
		const msgs = await collect<{ good: number }>("http://x/stream");
		expect(msgs).toEqual([{ event: "message", data: { good: 1 } }]);
	});

	test("throws on a non-2xx connect with the status in the message", async () => {
		mockFetch(streamResponse([], { status: 503 }));
		await expect(collect("http://x/stream")).rejects.toThrow(
			"sse stream failed: 503"
		);
	});
});

describe("openSse request construction", () => {
	test("attaches a bearer token and merges extra headers", async () => {
		const { calls } = mockFetch(streamResponse([]));
		await collect("http://x/stream", {
			token: "tok",
			headers: { "X-Custom": "1" },
			credentials: "include",
		});
		const init = calls[0]?.[1] as RequestInit;
		const headers = init.headers as Record<string, string>;
		expect(headers.Authorization).toBe("Bearer tok");
		expect(headers["X-Custom"]).toBe("1");
		expect(init.credentials).toBe("include");
		expect(init.method).toBe("GET");
	});

	test("omits Authorization when token is null", async () => {
		const { calls } = mockFetch(streamResponse([]));
		await collect("http://x/stream", { token: null });
		const init = calls[0]?.[1] as RequestInit;
		expect(
			(init.headers as Record<string, string>).Authorization
		).toBeUndefined();
	});
});

describe("readSse callback wrapper", () => {
	test("invokes onMessage for each parsed frame", async () => {
		mockFetch(streamResponse(['data: "a"\n\n', 'data: "b"\n\n']));
		const seen: string[] = [];
		await readSse<string>("http://x/stream", (m) => seen.push(m.data));
		expect(seen).toEqual(["a", "b"]);
	});
});
