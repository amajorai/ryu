// packages/protocol/src/sse-client.test.ts
//
// Tests for the shared fetch-based SSE reader. openSse splits frames on the
// blank-line separator ("\n\n"), matches "event:" / "data:" prefixes (trimmed),
// skips comment/keepalive lines and payload-less frames, silently drops a frame
// with malformed JSON, and throws on a non-2xx connect. The load-bearing case is
// a payload split across two enqueued reader chunks: the buffer must stitch it.

import { afterEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import {
	type OpenSseOptions,
	openSse,
	readSse,
	SseConnectError,
	SseFrameDecoder,
	SseFrameTooLargeError,
} from "./sse-client.ts";

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
function mockFetch(resp: Response) {
	const calls: Parameters<typeof fetch>[] = [];
	globalThis.fetch = Object.assign(
		(...args: Parameters<typeof fetch>) => {
			calls.push(args);
			return Promise.resolve(resp);
		},
		{ preconnect: realFetch.preconnect }
	);
	return { calls };
}
async function collect(
	url: string,
	opts?: OpenSseOptions & { decode?: z.ZodType["parse"] }
) {
	const out = [];
	for await (const msg of openSse(url, opts)) {
		out.push(msg);
	}
	return out;
}

describe("openSse frame parsing", () => {
	test("yields one message per frame with default event name", async () => {
		mockFetch(streamResponse(['data: {"n":1}\n\n', 'data: {"n":2}\n\n']));
		const msgs = await collect("http://x/stream");
		expect(msgs).toEqual([
			{ event: "message", data: { n: 1 } },
			{ event: "message", data: { n: 2 } },
		]);
	});

	test("honors a named event: line", async () => {
		mockFetch(streamResponse(['event: redeem\ndata: {"ok":true}\n\n']));
		const msgs = await collect("http://x/stream");
		expect(msgs).toEqual([{ event: "redeem", data: { ok: true } }]);
	});

	test("stitches a payload split across two reader chunks", async () => {
		// The JSON body and the frame separator arrive in separate chunks.
		mockFetch(streamResponse(['data: {"half', '":true}\n\n']));
		const msgs = await collect("http://x/stream");
		expect(msgs).toEqual([{ event: "message", data: { half: true } }]);
	});

	test("accepts LF, CRLF, and CR delimiters split across chunks", async () => {
		mockFetch(
			streamResponse([
				'data: {"ending":"lf"}\n',
				"\n",
				'data: {"ending":"crlf"}\r',
				"\n\r",
				"\n",
				'data: {"ending":"cr"}\r',
				"\r",
			])
		);
		expect(await collect("http://x/stream")).toEqual([
			{ event: "message", data: { ending: "lf" } },
			{ event: "message", data: { ending: "crlf" } },
			{ event: "message", data: { ending: "cr" } },
		]);
	});

	test("joins multi-line data: fields with a newline before JSON.parse", async () => {
		mockFetch(streamResponse(["data: [1,\ndata: 2]\n\n"]));
		const msgs = await collect("http://x/stream");
		expect(msgs).toEqual([{ event: "message", data: [1, 2] }]);
	});

	test("skips keepalive comment lines and payload-less frames", async () => {
		mockFetch(
			streamResponse([": keepalive\n\n", "event: ping\n\n", "data: 7\n\n"])
		);
		const msgs = await collect("http://x/stream");
		expect(msgs).toEqual([{ event: "message", data: 7 }]);
	});

	test("silently drops a frame with malformed JSON and self-heals", async () => {
		mockFetch(streamResponse(["data: {bad\n\n", 'data: {"good":1}\n\n']));
		const msgs = await collect("http://x/stream");
		expect(msgs).toEqual([{ event: "message", data: { good: 1 } }]);
	});

	test("throws on a non-2xx connect with the status in the message", async () => {
		mockFetch(streamResponse([], { status: 503 }));
		await expect(collect("http://x/stream")).rejects.toThrow(
			"sse stream failed: 503"
		);
	});

	// The status is what lets a reconnect loop tell a restarting server (retry
	// soon) from a permanent refusal like a 409 (retry rarely, or not at all), so
	// it has to survive as DATA — matching on the message string does not scale.
	test("carries the HTTP status on the thrown SseConnectError", async () => {
		mockFetch(streamResponse([], { status: 409 }));
		const error = await collect("http://x/stream").catch((error) => {
			if (error instanceof SseConnectError) {
				return error;
			}
			throw error;
		});
		expect(error).toBeInstanceOf(SseConnectError);
		if (!(error instanceof SseConnectError)) {
			throw new Error("Expected a connection error");
		}
		expect(error.status).toBe(409);
	});
});

describe("bounded incremental framing", () => {
	test("accepts an event at the exact bound and rejects one byte beyond it", () => {
		const encoder = new TextEncoder();
		const exact = new SseFrameDecoder(8);
		expect(exact.push(encoder.encode("data: 1\n\n"))).toEqual(["data: 1"]);

		const oversized = new SseFrameDecoder(8);
		expect(() => oversized.push(encoder.encode("data: 12\n\n"))).toThrow(
			SseFrameTooLargeError
		);
	});

	test("cancels and releases the response reader after overflow", async () => {
		let cancelled = false;
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(
					new TextEncoder().encode(`data: ${"x".repeat(256 * 1024)}`)
				);
			},
			cancel() {
				cancelled = true;
			},
		});
		mockFetch(new Response(stream));
		await expect(collect("http://x/stream")).rejects.toBeInstanceOf(
			SseFrameTooLargeError
		);
		expect(cancelled).toBe(true);
	});

	test("dispatches a CRLF blank line split at every chunk boundary exactly once", () => {
		const encoder = new TextEncoder();
		const wire = 'data: {"n":1}\r\n\r\ndata: {"n":2}\r\n\r\n';
		for (let split = 1; split < wire.length; split++) {
			const decoder = new SseFrameDecoder();
			const frames = [
				...decoder.push(encoder.encode(wire.slice(0, split))),
				...decoder.push(encoder.encode(wire.slice(split))),
			];
			expect(frames).toEqual(['data: {"n":1}', 'data: {"n":2}']);
		}
	});

	test("counts a CRLF line ending once against the bound", () => {
		const encoder = new TextEncoder();
		expect(
			new SseFrameDecoder(8).push(encoder.encode("data: 1\r\n\r\n"))
		).toEqual(["data: 1"]);
		expect(() =>
			new SseFrameDecoder(8).push(encoder.encode("data: 12\r\n\r\n"))
		).toThrow(SseFrameTooLargeError);
	});

	test("rejects a terminated over-limit frame, cancels, and yields nothing after it", async () => {
		let cancelled = false;
		const encoder = new TextEncoder();
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode('data: {"n":1}\r\n\r\n'));
				controller.enqueue(
					encoder.encode(
						`data: "${"x".repeat(256 * 1024)}"\r\n\r\ndata: {"n":3}\r\n\r\n`
					)
				);
			},
			cancel() {
				cancelled = true;
			},
		});
		mockFetch(new Response(stream));
		const received: unknown[] = [];
		const consume = async () => {
			for await (const message of openSse("http://x/stream")) {
				received.push(message.data);
			}
		};
		await expect(consume()).rejects.toBeInstanceOf(SseFrameTooLargeError);
		expect(received).toEqual([{ n: 1 }]);
		expect(cancelled).toBe(true);
	});

	test("rejects data lines that never reach a blank line across many chunks", async () => {
		let cancelled = false;
		const encoder = new TextEncoder();
		const line = `data: ${"y".repeat(1000)}\n`;
		const stream = new ReadableStream<Uint8Array>({
			pull(controller) {
				controller.enqueue(encoder.encode(line));
			},
			cancel() {
				cancelled = true;
			},
		});
		mockFetch(new Response(stream));
		await expect(collect("http://x/stream")).rejects.toBeInstanceOf(
			SseFrameTooLargeError
		);
		expect(cancelled).toBe(true);
	});

	test("cancels the response when a consumer returns early", async () => {
		let cancelled = false;
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode('data: {"n":1}\n\n'));
			},
			cancel() {
				cancelled = true;
			},
		});
		mockFetch(new Response(stream));
		for await (const _message of openSse("http://x/stream")) {
			break;
		}
		expect(cancelled).toBe(true);
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
		const init = calls[0]?.[1];
		const headers = new Headers(init?.headers);
		expect(headers.get("Authorization")).toBe("Bearer tok");
		expect(headers.get("X-Custom")).toBe("1");
		expect(init?.credentials).toBe("include");
		expect(init?.method).toBe("GET");
	});

	test("omits Authorization when token is null", async () => {
		const { calls } = mockFetch(streamResponse([]));
		await collect("http://x/stream", { token: null });
		const init = calls[0]?.[1];
		expect(new Headers(init?.headers).has("Authorization")).toBe(false);
	});
});

describe("readSse callback wrapper", () => {
	test("invokes onMessage for each parsed frame", async () => {
		mockFetch(streamResponse(['data: "a"\n\n', 'data: "b"\n\n']));
		const seen: string[] = [];
		await readSse("http://x/stream", (m) => seen.push(m.data), {
			decode: z.string().parse,
		});
		expect(seen).toEqual(["a", "b"]);
	});
});

describe("endpoint-owned event decoding", () => {
	test("drops invalid domain frames and continues with complete decoded events", async () => {
		mockFetch(
			streamResponse([
				'data: {"n":"wrong"}\n\n',
				'data: {"n":2,"secret":"discard"}\n\n',
			])
		);
		const events = [];
		for await (const message of openSse("http://x/stream", {
			decode: z.object({ n: z.number() }).parse,
		})) {
			events.push(message);
		}
		expect(events).toEqual([{ event: "message", data: { n: 2 } }]);
	});
	test("retains native JSON transport values for an untyped stream", async () => {
		mockFetch(
			streamResponse([
				'data: {"__proto__":{"retained":true},"overflow":1e400}\n\n',
			])
		);
		const messages = await collect("http://x/stream");
		expect(messages).toEqual([
			{
				event: "message",
				data: JSON.parse('{"__proto__":{"retained":true},"overflow":1e400}'),
			},
		]);
	});
});
